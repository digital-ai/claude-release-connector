# Claude ↔ Digital.ai Release MCP Connector

Connect Claude (claude.ai, Claude Desktop, Claude Code) to [Digital.ai Release](https://digital.ai/products/release/) through the MCP server built into Release 26.1.5+ — search and manage releases, templates, tasks, variables and more, with the permissions of the connected Release user.

## Repository layout

| Path | What it is                                                                                                                                                          |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`mcpb/claude-release-mcp-extension/`](./mcpb/claude-release-mcp-extension/) | **Claude Desktop extension** (MCPB bundle) — a stdio→Streamable-HTTP bridge to your Release instance. `npm install && npm run build` → `digitalai-release-mcp.mcpb` |
| [`docs/connecting-claude-to-release.md`](./docs/connecting-claude-to-release.md) | Customer guide: all Claude surfaces, PAT, admin notes, troubleshooting                                                                                              |
