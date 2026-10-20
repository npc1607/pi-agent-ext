# Build, Test & Static Verification Checklist

## Deterministic Verification Sequence

1. **Go Repositories (`go.mod` present)**:
   - Compile check: `go build ./...`
   - Targeted unit tests: `go test ./path/to/pkg -run TestName -count=1`
   - Vet check: `go vet ./...`
2. **TypeScript / Node Repositories (`package.json` present)**:
   - Typecheck / build script from `package.json`
3. **C / CMake Repositories (`CMakeLists.txt` or `Makefile` present)**:
   - Run the configured build target (`cmake --build` or `make`)
4. **Git Hygiene**:
   - Run `git diff --check` to ensure no conflict markers or whitespace errors were introduced.
   - Run `git status --short` to verify no stray temporary files remain untracked.
