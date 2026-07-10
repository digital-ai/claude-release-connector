# Keycloak setup for the Claude ↔ Digital.ai Release MCP connector

How to configure a Keycloak realm so Claude (Claude Code, claude.ai) can authenticate to the
Release MCP endpoint (`/s/mcp`) with OAuth 2.1 + PKCE, using Keycloak as the authorization server.

> Verified 2026-07-09 against a local Keycloak (realm `xl-platform`, `docker/oidc` in the
> `xl-release` repo) and Release running with `server-dev/conf/xl-release.conf` on the
> `sonic/claude-connector-poc` branch (RFC 9728 discovery, commit `e9db86f286`).

## How the flow works

```
Claude ──POST /s/mcp──────────────► Release: 401 + WWW-Authenticate: Bearer resource_metadata="…"
Claude ──GET /.well-known/oauth-protected-resource/s/mcp──► Release: {authorization_servers:[<issuer>]}
Claude ──GET <issuer>/.well-known/openid-configuration────► Keycloak: endpoints + PKCE support
Claude ──POST <issuer>/clients-registrations/openid-connect─► Keycloak: registers itself (DCR)   ← needs §1
Claude ──browser: authorization code + PKCE (S256)─────────► Keycloak: login + consent
Claude ──POST /s/mcp with Bearer <access token>────────────► Release: validates issuer + audience ← needs §2
```

Release-side prerequisites (no Keycloak involvement):
- Release runs with the **OIDC auth plugin** (`oidcAuth` profile) and `xl.security.auth.providers.oidc.issuer`
  pointing at the realm (e.g. `http://localhost:8080/realms/xl-platform`).
- `server.url` (in `xl-release-server.conf`) must be the URL clients actually use — the discovery
  metadata and token audience validation are derived from it. Host mismatch (e.g. server says
  `host.docker.internal`, client connects to `localhost`) breaks the flow.
- Note the configured **`clientId`** (e.g. `xl-release`): unless
  `xl.security.auth.providers.oidc.access-token.audience` overrides it, Release rejects any access
  token whose `aud` does not contain that value. §2 exists because of this.
- Release maps roles from the claim named by **`rolesClaim`** (e.g. `groups`) — it must be present
  in the **access token**, not just the ID token. Also §2.

## Background: what Dynamic Client Registration is, and why Claude uses it

Classic OAuth assumes every client application is registered with the authorization server ahead
of time by an administrator, who hands the developer a `client_id`. That model breaks for MCP:
an MCP client like Claude Code connects to servers it has never seen before, protected by
authorization servers its vendor has never talked to. Nobody at Anthropic can pre-register a
client in *your* Keycloak realm.

