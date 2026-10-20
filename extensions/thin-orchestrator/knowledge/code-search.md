# Code Search & Reconnaissance Knowledge

## Hybrid Search Strategy (`rg` + semantic search)

1. **Exact Symbol / Identifier / Error String**:
   - Always run `rg -n "<symbol>"` first.
2. **Conceptual / Intent-Based Query**:
   - When searching by intent or when `rg` returns no direct match, use a semantic code search tool if available (e.g. `sgrep "<query>" -n 5`); otherwise refine the `rg` pattern or browse the package structure.
3. **Boundary Tracing**:
   - Read only the targeted line ranges (`offset` + `limit`) around matched symbols.
   - Trace callers and callees across interface boundaries without dumping entire large files into output.
