# Keycloak setup for the Claude ↔ Digital.ai Release MCP connector

How to configure a Keycloak realm so Claude (Claude Code, claude.ai, the Desktop extension) can
authenticate to the Release MCP endpoint (`/s/mcp`) with OAuth 2.1 + PKCE, using Keycloak as the
authorization server.

> **CIMD sections verified 2026-07-13** against Keycloak **26.6.4** (realm `xl-platform`), by
> driving a complete authorization-code + PKCE flow with a URL-based `client_id`: authorize →
> login → consent → code → token, ending in an access token carrying `aud: ["xl-release"]` and
> `groups: ["release-admins"]`. DCR sections verified 2026-07-09 against the same realm.

There are two ways an MCP client can obtain a `client_id` in your realm. Pick one:

| | **[CIMD](#option-a--cimd-recommended)** (recommended) | **[DCR](#option-b--dcr-fallback)** (fallback) |
|---|---|---|
| Client records created | **One per client application, forever** | **One per install, accumulating** |
| Keycloak version | 26.6+ (experimental feature flag) | Any |
| Registration endpoint exposed | No | Yes (anonymous) |
| Setup | Client profile + policy | Trusted-hosts policy |

If your Keycloak is 26.6 or newer, use CIMD — it is the reason this document was rewritten. It is
what stops a fresh OAuth client from appearing in your realm every time a developer installs
Claude.

## How the flow works

```
Claude ──POST /s/mcp──────────────► Release: 401 + WWW-Authenticate: Bearer resource_metadata="…"
Claude ──GET /.well-known/oauth-protected-resource/s/mcp──► Release: {authorization_servers:[<issuer>]}
Claude ──GET <issuer>/.well-known/openid-configuration────► Keycloak: endpoints, PKCE, CIMD support
                                        ┌─ CIMD: client_id = an https URL Claude hosts   ← Option A
Claude ──── obtains a client_id ────────┤
                                        └─ DCR: POST /clients-registrations/openid-connect ← Option B
Claude ──browser: authorization code + PKCE (S256)─────────► Keycloak: login + consent
Claude ──POST /s/mcp with Bearer <access token>────────────► Release: validates issuer + audience
```

Release-side prerequisites (no Keycloak involvement, and **no Release code changes** — the RFC 9728
discovery Release already ships is what drives all of this):

- Release runs with the **OIDC auth plugin** (`oidcAuth` profile) and `xl.security.auth.providers.oidc.issuer`
  pointing at the realm (e.g. `http://localhost:8080/realms/xl-platform`).
- `server.url` (in `xl-release-server.conf`) must be the URL clients actually use — the discovery
  metadata and token audience validation are derived from it. Host mismatch (e.g. server says
  `host.docker.internal`, client connects to `localhost`) breaks the flow.
- Note the configured **`clientId`** (e.g. `xl-release`): unless
  `xl.security.auth.providers.oidc.access-token.audience` overrides it, Release rejects any access
  token whose `aud` does not contain that value. The client scope below exists because of this.
- Release maps roles from the claim named by **`rolesClaim`** (e.g. `groups`) — it must be present
  in the **access token**, not just the ID token. Same client scope.

## Background: how an MCP client gets a `client_id`

Classic OAuth assumes every client application is registered with the authorization server ahead
of time by an administrator, who hands the developer a `client_id`. That model breaks for MCP: a
client like Claude Code connects to servers it has never seen before, protected by authorization
servers its vendor has never talked to. Nobody at Anthropic can pre-register a client in *your*
Keycloak realm.

**Dynamic Client Registration (DCR, RFC 7591)** was the original answer: the client registers
*itself* at connect time by POSTing its metadata to an anonymous registration endpoint, and gets a
freshly minted `client_id` back. It works, but it means **one new client record per installation**
— every developer laptop mints its own UUID client, and they pile up in the realm forever.

**Client ID Metadata Documents (CIMD, [SEP-991](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) /
[draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/))**
is the successor, and the preferred method in the MCP 2025-11-25 spec. The `client_id` simply *is*
an HTTPS URL that serves the client's metadata as JSON. Keycloak fetches that URL, reads the
client's name and redirect URIs from it, and proceeds — **no registration call, and no per-install
client**. Because the URL is the identity, every install of the same application shares one client
record. Keycloak persists exactly one, keyed by the URL.

Claude publishes two such documents, and the Digital.ai Release MCPB extension publishes its own —
because the extension is a stdio bridge, it is the OAuth client, not Claude:

| Client | CIMD URL |
|---|---|
| Claude Code CLI | `https://claude.ai/oauth/claude-code-client-metadata` |
| Claude web / Desktop / mobile / Cowork | `https://claude.ai/oauth/mcp-oauth-client-metadata` |
| Digital.ai Release MCPB extension | `https://raw.githubusercontent.com/digital-ai/claude-release-connector/main/mcpb/claude-release-mcp-extension/oauth/client-metadata.json` |

Whichever of these authenticates, your realm ends up with **one** client record for it — shared by
every user and every install.

---

# Option A — CIMD (recommended)

## A.1 Requirements

- **Keycloak 26.6 or newer.** CIMD is an *experimental* feature; Keycloak warns it may introduce
  breaking changes in future versions.
- Start Keycloak with the `cimd` feature enabled:

```yaml
# docker-compose.yml
services:
  keycloak:
    image: quay.io/keycloak/keycloak:latest   # 26.6.4 at time of writing
    command:
      - start-dev
      - --import-realm
      - --features=cimd
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin      # NOT KEYCLOAK_ADMIN — renamed in Keycloak 26
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
    ports:
      - 8080:8080
```

Confirm on startup:

```
WARN [org.keycloak.common.Profile] Experimental features enabled: cimd:v1
```

The feature flag alone makes Keycloak *advertise* CIMD, but it will still reject URL-based
`client_id`s until you add the client profile and policy in A.2.

## A.2 Add the client profile and policy

CIMD is wired through Keycloak's client-policy framework, in two halves:

- a **profile** holding a `client-id-metadata-document` executor — this fetches and validates the
  metadata document;
- a **policy** with a `client-id-uri` condition — this triggers the profile whenever an
  authorization request arrives with a `client_id` that is a URL.

**Admin console:** Realm settings → *Client policies* → *Profiles* → **Create client profile**,
add the `client-id-metadata-document` executor; then the *Policies* tab → **Create client policy**,
add the `client-id-uri` condition and attach the profile.

**Or via the admin REST API** (this is the exact configuration that was verified):

```bash
KC=http://localhost:8080
REALM=xl-platform
TOKEN=$(curl -s -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" | jq -r .access_token)

# Every host appearing ANYWHERE in a client's metadata document must be listed here — see the
# warning below.
#   claude.ai                 — Claude's own documents (Code / Desktop / web) and its web redirect URI
#   localhost, 127.0.0.1      — loopback redirect URIs used by Claude Code and the MCPB extension
#   raw.githubusercontent.com — where the Digital.ai Release MCPB extension publishes ITS document
DOMAINS='["claude.ai","localhost","127.0.0.1","raw.githubusercontent.com"]'

# 1. Profile — fetches + validates the Client ID Metadata Document
curl -s -X PUT "$KC/admin/realms/$REALM/client-policies/profiles" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "profiles": [{
    "name": "cimd-profile",
    "description": "Accept OAuth Client ID Metadata Documents (SEP-991) from MCP clients",
    "executors": [{
      "executor": "client-id-metadata-document",
      "configuration": {
        "cimd-allow-http-scheme": false,
        "cimd-allow-permitted-domains": '"$DOMAINS"',
        "cimd-restrict-same-domain": false,
        "only-allow-confidential-client": false
      }
    }]
  }]}'

# 2. Policy — triggers that profile when client_id is a URL
curl -s -X PUT "$KC/admin/realms/$REALM/client-policies/policies" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "policies": [{
    "name": "cimd-policy",
    "description": "Route URL-based client_id (CIMD) requests to cimd-profile",
    "enabled": true,
    "conditions": [{
      "condition": "client-id-uri",
      "configuration": {
        "client-id-uri-scheme": ["https"],
        "client-id-uri-allow-permitted-domains": '"$DOMAINS"'
      }
    }],
    "profiles": ["cimd-profile"]
  }]}'
```

Executor options worth knowing:

| Option | Set to | Why |
|---|---|---|
| `only-allow-confidential-client` | `false` | Claude is a **public** client using PKCE, with no secret. Leaving this `true` rejects it. |
| `cimd-allow-permitted-domains` | see warning | Domains allowed to appear in the metadata document. |
| `cimd-allow-http-scheme` | `false` | `true` only for local experiments. Production documents are HTTPS. |
| `cimd-restrict-same-domain` | `false` | `true` forces every URL in the document onto one domain. |

> ⚠️ **The permitted-domains list covers every URL in the document, not just the `client_id` host.**
> This is the single most confusing part of the setup. Keycloak validates the `client_id` URL, the
> `redirect_uris`, **and** metadata fields like `client_uri` — each against the same list. A
> document whose `client_id` is on `claude.ai` but whose `redirect_uris` point at `localhost` needs
> **both** listed, or Keycloak fails the request with `Invalid Client ID: domain not allowed` while
> the server log names the offending host:
>
> ```
> WARN [...ClientIdMetadataDocumentExecutor] not trusted domain: host = localhost
> ```
>
> When in doubt, read that log line — it tells you exactly which host to add.

## A.3 Client scope for audience + groups

Release rejects any access token whose `aud` does not contain its configured `clientId`, and maps
roles from the `groups` claim. Neither is present by default, so both come from a client scope.

**How a CIMD client gets this scope:** Keycloak reads the `scope` field from the metadata document
and attaches those scopes to the client as **optional** scopes. The client then requests them at
authorization time, and the mappers fire. So the scope must (a) exist in the realm, and (b) be
named in the client's metadata document — see [the naming constraint](#scope-naming-is-a-contract)
below.

Create the scope — name it **`release-mcp`**, matching Release's default `scopes-supported`:

Admin console → **Client scopes → Create client scope**: name `release-mcp`, protocol OpenID
Connect, type **None**, "Include in token scope" **on**. (Type *None* is correct and deliberate —
the scope needs no realm-wide assignment; Keycloak attaches it to the CIMD client on its own,
because the metadata document names it.) Then **Mappers → Add mapper (by configuration)**:

1. **Audience** — name `release-audience`, Included Custom Audience = `xl-release` (Release's OIDC
   `clientId`, or the `access-token.audience` override if set), *Add to access token*: on.
2. **Group Membership** — name `groups`, Token Claim Name `groups` (= Release's `rolesClaim`),
   *Full group path*: off, *Add to access token*: on.

Or via REST:

```bash
curl -s -X POST "$KC/admin/realms/$REALM/client-scopes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "name": "release-mcp",
  "description": "Audience + groups for MCP clients (Claude) calling Digital.ai Release",
  "protocol": "openid-connect",
  "attributes": {"include.in.token.scope": "true", "display.on.consent.screen": "false"},
  "protocolMappers": [
    {"name":"release-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper",
     "config":{"included.custom.audience":"xl-release","access.token.claim":"true","id.token.claim":"false"}},
    {"name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper",
     "config":{"claim.name":"groups","full.path":"false","access.token.claim":"true",
               "id.token.claim":"true","userinfo.token.claim":"true"}}
  ]}'
```

Unlike the DCR setup, this scope does **not** need to be a realm default — which is a real
improvement, because a realm-default scope leaks the `groups` claim and the `xl-release` audience
into *every* token in the realm.

### Scope naming is a contract

A CIMD document is published by the client vendor and is the *same URL for every customer*, so it
declares a fixed scope list. Keycloak only attaches scopes it can resolve by name. That makes the
scope name a contract between three places, which must agree:

1. the client's metadata document (`"scope": "openid profile email release-mcp"`),
2. this Keycloak client scope (`release-mcp`),
3. Release's `xl.features.mcp.server.oauth.scopes-supported` (default `["profile","email","release-mcp"]`).

**Keep the name `release-mcp`.** If you rename the scope in Keycloak, the audience mapper never
reaches the token and every tool call fails with a 401.

## A.4 Verify

```bash
# 1. Keycloak advertises CIMD:
curl -s $KC/realms/$REALM/.well-known/openid-configuration \
  | jq '.client_id_metadata_document_supported'      # -> true

# 2. Release advertises discovery (OIDC installs only):
curl -s http://localhost:5516/.well-known/oauth-protected-resource/s/mcp | jq

# 3. 401 carries the discovery hint:
curl -si -X POST http://localhost:5516/s/mcp | grep -i www-authenticate
#    → Bearer resource_metadata="…"  +  Basic realm="XLRelease"

# 4. Full OAuth flow with Claude Code:
claude mcp add --transport http release https://release.example.com/s/mcp
claude    # then: /mcp → release → Authenticate → browser → Keycloak login + consent
```

After a successful login, check the realm: **Clients** should contain exactly **one** entry whose
client ID is the metadata URL (e.g. `https://claude.ai/oauth/claude-code-client-metadata`), public,
consent-required, named from the document. A second developer authenticating produces **no new
client** — that is the whole point. Decoding the access token (jwt.io) should show
`aud: ["xl-release"]` and your `groups`.

## A.5 Things to know about the CIMD client record

- **It is derived state — never hand-edit it.** Keycloak recreates the client from the document,
  and it was observed to *delete* the record when the policy stopped matching. Any scope or mapper
  you attach manually will eventually be wiped. Everything must come from the document plus the
  named client scope.
- **Consent is still forced** (`consentRequired: true`), exactly as with DCR. Users see an approval
  screen on first login.
- **Random loopback ports work.** Claude Code's document declares `http://localhost/callback` with
  no port and then listens on an OS-assigned one. Keycloak honours RFC 8252 §7.3 and accepts any
  port — verified with `:54321` and `:61264`.
- **Resource Indicators (RFC 8707) are not supported** by Keycloak's CIMD implementation yet, even
  though Claude sends the `resource` parameter. The audience is carried by the `release-mcp` scope
  instead, which is what A.3 sets up.

## A.6 Known gap: Keycloak does not advertise `"none"`

Keycloak's `.well-known/openid-configuration` does **not** list `none` in
`token_endpoint_auth_methods_supported`, even with `cimd` enabled and the policy active:

```json
"token_endpoint_auth_methods_supported": [
  "private_key_jwt","client_secret_basic","client_secret_post","tls_client_auth","client_secret_jwt"
]
```

CIMD itself works fine regardless — the client is created as public/PKCE and the full flow
completes, which is why the **Digital.ai Release MCPB extension uses CIMD against Keycloak today**
(the MCP SDK gates only on `client_id_metadata_document_supported`).

**Native Claude does not.** Anthropic's
[connector authentication docs](https://claude.com/docs/connectors/building/authentication) state it
plainly:

> Claude selects CIMD only when your authorization server metadata advertises **both**
> `"client_id_metadata_document_supported": true` **and** `"none"` in
> `token_endpoint_auth_methods_supported` — the second is required because Claude's CIMD client
> authenticates as a public client at your token endpoint. If either is missing, Claude falls back
> to DCR.

**Practical consequence:** a user who points Claude Code or a Claude Desktop custom connector
straight at a public Release URL — bypassing the extension — will still get one registered client
per install, even with everything in this section configured correctly. The fix belongs in Keycloak,
not in Release or the connector. Until Keycloak advertises `"none"`:

- prefer the **MCPB extension**, which gets CIMD regardless; and
- keep the DCR fallback (Option B) configured so direct connections keep working.

---

# Option B — DCR (fallback)

Use this when your Keycloak predates 26.6, or when enabling an experimental feature is not
acceptable. Expect **one client record per Claude installation**; they are harmless (public,
PKCE-only, no secrets) and can be deleted at any time — the client re-registers on next
authenticate. Keycloak's *Max Clients Limit* anonymous policy (default 200) caps runaway growth.

## B.1 Allow Dynamic Client Registration

Keycloak gates anonymous registration with the **Trusted Hosts** policy; the default configuration
rejects Claude with `Policy 'Trusted Hosts' rejected request to client-registration service.
Details: Host not trusted.`

Admin console → realm → **Clients → Client registration → Anonymous access policies → Trusted Hosts**:

| Setting | Value | Why |
|---|---|---|
| Host Sending Client Registration Request Must Match | **Off** | Tries to reverse-DNS the caller's IP; never works for laptops/NAT |
| Client URIs Must Match | **On** (keep) | Registration stays restricted to clients whose redirect URIs point at trusted hosts |
| Trusted Hosts | `localhost`, `127.0.0.1` (+ `claude.ai` for claude.ai connectors) | Claude Code's redirect URI is `http://localhost:<random port>/callback` |

## B.2 Audience + groups for DCR clients (realm default client scope)

DCR clients are created on the fly, so per-client mappers can't be pre-configured. Create the
`release-mcp` scope exactly as in [A.3](#a3-client-scope-for-audience--groups), but additionally
make it a **realm default** so every newly registered client inherits it:

```bash
SCOPE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM/client-scopes" \
  | jq -r '.[] | select(.name=="release-mcp") | .id')
curl -s -X PUT "$KC/admin/realms/$REALM/default-default-client-scopes/$SCOPE_ID" \
  -H "Authorization: Bearer $TOKEN"
```

> ⚠️ **Side effect:** a realm-default scope applies to *every* client in the realm — all tokens gain
> the `groups` claim and the extra `xl-release` audience. Fine for a dev realm. For production,
> scope it tighter: keep it non-default and attach it via the anonymous registration policy
> "Allowed Client Scopes". **CIMD avoids this problem entirely** (A.3).

Note that Keycloak DCR **replaces** a new client's realm-default scopes with the explicitly
requested list, so the audience-carrying scope must appear in Release's advertised
`scopes-supported` or tokens arrive without the required audience.

---

# Option C — Pre-registered client (claude.ai custom connectors)

claude.ai's custom-connector dialog can use a client you register manually (enter its client ID /
secret under advanced settings) instead of DCR or CIMD. Create a client, e.g. `claude-connector`:

- OpenID Connect, **Standard flow** only; **public** client (Claude uses PKCE) — or confidential if
  you prefer supplying a secret to claude.ai.
- Valid redirect URIs: `https://claude.ai/api/mcp/auth_callback` (claude.ai/desktop/mobile),
  `http://localhost:*` and `http://127.0.0.1:*` (Claude Code loopback).
- Advanced → PKCE Code Challenge Method: `S256`.
- Assign the `release-mcp` client scope.

Note: claude.ai must reach both Release and the Keycloak issuer over public HTTPS — a localhost
setup only works with Claude Code or the Desktop extension.

---

## Keep Release's advertised scopes in sync

Release (26.1.5+) advertises which scopes MCP clients should request via `scopes_supported` in its
RFC 9728 metadata, configured by `xl.features.mcp.server.oauth.scopes-supported` (default
`["profile", "email", "release-mcp"]`). Spec-conforming clients request exactly these. This is what
causes the `release-mcp` scope — and therefore the `xl-release` audience — to end up in the access
token, under **both** CIMD and DCR. If you name the client scope differently, update the Release
config to match (and, for CIMD, the client's metadata document too — see
[Scope naming is a contract](#scope-naming-is-a-contract)).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid Client ID: domain not allowed` (HTTP 400 at the authorize endpoint) | A host in the metadata document is not in `cimd-allow-permitted-domains`. The server log names it: `not trusted domain: host = …`. Remember this covers `redirect_uris` and `client_uri`, not just the `client_id` host (A.2) |
| `client_not_found`, with a URL `client_id` in the log | The `client-id-uri` policy condition didn't match, so the CIMD executor never ran — check `client-id-uri-scheme` (an `http` document needs `http` listed) and the permitted domains on the **condition** as well as the executor |
| CIMD configured, but new clients still appear per install | The client fell back to DCR. Most likely the `"none"` advertisement gap (A.6). Confirm with `jq .client_id_metadata_document_supported` on the discovery doc |
| Browser flow succeeds but tool calls return 401 | Token `aud` doesn't contain Release's expected audience — check the `release-mcp` scope is attached and *requested* (A.3), or `access-token.audience` mismatch. Decode the access token (jwt.io) and check `aud` |
| Authenticated but "permission denied" on tools | `groups` claim missing from the *access* token (A.3 groups mapper), or the Keycloak groups don't map to Release roles |
| Discovery metadata 404s | Release runs default auth (no OIDC plugin/profile), MCP server feature disabled, or no `issuer` configured |
| No browser opens in Claude Code | OAuth is triggered from `/mcp` → server → Authenticate, not from a chat message. Also check host consistency: connect with the same hostname as `server.url` |
| Client policy/profile vanished after `docker compose down` | `start-dev` keeps it in the container's H2 only. Re-apply A.2 (script it) |
| Unknown UUID clients named `Claude Code (<server>)` in the realm | DCR, not CIMD — expected under Option B; one per installation |
| `Policy 'Trusted Hosts' rejected request… Host not trusted` during Authenticate | Option B only — see B.1 |
| Bare `mcp-remote` fails DCR with "URL doesn't match any trusted host or trusted domain" | `mcp-remote` registers with `client_uri: https://github.com/geelen/mcp-remote`, which "Client URIs Must Match" checks against Trusted Hosts. The Digital.ai Release MCPB extension (≥0.2.1) overrides `client_uri` to `http://127.0.0.1` via `--static-oauth-client-metadata`. For hand-rolled configs, pass the same flag, add `github.com` to Trusted Hosts, or turn off "Client URIs Must Match" |