**Dynamic Client Registration (DCR, RFC 7591)** closes that gap: the authorization server exposes
a registration endpoint (Keycloak: `<issuer>/clients-registrations/openid-connect`, advertised as
`registration_endpoint` in the issuer's `.well-known/openid-configuration`), and the client
registers *itself* at connect time by POSTing its own metadata — display name, redirect URIs,
grant types. The server responds with a freshly minted `client_id`. Claude Code does this
**anonymously** (no pre-shared credential is possible, by definition) the first time you
authenticate against a new MCP server, then runs the normal authorization-code + PKCE flow as
that client. This is the MCP-spec-recommended default; it's what makes "paste a URL, click
Authenticate" work with zero IdP coordination.

Practical consequences to be aware of:

- **One client per Claude Code installation per MCP server.** Each developer machine registers its
  own client (UUID `client_id`, name `Claude Code (<server>)`). Expect them to accumulate in the
  realm — they're harmless, hold no secrets (public clients, PKCE-only), and can be deleted at any
  time; the client simply re-registers on next authenticate. Keycloak's *Max Clients Limit*
  anonymous policy (default 200) caps runaway growth.
- **Anonymous registration is why the policy gate exists.** An open registration endpoint lets
  anyone create clients in your realm, so Keycloak wraps it in the *Anonymous access policies*
  (Trusted Hosts, Consent Required, Allowed Client Scopes, Max Clients, …). §1 below tunes the one
  that blocks Claude Code by default rather than disabling the protection wholesale — registration
  stays limited to clients whose redirect URIs point at hosts you trust.
- **Consent is forced.** Keycloak marks anonymously registered clients `consentRequired=true`, so
  the end user always sees and approves what the client gets — a sensible safeguard that also
  explains the extra consent screen on first login.
- **DCR clients can't carry pre-configured mappers** — they don't exist until the moment of
  registration. That's why the audience/groups mappers in §2 go in a *realm default client scope*
  instead of on a client.
- **Alternatives when DCR is unacceptable** (e.g. an IdP team that won't open anonymous
  registration): a **pre-registered client** (§3) — claude.ai's connector dialog accepts a client
  ID/secret, though Claude Code's flow relies on DCR; or **CIMD** (Client ID Metadata Documents),
  the emerging successor where the client identifies itself by a self-hosted HTTPS metadata URL and
  no registration call happens at all — Keycloak support is not there yet, worth rechecking later.

## 1. Allow Dynamic Client Registration (needed for Claude Code)

Claude Code registers itself as a new OAuth client at authenticate time (anonymous DCR, RFC 7591 —
see the background section above).
Keycloak gates this with the anonymous **Trusted Hosts** policy — the default configuration rejects
with `Policy 'Trusted Hosts' rejected request to client-registration service. Details: Host not trusted.`

Admin console → realm → **Clients → Client registration → Anonymous access policies → Trusted Hosts**:

| Setting | Value | Why |
|---|---|---|
| Host Sending Client Registration Request Must Match | **Off** | Tries to reverse-DNS the caller's IP; never works for laptops/NAT |
| Client URIs Must Match | **On** (keep) | Registration is still restricted to clients whose redirect URIs point at trusted hosts |
| Trusted Hosts | `localhost`, `127.0.0.1` (+ `claude.ai` for claude.ai connectors) | Claude Code's redirect URI is `http://localhost:<random port>/callback` |

What a DCR-registered client looks like afterwards (one per Claude Code installation — this is
normal): client ID is a generated UUID, display name `Claude Code (<mcp server name>)`, public
client, standard flow only, redirect URI `http://localhost:<port>/callback`, consent required
(users see a consent screen on first login — expected for anonymously registered clients).

## 2. Audience + groups for DCR clients (realm default client scope)

DCR clients are created on the fly, so per-client mappers can't be pre-configured. Put the two
mappers Release needs in a **client scope** and make it a **realm default** — every newly
registered client inherits it automatically.

Admin console → realm → **Client scopes → Create client scope**:
- Name `release-mcp`, protocol OpenID Connect, type **Default**, "Include in token scope" off,
  "Display on consent screen" off.
- **Mappers → Add mapper (by configuration)**:
    1. **Audience** — name `release-audience`, Included Custom Audience = `xl-release`
       (= Release's configured OIDC `clientId`, or the `access-token.audience` override if set),
       Add to access token: on.
    2. **Group Membership** — name `groups`, Token Claim Name `groups` (= Release's `rolesClaim`),
       Full group path: off, Add to access token: on.
- Then realm → **Client scopes** → ensure `release-mcp`'s *Assigned type* is **Default** (this is
  what applies it to newly created clients realm-wide).

Equivalent via the admin REST API:

```bash
KC=http://localhost:8080
TOKEN=$(curl -s -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" | jq -r .access_token)

# create the scope with both mappers
curl -s -X POST "$KC/admin/realms/xl-platform/client-scopes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "name": "release-mcp",
  "description": "Audience + groups for MCP clients (Claude) calling Digital.ai Release",
  "protocol": "openid-connect",
  "attributes": {"include.in.token.scope": "false", "display.on.consent.screen": "false"},
  "protocolMappers": [
    {"name": "release-audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
     "config": {"included.custom.audience": "xl-release", "access.token.claim": "true", "id.token.claim": "false"}},
    {"name": "groups", "protocol": "openid-connect", "protocolMapper": "oidc-group-membership-mapper",
     "config": {"claim.name": "groups", "full.path": "false", "access.token.claim": "true",
                "id.token.claim": "true", "userinfo.token.claim": "true"}}
  ]}'

# make it a realm default so DCR clients inherit it
SCOPE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/xl-platform/client-scopes" \
  | jq -r '.[] | select(.name=="release-mcp") | .id')
curl -s -X PUT "$KC/admin/realms/xl-platform/default-default-client-scopes/$SCOPE_ID" \
  -H "Authorization: Bearer $TOKEN"
```

> ⚠️ **Side effect:** a realm-default scope applies to *every* client in the realm — all tokens
> gain the `groups` claim and the extra `xl-release` audience. Fine for a dev realm. For
> production, scope it tighter: e.g. keep the scope non-default and attach it via the anonymous
> registration policy "Allowed Client Scopes", or attach it manually to known Claude clients.

### Keep Release's advertised scopes in sync

Release (26.1.5+, with the OAuth discovery feature) advertises which scopes MCP clients should
request via `scopes_supported` in its RFC 9728 metadata — configured by
`xl.features.mcp.server.oauth.scopes-supported` (default `["profile", "email", "release-mcp"]`,
matching this guide's convention). Spec-conforming clients request exactly these scopes when
registering with the IdP. This matters twice with Keycloak: the anonymous **Allowed Client
Scopes** policy rejects registrations requesting scopes outside the realm defaults, and Keycloak
DCR **replaces** a new client's realm-default scopes with the explicitly requested list — so the
audience-carrying scope (`release-mcp`) must be in the advertised list or tokens arrive without
Release's required audience. If you name the client scope differently, update the Release config
to match.

## 3. Pre-registered client (for claude.ai custom connectors)

claude.ai's custom-connector dialog can use a client you register manually (enter its client ID /
secret under advanced settings) instead of DCR. Create a client, e.g. `claude-connector`:

- OpenID Connect, **Standard flow** only; **public** client (Claude uses PKCE) — or confidential
  if you prefer supplying a secret to claude.ai.
- Valid redirect URIs: `https://claude.ai/api/mcp/auth_callback` (claude.ai/desktop/mobile),
  `http://localhost:*` and `http://127.0.0.1:*` (Claude Code loopback).
- Advanced → PKCE Code Challenge Method: `S256`.
- Assign the `release-mcp` client scope (automatic if it's a realm default per §2).

Note: claude.ai must be able to reach both Release and the Keycloak issuer over public HTTPS —
a localhost setup only works with Claude Code.

## 4. Verify

```bash
# 1. Release advertises discovery (OIDC installs only):
curl -s http://localhost:5516/.well-known/oauth-protected-resource/s/mcp | jq
# 2. 401 carries the discovery hint:
curl -si -X POST http://localhost:5516/s/mcp | grep -i www-authenticate
#    → Bearer resource_metadata="…"  +  Basic realm="XLRelease"
# 3. PAT/Basic still work (non-breaking):
curl -si -X POST -u admin:admin -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  http://localhost:5516/s/mcp | head -5
# 4. Full OAuth flow with Claude Code:
claude mcp add --transport http release http://localhost:5516/s/mcp
claude    # then: /mcp → release → Authenticate → browser → Keycloak login + consent
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Policy 'Trusted Hosts' rejected request… Host not trusted` during Authenticate | §1 — disable "Host Sending Client Registration Request Must Match", add `localhost`/`127.0.0.1` to Trusted Hosts |
| Browser flow succeeds but tool calls return 401 | Token `aud` doesn't contain Release's expected audience — §2 audience mapper, or `access-token.audience` mismatch. Decode the access token (jwt.io) and check `aud` |
| Authenticated but "permission denied" on tools | `groups` claim missing from the *access* token (§2 groups mapper), or the Keycloak groups don't map to Release roles |
| No browser opens in Claude Code | OAuth is triggered from `/mcp` → server → Authenticate, not from a chat message. Also check host consistency: connect with the same hostname as `server.url` |
| Discovery metadata 404s | Release runs default auth (no OIDC plugin/profile), MCP server feature disabled, or no `issuer` configured |
| Unknown UUID clients named `Claude Code (<server>)` appear in the realm | Expected — one DCR client per Claude Code installation (§1) |
| Bare `mcp-remote` fails DCR with "URL doesn't match any trusted host or trusted domain" even after §1 | `mcp-remote` registers by default with `client_uri: https://github.com/geelen/mcp-remote`, which the "Client URIs Must Match" policy checks against Trusted Hosts. **The Digital.ai Release MCPB extension (≥0.2.1) is not affected** — it overrides `client_uri` to `http://127.0.0.1` via `--static-oauth-client-metadata`, which passes wherever the loopback redirect URIs pass. For hand-rolled `mcp-remote` configs, pass the same flag, add `github.com` to Trusted Hosts, or turn off "Client URIs Must Match" |
