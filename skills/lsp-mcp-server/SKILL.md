---
name: lsp-mcp-server
description: Use this skill when working on Go code and semantic navigation/refactoring/diagnostics are needed through the gopls LSP MCP server.
---

# Go LSP MCP (gopls)

Pi has an MCP adapter configured with an LSP bridge server named `gopls-lsp`, backed by `gopls`.

Before semantic Go code navigation or refactoring:

1. Use the MCP adapter to discover/check LSP tools, for example search for `lsp_server_status` or `lsp_start_server`.
2. Start the Go language server for the project root if it is not running (`server_id: "go"`, `workspace_root: absolute project path`).
3. Prefer LSP tools over text search for code symbols:
   - definition: `lsp_goto_definition`
   - references: `lsp_find_references`
   - workspace symbols: `lsp_workspace_symbols` / `lsp_find_symbol`
   - file outline: `lsp_document_symbols`
   - type/docs: `lsp_hover`
   - diagnostics: `lsp_diagnostics` / `lsp_workspace_diagnostics`
   - rename/refactor: `lsp_rename`, `lsp_code_actions`

All LSP file paths must be absolute. Line and column numbers are 1-indexed.

With Pi's MCP adapter, use the `mcp` proxy tool to search and call these tools, e.g. search `"lsp"` or call the exact `lsp_*` tool with JSON arguments.
