# Connecting Claude to Digital.ai Release

Digital.ai Release 26.1.5+ includes an MCP (Model Context Protocol) server that lets AI assistants
like Claude work with your releases: search and inspect releases and templates, create releases
from templates, start them, manage folders, phases, tasks, gates, variables and configurations,
and read activity logs — always with the permissions of the connected Release user.

## How it works

- **Endpoint:** `https://<your-release-server>/s/mcp` (MCP Streamable HTTP).
- **Enabled by default**; administrators can disable it or switch it to **read-only mode**
  (mutating tools are hidden and rejected) from the same settings page.
- **Tools require the `xlr-mcp-tools-plugin`** (bundled/installed as a Release plugin).
- **Every action is authorized as the connected user** through Release's normal permission model.

## Authentication: Personal Access Token

Claude authenticates to the MCP endpoint with a Release **Personal Access Token (PAT)**, sent as
the `x-release-personal-token` request header. This works on every Release 26.1.5+ installation and
needs no server-side setup.

**Creating a PAT:** Release → user profile → **Access tokens** → Generate token; copy the `rpa_…` value.
Claude will act with exactly this user's permissions; use a least-privilege account for
read-mostly workflows.

## Claude Desktop (recommended for most users)

Install the **Digital.ai Release MCP Server** extension by double-clicking the
`digitalai-release-mcp.mcpb` file (or dragging it into Claude Desktop):

1. Claude Desktop → Settings → Extensions → Advanced settings → Install Extension.
2. In the configuration form:
   - **Release server URL** — e.g. `https://release.mycompany.com`. If your server uses a
     non-default servlet path or context root, paste the full endpoint URL.
   - **Personal Access Token** — create one in Release under *User profile → Access tokens*
3. Enable the extension and ask Claude: *"List my active releases."*

Notes: the token is stored in your OS keychain. Your machine connects directly to the Release
server (same network requirements as using the Release UI in a browser — VPN etc.); traffic is
never routed through third parties.

## Claude Code

```bash
claude mcp add --transport http release https://release.mycompany.com/s/mcp \
  --header "x-release-personal-token: <your PAT>"
```

Verify with `claude mcp list` (should show connected), then ask Claude about your releases.

## Requirements & administrator notes

- **Release 26.1.5+** with the MCP server feature enabled (default) and the tools plugin installed.
- **Public URL correctness:** the endpoint URL Release advertises derives from the configured
  server URL (`server.url`) — set it to the URL users actually reach (reverse-proxy hostname,
  HTTPS).
- **Governance:** flip **read-only mode** to expose only non-mutating tools; connected clients
  update their tool list live. Disable the MCP server entirely from the same settings page
  (endpoint answers 404). All tool calls are attributed to the authenticated user in Release's
  audit/activity logs.

## Troubleshooting

| Symptom | Check |
|---|---|
| Claude client reports 401 | PAT valid and not expired? Header name exactly `x-release-personal-token`? |
| Endpoint returns 404 | MCP server disabled in settings, Release older than 26.1.5, or wrong URL. The path is `<servlet-path>/mcp` — `/s/mcp` by default, but `spring.mvc.servlet.path` may be overridden (e.g. `/spring/mcp`) and a context root may prefix it. |
| Tools missing | Read-only mode hides mutating tools; the tools plugin must be installed |
| Claude Desktop extension fails to connect | URL reachable from your machine (VPN)? Certificate issued by a publicly trusted CA? |
