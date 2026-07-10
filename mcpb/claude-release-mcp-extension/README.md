# Digital.ai Release MCP Server — Claude Desktop Extension (MCPB)

One-click-installable Claude Desktop extension that connects Claude to the MCP server built into
Digital.ai Release (26.1.5+). It bundles a thin stdio→Streamable-HTTP bridge (`mcp-remote`) that
forwards Claude Desktop's local MCP traffic to your Release instance's MCP endpoint, authenticated
with your Personal Access Token or through your identity provider (OAuth). Claude acts with that
user's Release permissions.

## Install

1. Download `digitalai-release-mcp.mcpb` and double-click it (or drag it into Claude Desktop, or
   Settings → Extensions → Advanced settings → Install Extension).
2. Fill in the configuration form:
   - **Release server URL** — e.g. `https://release.mycompany.com` (base URL). If your Release
     server uses a non-default servlet path (`spring.mvc.servlet.path`, default `/s`) or a context
     root, paste the full MCP endpoint URL instead.
   - **Personal Access Token** — create one in Release under *User profile → Access tokens*
     (stored in your OS keychain by Claude Desktop). **Or leave it empty to sign in with OAuth**:
     if your Release instance uses an OIDC identity provider, a browser login opens on first use
     (tokens are cached under `~/.mcp-auth`). OAuth requires the identity provider to allow the
     bridge's dynamic client registration.
3. Enable the extension. Ask Claude e.g. *"List my active releases"*.

## Requirements

- Digital.ai Release 26.1.5+ with the MCP server feature enabled (default) and the
  `xlr-mcp-tools-plugin` installed
- Claude Desktop ≥ 0.10 (macOS/Windows/Linux)
- Network reachability from your machine to the Release instance

## Build from source

```bash
npm install        # pulls mcp-remote
npm run build      # validates manifest.json and packs digitalai-release-mcp.mcpb
```

## Privacy

All traffic goes directly from your machine to your Release instance; nothing is routed through
third parties. See the privacy policy linked in `manifest.json`.
