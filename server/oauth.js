/*
 * OAuth for the Digital.ai Release bridge — Client ID Metadata Document (CIMD) first.
 *
 * Instead of registering a brand-new OAuth client in the customer's IdP on every install
 * (Dynamic Client Registration, RFC 7591 — which is what mcp-remote does, and which leaves a
 * client record per developer laptop piling up in the realm forever), this identifies the
 * extension by a single stable HTTPS URL that serves its metadata: CIMD / SEP-991.
 *
 * The MCP SDK picks CIMD over DCR only when BOTH hold:
 *   - the authorization server advertises `client_id_metadata_document_supported: true`
 *   - the provider exposes `clientMetadataUrl` (an HTTPS URL with a non-root path)
 * Otherwise it silently falls back to DCR, so older IdPs keep working untouched.
 *
 * `clientMetadata` below is the DCR fallback payload; it must stay in sync with the published
 * document at CIMD_URL (oauth/client-metadata.json).
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The extension's published Client ID Metadata Document (CIMD / SEP-991). It identifies the
// *extension* — the same software on every customer's machine — so one URL serves everyone; it says
// nothing about any particular Release server or IdP. The document it serves MUST carry a
// `client_id` field exactly equal to this URL, and MUST also contain `client_name` and
// `redirect_uris` (see DOCUMENT below, which is what is published).
//
// Overridable (manifest user_config -> RELEASE_CIMD_URL) for one reason: the customer's
// authorization server fetches this URL *itself*, server-side. An IdP on an air-gapped network
// cannot reach the public internet, and fails the login with "Client Metadata fetch failed" — such
// customers must serve a copy of the document from a host their IdP can reach, with its `client_id`
// rewritten to that URL.
//
// TODO(before release): this is a personal gist standing in for a real home. The URL IS the client
// identity, so it must never change once customers have configured their IdPs — publish the
// document at a permanent Digital.ai-owned HTTPS URL and point this at it.
export const DEFAULT_CIMD_URL =
  "https://gist.githubusercontent.com/mayur9991/67cddfb237a82229e26fa5630216b5e4/raw/client-metadata.json";

/**
 * The document served at DEFAULT_CIMD_URL, kept here as the reviewable source of truth — it is
 * security-relevant (it declares the redirect URIs an IdP will honour), so it should not live only
 * on a web host. Publish this verbatim, with `client_id` set to the URL it is served from.
 *
 * `scope` matters: Keycloak attaches these to the CIMD client as *optional* scopes, which are only
 * applied when the client requests them — and the client learns what to request from Release's
 * RFC 9728 `scopes_supported`. Drop `release-mcp` here and the audience mapper never fires, so
 * Release rejects every token.
 */
const DOCUMENT = {
  client_id: DEFAULT_CIMD_URL,
  client_name: "Digital.ai Release (Claude Desktop extension)",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: "openid profile email release-mcp",
};

/**
 * The MCP SDK requires an https URL with a non-root path and throws InvalidClientMetadataError
 * otherwise. Check it here so a typo in the setting produces a clear message instead of a stack
 * trace from deep inside the SDK.
 */
export function validateCimdUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `'Client ID Metadata Document URL' is not a valid URL: ${value}`;
  }
  if (url.protocol !== "https:") {
    return `'Client ID Metadata Document URL' must use https, got ${url.protocol}//… : ${value}`;
  }
  if (url.pathname === "/" || url.pathname === "") {
    return `'Client ID Metadata Document URL' must have a path, not just a host: ${value}`;
  }
  return null;
}

// The DCR fallback payload, used only when the IdP cannot do CIMD. Derived from DOCUMENT so the two
// identities cannot drift apart — `client_id` is dropped (the IdP mints one during registration)
// and `scope` is dropped (the SDK passes the scopes it resolved from Release's RFC 9728 metadata).
//
// `client_uri` is deliberately 127.0.0.1 rather than digital.ai: Keycloak's trusted-hosts
// registration policy validates it, and loopback passes wherever the redirect URIs already pass.
const { client_id: _unused, scope: _alsoUnused, ...CLIENT_METADATA } = {
  ...DOCUMENT,
  client_uri: "http://127.0.0.1",
};

