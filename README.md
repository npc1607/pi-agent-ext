# pi-agent-ext

Personal extensions & skills for [pi](https://github.com/earendil-works/pi) coding agent.

## Repository structure

Mirrors the layout of `~/.pi/agent/`, so any subdirectory can be symlinked directly:

```
├── extensions/          → ~/.pi/agent/extensions/
│   ├── confirm-edit-only.ts
│   └── thin-orchestrator/
└── skills/              → ~/.pi/agent/skills/
    ├── code-review-skill/      (upstream: awesome-skills/code-review-skill)
    ├── obsidian-skills/        (upstream: kepano/obsidian-skills)
    └── ... 24 more
```

## Skills

Synced from `~/.pi/agent/skills/` — see [`skills/`](skills/). Includes Go style/review/testing skill suite, dev-doc-workflow, excalidraw-diagram, lsp-mcp-server, obsidian-skills, and taste-skill (frontend design). To use them, symlink or copy the skill you want into `~/.pi/agent/skills/`.

## Extensions

### confirm-edit-only.ts

An approval guard for pi: every `edit` / `write` file change and every non-allow-listed `bash` command goes through a **styled confirmation dialog** before running. Read-only and local dev commands pass silently.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ Run command?                                                          [BASH] │
│──────────────────────────────────────────────────────────────────────────────│
│ Command (redirection/substitution):                                          │
│  1│ cd /path/to/your/project                                                 │
│  2│ go test ./internal/biz/... -run                                          │
│    │ "TestExample" -count=1 -timeout 300s 2>&1 | tee test.log                │
│  3│ rm -rf /tmp/test-data                                                    │
│──────────────────────────────────────────────────────────────────────────────│
│ y / Enter = approve   n / Esc = reject                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
```

#### Features

- **Styled overlay dialog** — rounded border, centered overlay, semantic theme colors (danger in red, warnings in yellow), rendered with pi's TUI component system. Falls back to the built-in plain `confirm()` outside interactive TUI mode (e.g. RPC clients).
- **Formatted commands** — command chains (`&&`, `||`, `;`) are split into numbered segments; long commands wrap with aligned continuation indents and overflow folding.
- **Keyboard shortcuts** — `y` / `Enter` to approve (green), `n` / `Esc` / `q` / `Ctrl+C` to reject (red).
- **Quote-aware parsing** — shell syntax inside quotes is treated as literal: `rg "A|B"` (regex alternation), `grep ">&"` (search pattern), and `awk '{print $1}'` never trigger false positives, while real redirections (`>`), command substitution (`$(...)`, even inside double quotes), and pipelines between unknown commands are still caught.
- **Three-tier command classification** (default-deny):

  | Tier | Behavior | Examples |
  |---|---|---|
  | 🟢 Allow-listed | Runs silently | `ls`, `rg`, `cat`, `go build/test/run`, `make`, `kill`, `mkdir/cp/mv`, `git status/diff/add/commit/pull/rebase`, `glab mr list/view`, `curl` to `localhost` or GET-only |
  | 🔴 Danger-listed | Confirmed with a specific dialog | `rm` (any form), `git push` (incl. force), `git reset/clean/restore/checkout -- <path>/branch -D/stash drop`, `sudo`, `ssh/scp/rsync`, `curl -X POST/PUT/PATCH/DELETE` to non-local hosts, `glab` write actions |
  | ⚡ Unknown | Confirmed generically | anything not in either list, shell redirections (`>`), command substitution `$(...)` |

  Also allow-listed as safe segments: `cd` / `pushd` / `popd` (navigation), `tee`, `obsidian`, and harmless stderr redirects (`2>&1`, `2>/dev/null`).

#### Install

Copy into your pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/confirm-edit-only.ts ~/.pi/agent/extensions/
```

Then start pi (or run `/reload` in a running session).

#### Tune the rules

All behavior lives in the classification tables at the top of the file:

- `PASS_EXECUTABLES` — executables that always run silently
- `GIT_PASS` — safe `git` sub-commands
- `GLAB_RISKY` — `glab` actions that need approval
- `classifySegment()` / `classifyGit()` / `classifyCurl()` — per-command logic

The dialog width adapts to the terminal (up to 88%, min 72 columns, max 100).

---

### thin-orchestrator/

A deterministic multi-agent orchestration extension implementing **Meta's Thin Orchestrator Pattern** and **Google's Harness²** on-demand component isolation:

- **Zero domain reasoning in the router**: Follows a fixed **7-Step Deterministic Protocol** (`1.Read → 2.Check → 3.Gather → 4.Auto-discover → 5.Reliability Gate → 6.Delegate → 7.Handle`).
- **Isolated Specialist Subagents (`agents/*.md`)**: `scout`, `planner`, `implementer`, `verifier`, and `reviewer` each run in an isolated `pi --mode json -p --no-session` subprocess with restricted `--tools`.
- **Runtime Knowledge Loading (`knowledge/*.md`)**: Domain knowledge is injected only into the target specialist at execution time, costing zero tokens in the main session.
- **Deterministic Workflow Templates (`workflows/*.json`)**: `bugfix`, `feature`, `scout-and-plan`, and `review-and-fix` sequence existing specialists without adding new agent code, complete with post-stage reliability gates and automatic retry.

#### Install

```bash
ln -s "$(pwd)/extensions/thin-orchestrator" ~/.pi/agent/extensions/thin-orchestrator
```

See [`extensions/thin-orchestrator/README.md`](extensions/thin-orchestrator/README.md) for full usage (`/orchestrate` command and `thin_orchestrator` tool).

## License

[MIT](LICENSE)
