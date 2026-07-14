# Digital.ai Release MCP Server — Claude Desktop Extension

One-click-installable Claude Desktop extension (MCPB) that connects Claude to the MCP server built
into [Digital.ai Release](https://digital.ai/products/release/) 26.1.5+. It bundles a thin
stdio→Streamable-HTTP bridge ([`mcp-remote`](https://www.npmjs.com/package/mcp-remote)) that forwards
Claude Desktop's local MCP traffic to your Release instance's MCP endpoint, authenticated with your
Personal Access Token. Claude acts with that user's Release permissions.

Search and manage releases, templates, folders, phases, tasks, gates, variables and configurations,
and read activity logs — all from Claude.

## Install

1. Download the `.mcpb` file and double-click it (or drag it into Claude Desktop, or
   Settings → Extensions → Advanced settings → Install Extension).
2. Fill in the configuration form:
   - **Release server URL** — e.g. `https://release.mycompany.com` (base URL). If your Release
     server uses a non-default servlet path (`spring.mvc.servlet.path`, default `/s`) or a context
     root, paste the full MCP endpoint URL instead.
   - **Personal Access Token** — create one in Release under *User profile → Access tokens*
     (stored in your OS keychain by Claude Desktop).
3. Enable the extension. Ask Claude e.g. *"List my active releases"*.

For Claude Code, and for administrator setup, see
[docs/connecting-claude-to-release.md](./docs/connecting-claude-to-release.md).

## Requirements

- Digital.ai Release 26.1.5+ with the MCP server feature enabled (default) and the
  `xlr-mcp-tools-plugin` installed
- Claude Desktop ≥ 0.10 (macOS/Windows/Linux)
- Network reachability from your machine to the Release instance

## Build from source

```bash
npm install        # pulls mcp-remote
npm run build      # validates manifest.json, packs digitalai-release-mcp-<version>.mcpb
```

To cut a new version, use `npm version patch|minor|major` — it bumps `package.json` and
`manifest.json` together (the build refuses to run if the two disagree).

## Privacy Policy

Digital.ai's privacy policy: <https://digital.ai/privacy-policy/>

This extension collects nothing — no telemetry, no analytics, no backend of its own. It is a bridge:
requests go from Claude Desktop on your machine directly to the Release instance *you* configure, and
nothing is routed through Digital.ai or any third party. Your Release URL and Personal Access Token
are stored locally by Claude Desktop, with the token held in your OS keychain. Release data stays in
your own Release instance under your organization's policies. Your prompts and tool results are
processed by Claude under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), as in
any Claude conversation.

## Support

- **This extension** — [open an issue](https://github.com/digital-ai/claude-release-connector/issues)
- **Digital.ai Release itself** — <https://support.digital.ai>

## License

MIT — see [LICENSE](./LICENSE).
