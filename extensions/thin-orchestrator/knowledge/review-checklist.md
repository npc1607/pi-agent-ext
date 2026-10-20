# Code Review & Regression Checklist

## High-Signal Review Dimensions

1. **Correctness & Edge Cases**:
   - Does the diff solve the root cause stated in the task without breaking existing callers?
   - Are empty inputs, error paths, timeouts, and boundary conditions handled?
2. **State & Concurrency Safety**:
   - Are database transactions, locks, or shared state transitions atomic and free of race conditions?
3. **API & Schema Compatibility**:
   - Are protobuf/JSON field names, zero values, and backward compatibility preserved?
4. **Output Format**:
   - Classify findings into `[CRITICAL]`, `[WARNING]`, and `[NIT]` with `file:line` references, followed by a clear `VERDICT: PASS` or `VERDICT: NEEDS_FIX`.
