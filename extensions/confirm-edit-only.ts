import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Command classification
//
// Three tiers:
//   1. allow-listed  → runs without confirmation (local, recoverable work)
//   2. danger-listed → confirmed with a specific kind/title (rm, push, ...)
//   3. unknown       → confirmed generically (default-deny for anything else)
// ---------------------------------------------------------------------------

/** Executables that always pass. Sub-command nuance is handled per command. */
const PASS_EXECUTABLES = new Set([
  // navigation
  "cd", "pushd", "popd",
  // reading
  "cat", "bat", "ls", "lsd", "pwd", "rg", "grep", "find", "fd", "head", "tail", "wc",
  "stat", "file", "du", "df", "which", "type", "echo", "printf", "date", "jq", "yq",
  "tree", "ps", "lsof", "uname", "hostname", "whoami", "id", "printenv", "basename",
  "dirname", "realpath", "readlink", "open", "diff", "cmp", "shasum", "md5", "sleep",
  "true", "false", "seq", "bc", "column", "cut", "sort", "uniq", "tr", "sed", "awk",
  "pandoc",
  // local build / dev workflow
  "go", "make", "gofmt", "golangci-lint", "air",
  // local process management (dev servers)
  "kill", "pkill",
  // local file ops (recoverable via git inside projects)
  "mkdir", "touch", "cp", "mv",
  // log-friendly pipe sink
  "tee",
  // vault CLI — writing the vault is its purpose
  "obsidian",
]);

/** git sub-commands that pass. Others (push/rm/clean/...) are danger-listed. */
const GIT_PASS = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-remote", "tag", "add", "commit",
  "switch", "pull", "fetch", "merge", "rebase", "cherry-pick", "remote", "describe",
  "rev-parse", "blame", "grep", "reflog", "worktree", "init", "clone", "mv", "am",
  "apply", "format-patch", "shortlog", "archive", "bisect", "stage", "unstage", "gc",
]);

/** glab write actions that must be confirmed. */
const GLAB_RISKY = new Set([
  "create", "merge", "close", "reopen", "delete", "update", "approve", "publish",
  "edit", "mr", // "glab api" can also write
]);

const CURL_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Strip leading env-var assignments and common wrappers (env, nohup, nice, timeout N). */
function stripPrefixes(words: string[]): string[] {
  let i = 0;
  const isAssign = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
  while (i < words.length && isAssign(words[i])) i++;
  if (words[i] === "env") {
    i++;
    while (i < words.length && isAssign(words[i])) i++;
  }
  const wrappers = new Set(["nohup", "nice"]);
  while (i < words.length && (wrappers.has(words[i]) || words[i] === "command")) i++;
  if (words[i] === "timeout") i += 2; // timeout <duration> <cmd>
  return words.slice(i);
}

/** First non-global-flag word after the executable, for git/glab/go parsing. */
function subcommandOf(words: string[]): { sub: string; rest: string[] } {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree") {
      i += 2;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    return { sub: w, rest: words.slice(i + 1) };
  }
  return { sub: "", rest: [] };
}

type SegmentVerdict =
  | { action: "allow" }
  | { action: "confirm"; kind: ConfirmKind; title: string; label: string };

function classifyCurl(words: string[]): SegmentVerdict {
  const args = words.slice(1);
  let method = "GET";
  let url: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--request") {
      method = (args[++i] ?? "GET").toUpperCase();
    } else if (a.startsWith("--request=")) {
      method = a.slice(a.indexOf("=") + 1).toUpperCase();
    } else if (/^-X./.test(a)) {
      method = a.slice(2).toUpperCase();
    } else if (
      a === "-d" || a === "--data" || a.startsWith("--data-") || a === "-F" ||
      a.startsWith("--form") || a === "-T" || a === "--upload-file" || a === "--json"
    ) {
      if (method === "GET") method = "POST";
    } else if (/^https?:\/\//.test(a)) {
      if (!url) url = a;
    }
  }

  if (!CURL_WRITE_METHODS.has(method)) return { action: "allow" };

  let host = "";
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
  }
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host === "[::1]" || host === "0.0.0.0" || host.endsWith(".local");
  if (url && isLocal) return { action: "allow" };

  return {
    action: "confirm",
    kind: "command",
    title: "Approve remote API call?",
    label: `Remote ${method} request (non-local host):`,
  };
}

