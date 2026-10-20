# Thin Orchestrator (`thin-orchestrator`)

A deterministic multi-agent orchestration extension for [Pi](https://github.com/earendil-works/pi), implementing **Meta's Thin Orchestrator Pattern** (*The Thin Orchestrator: How We Made Our AI Agents More Reliable by Giving the Router Less to Do*, Oct 2026) and **Google's Harness²** on-demand component isolation principles.

## Why a Thin Orchestrator?

Loading all domain knowledge, schemas, and workflow rules into a single "all-knowing" main agent causes context interference and cross-contamination past a context threshold.

`thin-orchestrator` splits orchestration into two layers:
1. **A deterministic TypeScript router (`index.ts` + `runner.ts` + `discovery.ts`)** that performs **zero domain reasoning**. It owns intent routing, pre-flight checks, field gathering, workspace auto-discovery, and post-stage reliability gates.
2. **Isolated Specialist Subagents (`agents/*.md`)**, each running in its own `pi --mode json -p --no-session` subprocess with restricted `--tools` and runtime-mounted domain knowledge files (`knowledge/*.md`).

## Fixed 7-Step Protocol

Every request through `thin_orchestrator` executes Meta's 7-step protocol:

| Step | Name | Type | Responsibility |
| :---: | :--- | :---: | :--- |
| **1** | **Read** | Deterministic | Load workflow state machine (`workflows/*.json`) & specialist definitions (`agents/*.md`) |
| **2** | **Check** | Deterministic | Execute pre-flight shell checks (`preChecks` / `pre_check`) before spending any LLM tokens |
| **3** | **Gather** | Deterministic | Verify `requiredFields` (`required_fields`); prompt interactively via `ctx.ui.input` if missing |
| **4** | **Auto-discover** | Deterministic | Infer git repo root, branch, dirty files, language stack, and `go.mod` module path |
| **5** | **Reliability Gate** | Deterministic | Verify project trust and pre-execution safety constraints |
| **6** | **Delegate** | **LLM (Isolated)** | Spawn isolated `pi` subprocesses per stage with runtime-injected `knowledge/*.md` |
| **7** | **Handle** | Deterministic | Run post-stage `gateCmd` (e.g., `git diff --check`), auto-retry on gate failure, and aggregate telemetry |

## Directory Structure

```text
thin-orchestrator/
├── index.ts                 # Extension entry point (registers `thin_orchestrator` tool & `/orchestrate` command)
├── runner.ts                # 7-step protocol engine & isolated subprocess executor
├── discovery.ts             # Specialist, workflow, runtime knowledge, and workspace auto-discovery
├── types.ts                 # TypeScript contracts
├── agents/                  # Standardized 5-section Specialist Subagents
│   ├── scout.md             # Read-only codebase recon & dependency boundary discovery
│   ├── planner.md           # Technical blueprint & step-by-step execution planning
│   ├── implementer.md       # Scoped code implementation with `git diff --check` post-gate
│   ├── verifier.md          # Deterministic build, test, and static analysis verification
│   └── reviewer.md          # Diff & regression review specialist
├── knowledge/               # Runtime domain knowledge (loaded on demand at Step 6, 0 main-context cost)
│   ├── code-search.md       # Hybrid `rg` + `sgrep` search patterns
│   ├── architecture-rules.md
│   ├── implementation-conventions.md
│   ├── verification-checklist.md
│   └── review-checklist.md
└── workflows/               # Deterministic Workflow Templates (reuse specialists without new agent code)
    ├── bugfix.json          # scout -> planner -> implementer -> verifier -> reviewer
    ├── feature.json         # scout -> planner -> implementer -> verifier -> reviewer
    ├── scout-and-plan.json  # scout -> planner
    └── review-and-fix.json  # reviewer -> implementer -> verifier
```

## Installation

Symlink or copy the directory into `~/.pi/agent/extensions/`:

```bash
# clone anywhere you like, e.g. ~/Project
ln -s ~/Project/pi-agent-ext/extensions/thin-orchestrator ~/.pi/agent/extensions/thin-orchestrator
```

Then run `/reload` inside Pi (or test directly with `pi -e ~/Project/pi-agent-ext/extensions/thin-orchestrator/index.ts`).

## Usage

### 1. Slash Command (`/orchestrate`)

```text
/orchestrate list
/orchestrate bugfix Fix DispatchJob state sync failure after restart
/orchestrate scout-and-plan Trace how episode duration is calculated in data-service
/orchestrate
```

Running `/orchestrate` without arguments opens an interactive TUI selector to choose a workflow template and enter the task.

### 2. Model-Callable Tool (`thin_orchestrator`)

The model can invoke `thin_orchestrator` in three modes:
- **Workflow Mode**: `{ workflow: "bugfix", task: "..." }`
- **Single Specialist Mode**: `{ agent: "scout", task: "..." }`
- **Parallel Specialist Mode**: `{ tasks: [{ agent: "scout", task: "..." }, { agent: "reviewer", task: "..." }], task: "..." }`

Press `Ctrl+O` on any `thin_orchestrator` result block in Pi's TUI to expand the full 7-step protocol audit, runtime knowledge badges, tool calls, and per-specialist token/cost telemetry.
