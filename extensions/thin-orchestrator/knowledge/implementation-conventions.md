# Implementation & Go/TypeScript Conventions

## Core Implementation Rules

1. **Precision Edits**:
   - Read target sections before editing.
   - Group related changes in the same file into a single `edit` call with minimal unique `oldText`.
2. **Go Idioms (when in a Go repository)**:
   - Wrap errors with context (`fmt.Errorf("...: %w", err)`).
   - Propagate `context.Context` as the first parameter.
   - Guard against nil dereferences and slice/map aliasing across API boundaries.
3. **TypeScript Idioms (when in a TS/Node repository)**:
   - Maintain strict type safety; avoid unverified casts where schema validation applies.
   - Clean up child processes, timers, and temporary files in `finally` blocks.