const log = (msg) => console.error("Digital.ai Release extension: " + msg);

function openBrowser(url) {
  // No browser to open on a headless host (and nothing to click in an automated test) — the URL is
  // always logged, so the sign-in can be completed by hand.
  if (process.env.RELEASE_OAUTH_NO_BROWSER) return;

  if (process.platform === "win32") {
    // `start` is a cmd.exe builtin, and cmd re-parses the command line it is handed: `&` separates
    // commands there, and an authorization URL is full of them (`?response_type=code&client_id=…`).
    // Passed naively the URL is truncated at the first `&` and the remainder is run as commands.
    // Hand cmd a verbatim line with the URL quoted, so it survives intact. The empty "" is start's
    // window-title argument — without it, start would treat the quoted URL as the title.
    spawn("cmd.exe", ["/c", "start", '""', `"${url}"`],
      { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return;
  }

  // No shell involved: the URL is a single argv entry, so its `&` and friends are inert.
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url],
    { detached: true, stdio: "ignore" }).unref();
}

/**
 * Credentials are cached per MCP endpoint, so re-launching the extension does not force a new
 * browser login, and two different Release servers never share tokens.
 */
class Store {
  constructor(endpoint) {
    const key = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
    // Claude Desktop may run with a read-only or unusual HOME; fall back to the temp dir.
    let base;
    try {
      base = join(homedir(), ".digitalai-release-mcp", key);
      mkdirSync(base, { recursive: true });
    } catch {
      base = join(tmpdir(), "digitalai-release-mcp", key);
      mkdirSync(base, { recursive: true });
    }
    this.dir = base;
  }

  read(name) {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), "utf8"));
    } catch {
      return undefined;
    }
  }

  write(name, value) {
    writeFileSync(join(this.dir, name), JSON.stringify(value), { mode: 0o600 });
  }

  remove(name) {
    try {
      rmSync(join(this.dir, name));
    } catch {
      /* already gone */
    }
  }
}

export class ReleaseOAuthProvider {
  constructor(endpoint, redirectUrl, cimdUrl) {
    this._store = new Store(endpoint);
    this._redirectUrl = redirectUrl;
    this._state = randomUUID();

    // THE CIMD OPT-IN. mcp-remote never sets this, which is why it always falls back to DCR.
    this.clientMetadataUrl = cimdUrl;

    // The SDK skips client selection entirely when clientInformation() returns something, so a
    // cached identity would outlive a change to the CIMD document URL — the new setting would
    // silently do nothing. Drop a cached CIMD identity (and the tokens bound to it) when the URL no
    // longer matches. A DCR identity is a server-issued id rather than a URL: leave it alone, or
    // every launch would register a fresh client, which is the whole thing we are avoiding.
    const cached = this._store.read("client.json")?.client_id;
    if (cached?.startsWith("http") && cached !== cimdUrl) {
      log("Client ID Metadata Document URL changed — signing in again");
      this.invalidateCredentials("all");
    }
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return { ...CLIENT_METADATA, redirect_uris: [this._redirectUrl] };
  }

  state() {
    return this._state;
  }

  clientInformation() {
    return this._store.read("client.json");
  }

  saveClientInformation(info) {
    // Under CIMD this is just `{ client_id: <the URL> }` — no registration ever happened.
    this._store.write("client.json", info);
  }

  tokens() {
    return this._store.read("tokens.json");
  }

  saveTokens(tokens) {
    this._store.write("tokens.json", tokens);
  }

  codeVerifier() {
    const v = this._store.read("verifier.json");
    if (!v) throw new Error("No PKCE code verifier saved — restart the authorization flow");
    return v.verifier;
  }

