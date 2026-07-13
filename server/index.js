#!/usr/bin/env node
/*
 * Digital.ai Release MCP bridge for Claude Desktop (MCPB).
 *
 * Claude Desktop speaks MCP to extensions over stdio, while Release's MCP server is remote
 * (Streamable HTTP at <release-url>/s/mcp). This bridges the two, and authenticates either with a
 * Personal Access Token or — when none is configured — via OAuth against the customer's IdP.
 *
 * Built directly on @modelcontextprotocol/sdk rather than mcp-remote, because mcp-remote never
 * sets `clientMetadataUrl` on its OAuth provider and therefore always registers a fresh client via
 * DCR (a new client record per install, forever). See oauth.js: we identify by a Client ID
 * Metadata Document instead, falling back to DCR only when the IdP cannot do CIMD.
 *
 * MCP is symmetric JSON-RPC, so the bridge is a dumb bidirectional pipe between the two
 * transports — no interpretation of the traffic, and new Release tools need no changes here.
 *
 * Configuration arrives via environment variables, substituted by Claude Desktop from the
 * manifest's user_config (see manifest.json): RELEASE_URL, RELEASE_PAT.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { DEFAULT_CIMD_URL, ReleaseOAuthProvider, startCallbackServer, validateCimdUrl } from "./oauth.js";

const log = (msg) => console.error("Digital.ai Release extension: " + msg);

// Claude Desktop leaves UNSET optional user_config values as the literal template string
// (e.g. "${user_config.personal_access_token}") instead of substituting an empty string.
function configValue(name) {
  const value = (process.env[name] || "").trim();
  return value.includes("${") ? "" : value;
}

const releaseUrl = configValue("RELEASE_URL").replace(/\/+$/, "");
const pat = configValue("RELEASE_PAT");

if (!releaseUrl) {
  log("'Release server URL' is not configured.");
  process.exit(1);
}

// The MCP endpoint is "/mcp" hanging off Release's Spring servlet path — "/s" by default, but
// administrators may override spring.mvc.servlet.path (e.g. "/spring"), and installations can also
// sit under a context root (e.g. "/xlr-web"). So: if the configured URL already points at an MCP
// endpoint, use it verbatim; otherwise assume the default and append "/s/mcp". Release shows the
// exact endpoint URL under Settings > System settings > MCP server.
const endpoint = /\/mcp$/.test(releaseUrl) ? releaseUrl : releaseUrl + "/s/mcp";

/** Authenticate. Returns the transport options, plus what is needed to re-authenticate later. */
async function connect() {
  if (pat) {
    log(`bridging to ${endpoint} (Personal Access Token)`);
    return { options: { requestInit: { headers: { "x-release-personal-token": pat } } } };
  }

  // Only set by customers whose IdP cannot reach the public internet and must serve the document
  // from an internal host (see oauth.js).
  const cimdUrl = configValue("RELEASE_CIMD_URL") || DEFAULT_CIMD_URL;
  const invalid = validateCimdUrl(cimdUrl);
  if (invalid) {
    log(invalid);
    process.exit(1);
  }
  if (cimdUrl !== DEFAULT_CIMD_URL) {
    log(`using a custom Client ID Metadata Document: ${cimdUrl}`);
  }

  // Stays listening for the life of the process: a refresh token that expires mid-session sends the
  // user back through the browser, and that redirect needs somewhere to land.
  const callback = startCallbackServer();
  const redirectUrl = await callback.ready;
  const provider = new ReleaseOAuthProvider(endpoint, redirectUrl, cimdUrl);
  callback.expectState(await provider.state());

  // Discovers the IdP via Release's RFC 9728 metadata, then obtains a client_id — by CIMD if the
  // IdP advertises support, otherwise by DCR. Returns REDIRECT when a browser login is needed.
  let result = await auth(provider, { serverUrl: endpoint });

  if (result === "REDIRECT") {
    const code = await callback.waitForCode();
    result = await auth(provider, { serverUrl: endpoint, authorizationCode: code });
  }

  if (result !== "AUTHORIZED") {
    throw new Error(`authorization did not complete (${result})`);
  }

  const clientId = (await provider.clientInformation())?.client_id;
  log(clientId === cimdUrl
    ? "authorized via Client ID Metadata Document (no client registered in your IdP)"
    : `authorized via Dynamic Client Registration (client_id ${clientId}) — the IdP did not advertise CIMD support`);

  return { options: { authProvider: provider }, callback };
}

/** Pipe JSON-RPC between Claude (stdio) and Release (Streamable HTTP) until either side closes. */
async function main() {
  const { options, callback } = await connect();
  const remote = new StreamableHTTPClientTransport(new URL(endpoint), options);
  const local = new StdioServerTransport();

  let closing = false;
  const shutdown = (why) => {
    if (closing) return;
    closing = true;
    if (why) log(why);
    callback?.close();
    Promise.allSettled([remote.close(), local.close()]).then(() => process.exit(0));
  };

  // Claude -> Release. The SDK refreshes an expired access token by itself; UnauthorizedError means
  // even the refresh failed, and it has already opened the browser for a fresh sign-in. Wait for the
  // code to reach the callback listener, finish the flow, and deliver the message that triggered it
  // — otherwise the tool call it belongs to is silently dropped.
  local.onmessage = async (message) => {
    try {
      await remote.send(message);
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || !callback) {
        log("could not send to Release: " + (err?.message || err));
        return;
      }
      try {
        log("session expired — signing in again");
        await remote.finishAuth(await callback.waitForCode());
        await remote.send(message);
        log("signed in again");
      } catch (reauthErr) {
        log("could not sign in again: " + (reauthErr?.message || reauthErr));
      }
    }
  };

  // Release -> Claude. Nothing to recover from here; a failure to reach Claude's stdin is terminal.
  remote.onmessage = async (message) => {
    try {
      await local.send(message);
    } catch (err) {
      log("could not send to Claude: " + (err?.message || err));
    }
  };

  remote.onclose = () => shutdown("Release closed the connection");
  local.onclose = () => shutdown();
  remote.onerror = (err) => log("remote transport error: " + (err?.message || err));
  local.onerror = (err) => log("stdio transport error: " + (err?.message || err));

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  await remote.start();
  await local.start();   // begins reading stdin — must come last
  log("bridge ready");
}

main().catch((err) => {
  log("failed to start bridge: " + (err?.stack || err));
  process.exit(1);
});