function classifyGit(words: string[]): SegmentVerdict {
  const { sub, rest } = subcommandOf(words);
  const confirm = (kind: ConfirmKind, title: string, label: string): SegmentVerdict => ({
    action: "confirm", kind, title, label,
  });

  switch (sub) {
    case "push":
      return confirm("push", "Approve git push?", "git push:");
    case "rm":
      return confirm("delete", "Delete tracked files?", "git rm:");
    case "reset":
      return confirm("command", "Approve git reset?", "git reset (moves refs):");
    case "clean":
      return confirm("delete", "Delete untracked files?", "git clean:");
    case "restore":
      return confirm("command", "Discard working-tree changes?", "git restore:");
    case "checkout":
      // `git checkout -- <path>` / `git checkout .` discard changes.
      if (rest.includes("--") || rest[0] === "." || rest[0] === ":/") {
        return confirm("command", "Discard working-tree changes?", "git checkout (discard):");
      }
      return { action: "allow" };
    case "branch":
      if (rest.includes("-D") || (rest.includes("--delete") && rest.includes("--force"))) {
        return confirm("command", "Force-delete branch?", "git branch -D:");
      }
      return { action: "allow" };
    case "stash":
      if (["drop", "clear"].includes(rest[0] ?? "")) {
        return confirm("command", "Drop stash entries?", `git stash ${rest[0]}:`);
      }
      return { action: "allow" };
    case "config":
      if (rest.includes("--global") || rest.includes("--system")) {
        return confirm("command", "Modify global git config?", "git config:");
      }
      return { action: "allow" };
    default:
      return GIT_PASS.has(sub) ? { action: "allow" } : { action: "confirm", kind: "command", title: "Approve command?", label: "Command (not allow-listed):" };
  }
}

function classifyGlab(words: string[]): SegmentVerdict {
  const { sub, rest } = subcommandOf(words);
  if (sub === "api" || GLAB_RISKY.has(rest[0] ?? "")) {
    const action = ["glab", sub, rest[0] ?? ""].filter(Boolean).join(" ");
    return {
      action: "confirm",
      kind: "command",
      title: "Approve GitLab write action?",
      label: `${action}:`,
    };
  }
  return { action: "allow" };
}

function classifySegment(segment: string): SegmentVerdict {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return { action: "allow" };

  const words = stripPrefixes(raw);
  if (words.length === 0) return { action: "allow" };

  const executable = words[0].split("/").pop() ?? words[0];

  if (executable === "sudo") {
    return { action: "confirm", kind: "command", title: "Run privileged command?", label: "sudo command:" };
  }
  if (executable === "ssh" || executable === "scp" || executable === "rsync") {
    return { action: "confirm", kind: "command", title: "Approve remote command?", label: "Remote execution:" };
  }
  if (executable === "rm") {
    return { action: "confirm", kind: "delete", title: "Delete files?", label: "Deletion detected:" };
  }
  if (executable === "git") return classifyGit(words);
  if (executable === "glab") return classifyGlab(words);
  if (executable === "curl") return classifyCurl(words);

  return PASS_EXECUTABLES.has(executable)
    ? { action: "allow" }
    : { action: "confirm", kind: "command", title: "Approve command?", label: "Command (not allow-listed):" };
}

type CommandVerdict =
  | { action: "allow" }
  | { action: "confirm"; kind: ConfirmKind; title: string; label: string };

/**
 * Split a shell command into segments at operators (&&, ||, ;, |), but only
 * when they are NOT inside quotes. A `|` inside an rg pattern like "A|B"
 * is an alternation, not a pipe.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((s) => s.trim() !== "");
}

/**
 * Quote-aware scan for shell metacharacters that can hide writes.
 * - Outside quotes: $ ` < > are all dangerous.
 * - Inside single quotes: nothing is interpreted.
 * - Inside double quotes: < > are literal, but $ and ` still allow
 *   command substitution ("$(rm -rf /)" is a real write).
 */
function containsDangerousShellChars(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "$" || ch === "`") {
        return true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "<" || ch === ">") return true;
  }
  return false;
}

/**
 * Evaluate a full shell command (pipelines/chains included).
 * Any segment that requires confirmation triggers confirmation for the whole
 * command; the first such segment decides the dialog kind/title.
 */