  saveCodeVerifier(verifier) {
    this._store.write("verifier.json", { verifier });
  }

  redirectToAuthorization(url) {
    log("opening browser to sign in…");
    log(url.toString());
    openBrowser(url.toString());
  }

  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") this._store.remove("tokens.json");
    if (scope === "all" || scope === "client") this._store.remove("client.json");
    if (scope === "all" || scope === "verifier") this._store.remove("verifier.json");
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The extension's icon, inlined as a data URI. The callback page is served from a throwaway loopback
 * port, so it cannot reference any asset by URL — it has to carry everything with it. Read once,
 * lazily, and treated as optional: a missing icon must never break a sign-in.
 */
let logoDataUri;
function logo() {
  if (logoDataUri === undefined) {
    try {
      const icon = join(dirname(fileURLToPath(import.meta.url)), "..", "icon.png");
      logoDataUri = `data:image/png;base64,${readFileSync(icon).toString("base64")}`;
    } catch {
      logoDataUri = null;
    }
  }
  return logoDataUri;
}

/** The page the user lands on after the IdP redirects them back. */
function callbackPage({ ok, heading, message }) {
  const src = logo();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ok ? "Signed in" : "Sign-in failed"} — Digital.ai Release</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
           color: #1a1a1a; background: #f6f7f9; }
    main { text-align: center; padding: 3rem; max-width: 30rem; }
    img { width: 72px; height: 72px; margin-bottom: 1.5rem; }
    h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
    p { margin: 0; color: #555; line-height: 1.5; }
    .bad { color: #b3261e; }
    @media (prefers-color-scheme: dark) {
      body { color: #ececec; background: #1c1c1e; }
      p { color: #a5a5a5; }
      .bad { color: #f2b8b5; }
    }
  </style>
</head>
<body>
  <main>
    ${src ? `<img src="${src}" alt="Digital.ai Release">` : ""}
    <h1${ok ? "" : ' class="bad"'}>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

/**
 * Loopback listener for the authorization code. Started before the flow so its (OS-assigned) port
 * can go into redirect_uri — the published document declares port-less loopback URIs, which
 * RFC 8252 §7.3 requires authorization servers to accept on any port.
 *
 * It stays listening for the life of the process rather than only for the first sign-in: when a
 * refresh token expires mid-session the SDK opens the browser again, and the redirect has to have
 * somewhere to land. Call waitForCode() each time a code is expected.
 */
export function startCallbackServer() {
  let pending = null;              // the sign-in currently waiting for its code, if any
  let expectedState = null;

  const settle = (fn, value) => {
    const p = pending;
    pending = null;
    p?.[fn](value);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.pathname.startsWith("/callback")) {
      res.writeHead(404).end();
      return;
    }

    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // Anything on this machine can reach a loopback port, so treat the callback as untrusted input.
    // The state we generated is the only thing tying this redirect to the sign-in we started
    // (OAuth 2.1 §7.12) — without checking it, another local process could feed us its own code.
    let problem = null;
    if (err) problem = "Authorization failed: " + err;
    else if (expectedState && state !== expectedState) problem = "Ignoring a callback with an unexpected state parameter";
    else if (!code) problem = "Authorization callback carried no code";

    res.writeHead(problem ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(callbackPage({
      ok: !problem,
      heading: problem ? "Sign-in failed" : "Signed in to Digital.ai Release",
      message: problem || "You can close this tab and return to Claude.",
    }));

    if (problem) settle("reject", new Error(problem));
    else settle("resolve", code);
  });

  const ready = new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}/callback`);
    });
  });

  return {
    ready,
    /** The state value to require on the next callback (from the OAuth provider). */
    expectState: (value) => {
      expectedState = value;
    },
    waitForCode: () =>
      new Promise((resolve, reject) => {
        pending = { resolve, reject };
      }),
    close: () => server.close(),
  };
}
