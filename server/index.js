#!/usr/bin/env node
/*
 * Digital.ai Release MCP bridge for Claude Desktop (MCPB).
 *
 * Claude Desktop runs MCPB servers over stdio, while Release's MCP server is remote
 * (Streamable HTTP at <release-url>/s/mcp). This launcher runs mcp-remote's stdio→HTTP proxy
 * IN-PROCESS (argv rewrite + dynamic import) rather than spawning a child: Claude Desktop's
 * "built-in Node.js" is its Electron binary in Node mode, so process.execPath is not a usable
 * `node` for child processes.
 *
 * Authentication: Personal Access Token, sent as the x-release-personal-token header. Claude acts
 * with that Release user's permissions.
 *
 * Configuration arrives via environment variables, substituted by Claude Desktop from the
 * manifest's user_config (see manifest.json): RELEASE_URL, RELEASE_PAT.
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Claude Desktop leaves UNSET user_config values as the literal template string
// (e.g. "${user_config.personal_access_token}") instead of substituting an empty string.
// Treat any unsubstituted template as absent — passing it on is dangerous: mcp-remote applies
// its own ${VAR} env substitution to header values, turning it into an EMPTY header.
function configValue(name) {
  const value = (process.env[name] || "").trim();
  return value.includes("${") ? "" : value;
}

const releaseUrl = configValue("RELEASE_URL").replace(/\/+$/, "");
const pat = configValue("RELEASE_PAT");

if (!releaseUrl) {
  console.error("Digital.ai Release extension: 'Release server URL' is not configured.");
  process.exit(1);
}
if (!pat) {
  console.error("Digital.ai Release extension: 'Personal Access Token' is not configured. "
    + "Create one in Release under User profile > Access tokens.");
  process.exit(1);
}

// The MCP endpoint is "/mcp" hanging off Release's Spring servlet path — "/s" by default, but
// administrators may override spring.mvc.servlet.path (e.g. "/spring"), and installations can also
// sit under a context root (e.g. "/xlr-web"). So: if the configured URL already points at an MCP
// endpoint, use it verbatim; otherwise assume the default and append "/s/mcp". Release shows the
// exact endpoint URL under Settings > System settings > MCP server.
const mcpEndpoint = /\/mcp$/.test(releaseUrl) ? releaseUrl : releaseUrl + "/s/mcp";
const proxyPath = path.join(__dirname, "..", "node_modules", "mcp-remote", "dist", "proxy.js");

const args = [
  mcpEndpoint,
  "--transport", "http-only",
  "--header", "x-release-personal-token:" + pat,
];

// Allow plain-http Release instances for local development (mcp-remote rejects http for
// non-localhost hosts unless explicitly allowed).
if (mcpEndpoint.startsWith("http://")) {
  args.push("--allow-http");
}

console.error("Digital.ai Release extension: bridging to " + mcpEndpoint);

// mcp-remote's proxy parses process.argv.slice(2) at import time — hand it our args and run it
// inside this very process.
process.argv = [process.argv[0], proxyPath, ...args];

import(pathToFileURL(proxyPath).href).catch((err) => {
  console.error("Digital.ai Release extension: failed to start bridge: " + (err && err.stack || err));
  process.exit(1);
});
