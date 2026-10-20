# Architecture & Execution Planning Rules

## Design Principles

1. **Separation of Concerns**:
   - Keep routing/state-machine transitions deterministic and explicit.
   - Isolate side effects (notifications, async triggers, external RPCs) from core transaction state updates.
2. **Minimal Surface Change**:
   - Prefer extending existing interfaces or table/query boundaries cleanly over duplicating handler pipelines.
3. **Actionable Plan Contract**:
   - Every implementation step must name the exact file path, function/type signature, and verification command.
   - Explicitly list edge cases (nil slices, empty inputs, concurrency/transaction boundaries, backward compatibility).