function evaluateCommand(command: string): CommandVerdict {
  const normalized = command
    .replace(/(^|\s)2>&1(\s|$)/g, " ")
    .replace(/(^|\s)2>\/dev\/null(\s|$)/g, " ")
    .replace(/(^|\s)1?>\/dev\/null(\s|$)/g, " ")
    .replace(/(^|\s)&>\/dev\/null(\s|$)/g, " ");

  // Redirections and command substitution always require confirmation.
  // Quote-aware: a quoted `>` in a grep pattern is literal, not a redirect.
  if (containsDangerousShellChars(normalized)) {
    return { action: "confirm", kind: "command", title: "Approve command?", label: "Command (redirection/substitution):" };
  }

  let verdict: CommandVerdict = { action: "allow" };
  for (const segment of splitShellSegments(normalized)) {
    const v = classifySegment(segment);
    if (v.action === "confirm") {
      verdict = { action: "confirm", kind: v.kind, title: v.title, label: v.label };
      break;
    }
  }
  return verdict;
}

/** Split a shell command chain into readable segments (keep pipes joined). */
function splitCommand(command: string): string[] {
  return splitShellSegments(command)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Styled confirmation dialog
// ---------------------------------------------------------------------------

type ConfirmKind = "edit" | "write" | "delete" | "push" | "command";

interface ConfirmSpec {
  kind: ConfirmKind;
  title: string;
  detail: DetailEntry[];
}

/** A plain text line in the dialog body. */
interface TextEntry {
  type: "text";
  text: string;
}

/** A labeled block of numbered command segments. */
interface CodeEntry {
  type: "code";
  label: string;
  segments: string[];
}

type DetailEntry = TextEntry | CodeEntry;

const KIND_LABEL: Record<ConfirmKind, (text: string, theme: Theme) => string> = {
  edit: (t, th) => th.style(t, { fg: "accent", bold: true }),
  write: (t, th) => th.style(t, { fg: "accent", bold: true }),
  delete: (t, th) => th.style(t, { fg: "error", bold: true }),
  push: (t, th) => th.style(t, { fg: "error", bold: true }),
  command: (t, th) => th.style(t, { fg: "warning", bold: true }),
};

const KIND_TAG: Record<ConfirmKind, string> = {
  edit: "EDIT",
  write: "WRITE",
  delete: "DELETE",
  push: "PUSH",
  command: "BASH",
};

const MAX_SEGMENT_LINES = 3;
const MAX_SEGMENTS = 8;

class ConfirmDialog {
  private theme: Theme;
  private spec: ConfirmSpec;
  private done: (result: boolean) => void;

  constructor(theme: Theme, spec: ConfirmSpec, done: (result: boolean) => void) {
    this.theme = theme;
    this.spec = spec;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(false);
    } else if (matchesKey(data, "return")) {
      this.done(true);
    } else if (data === "y" || data === "Y") {
      this.done(true);
    } else if (data === "n" || data === "N" || data === "q" || data === "Q") {
      this.done(false);
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    // Wider dialog for long commands; capped to 88% of terminal width.
    const boxW = Math.min(width, Math.max(72, Math.floor(width * 0.88)));
    const innerW = Math.max(1, boxW - 2);
    const lines: string[] = [];

    // Header: title left, kind tag right.
    const tag = `[${KIND_TAG[this.spec.kind]}]`;
    const title = this.spec.title;
    const titleW = visibleWidth(title);
    const tagW = visibleWidth(tag);
    const gap = Math.max(1, innerW - 3 - titleW - tagW);
    const tagColor = this.spec.kind === "delete" || this.spec.kind === "push" ? "error" : "accent";
    lines.push(
      " " +
        KIND_LABEL[this.spec.kind](title, th) +
        " ".repeat(gap) +
        th.fg(tagColor, tag),
    );
    lines.push(th.fg("border", "─".repeat(innerW)));

    // Detail body, wrapped to the box width.
    const bodyLines: string[] = [];
    const pushWrapped = (text: string, indent: string, avail: number) => {
      const wrapped = wrapTextWithAnsi(text, avail);
      for (const w of wrapped.slice(0, MAX_SEGMENT_LINES)) bodyLines.push(indent + w);
      if (wrapped.length > MAX_SEGMENT_LINES) {
        bodyLines.push(th.fg("muted", `${indent}… +${wrapped.length - MAX_SEGMENT_LINES} more lines`));
      }
    };

    for (const entry of this.spec.detail) {
      if (entry.type === "text") {
        if (entry.text === "") {
          bodyLines.push("");
          continue;
        }
        pushWrapped(entry.text, " ", innerW - 2);
        continue;
      }

      // Command block: label + numbered segments, continuation indented.
      bodyLines.push(th.fg("muted", entry.label));
      const segs = entry.segments.slice(0, MAX_SEGMENTS);
      const numW = String(segs.length).length;
      const cmdColor = this.spec.kind === "delete" || this.spec.kind === "push" ? "error" : "accent";
      for (let i = 0; i < segs.length; i++) {
        const num = String(i + 1).padStart(numW, " ");
        const marker = th.fg("dim", `${num}│ `);
        const contIndent = " ".repeat(numW + 2);
        const avail = innerW - 2 - numW - 2;
        const wrapped = wrapTextWithAnsi(th.fg(cmdColor, segs[i]), avail);
        for (let j = 0; j < Math.min(wrapped.length, MAX_SEGMENT_LINES); j++) {
          bodyLines.push((j === 0 ? marker : contIndent) + wrapped[j]);
        }
        if (wrapped.length > MAX_SEGMENT_LINES) {
          bodyLines.push(th.fg("muted", `${contIndent}… +${wrapped.length - MAX_SEGMENT_LINES} more lines`));
        }
      }
      if (entry.segments.length > MAX_SEGMENTS) {
        bodyLines.push(th.fg("muted", `… +${entry.segments.length - MAX_SEGMENTS} more commands`));
      }
    }
    for (const line of bodyLines) {
      lines.push(truncateToWidth(line, innerW, "…", true));
    }

    // Footer: key hints.
    lines.push(th.fg("border", "─".repeat(innerW)));
    const yes = th.style("y / Enter = approve", { fg: "success", bold: true });
    const no = th.style("n / Esc = reject", { fg: "error", bold: true });
    const hint = `${yes}   ${no}`;
    const hintW = visibleWidth(yes) + 3 + visibleWidth(no);
    lines.push(" " + hint + " ".repeat(Math.max(0, innerW - 2 - hintW)));

    return this.box(lines, boxW);
  }

  private box(lines: string[], boxW: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, boxW - 2);
    const result: string[] = [];

    // Pad all lines to the same width so the border closes cleanly.
    const padded = lines.map((line) => {
      const w = visibleWidth(line);
      return w >= innerW ? truncateToWidth(line, innerW, "…", true) : line + " ".repeat(innerW - w);
    });

    result.push(th.fg("border", "╭" + "─".repeat(innerW) + "╮"));
    for (const line of padded) {
      result.push(th.fg("border", "│") + line + th.fg("border", "│"));
    }
    result.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));
    return result;
  }

  invalidate(): void {}
  dispose(): void {}
}

/**
 * Confirm an action with a styled overlay dialog.
 * Falls back to the plain built-in confirm outside interactive TUI mode
 * (RPC clients forward dialogs but not custom components).
 */
async function styledConfirm(
  ctx: ExtensionContext,
  title: string,
  detail: DetailEntry[],
  kind: ConfirmKind,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const plain = detail
      .map((e) => (e.type === "text" ? e.text : [e.label, ...e.segments.map((s) => `  $ ${s}`)].join("\n")))
      .join("\n");
    return ctx.ui.confirm(title, plain);
  }

  return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
    const dialog = new ConfirmDialog(theme, { kind, title, detail }, done);
    return {
      render: (width: number) => dialog.render(width),
      invalidate: () => dialog.invalidate(),
      handleInput: (data: string) => {
        dialog.handleInput(data);
        tui.requestRender();
      },
      dispose: () => dialog.dispose(),
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: 100, maxHeight: 24 },
  });
}

export default function (pi: ExtensionAPI) {
  // Allow isolated specialist subagents spawned by thin-orchestrator to execute within their scoped tools.
  if (process.env.PI_ORCHESTRATOR_SUBAGENT === "1") return;

  pi.on("tool_call", async (event, ctx) => {
    // Both edit and write always require explicit user approval.
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = String((event.input as { path?: unknown }).path ?? "(unknown file)");

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: "File changes require interactive user approval",
        };
      }

      const approved = await styledConfirm(
        ctx,
        event.toolName === "edit" ? "Approve file edit?" : "Approve file write?",
        [{ type: "text", text: `File: ${path}` }],
        event.toolName === "edit" ? "edit" : "write",
      );

      if (!approved) {
        return {
          block: true,
          reason: "File change rejected by user",
        };
      }
      return;
    }

    // bash: allow-listed commands run directly, everything else is confirmed.
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      const verdict = evaluateCommand(command);

      if (verdict.action === "allow") return;

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Command requires approval (${verdict.title})`,
        };
      }

      const approved = await styledConfirm(
        ctx,
        verdict.title,
        [
          {
            type: "code",
            label: verdict.label,
            segments: splitCommand(command),
          },
        ],
        verdict.kind,
      );

      if (!approved) {
        return {
          block: true,
          reason: "Command rejected by user",
        };
      }
      return;
    }
  });
}
