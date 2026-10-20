/**
 * Thin Orchestrator Extension for Pi
 *
 * Implements Meta's "Thin Orchestrator" architecture (Oct 2026) combined with
 * Google's Harness² on-demand component isolation principles:
 *
 * - Zero domain reasoning in the orchestrator: deterministic routing, pre-checks,
 *   field gathering, workspace auto-discovery, and reliability gates.
 * - Fixed 7-Step Protocol:
 *     1. Read (deterministic)
 *     2. Check (deterministic)
 *     3. Gather (deterministic)
 *     4. Auto-discover (deterministic)
 *     5. Reliability Gate (deterministic)
 *     6. Delegate (ONLY probabilistic LLM step — isolated specialist subprocess)
 *     7. Handle (deterministic post-stage gate verification & result aggregation)
 * - Workflow Templates: deterministic state machines sequencing standardized
 *   specialist subagents (`agents/*.md`) with runtime-loaded knowledge (`knowledge/*.md`).
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	formatReadLineRange,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { autoDiscoverWorkspace, discoverCatalog, formatWorkspaceSummary } from "./discovery.ts";
import { getFinalAssistantText, isStageFailed, runThinOrchestratorProtocol } from "./runner.ts";
import type { AgentScope, OrchestratorDetails, ProtocolStepRecord, StageResult, UsageStats } from "./types.ts";

const COLLAPSED_TOOL_LIMIT = 6;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function aggregateUsage(results: StageResult[]): UsageStats {
	const total: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		if (r.usage.contextTokens > total.contextTokens) {
			total.contextTokens = r.usage.contextTokens;
		}
	}
	return total;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 65 ? `${command.slice(0, 65)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset as number | undefined, args.limit as number | undefined);
			let text = themeFg("accent", filePath);
			if (lineRange) text += themeFg("warning", lineRange);
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function renderProtocolBar(steps: ProtocolStepRecord[], theme: any): string {
	return steps
		.map((s) => {
			const icon =
				s.status === "passed"
					? theme.fg("success", "✓")
					: s.status === "failed"
						? theme.fg("error", "✗")
						: s.status === "running"
							? theme.fg("warning", "⏳")
							: theme.fg("muted", "○");
			const labelColor = s.deterministic ? "dim" : "accent";
			return `${icon}${theme.fg(labelColor, `${s.step}.${s.name}`)}`;
		})
		.join("  ");
}

const ParallelTaskSchema = Type.Object({
	agent: Type.String({ description: "Specialist agent name (e.g., scout, reviewer, verifier)" }),
	task: Type.String({ description: "Scoped task instructions for this specialist" }),
});

const AgentScopeSchema = StringEnum(["builtin", "user", "project", "all"] as const, {
	description: 'Resource discovery scope. Default: "all" (loads builtin + user + project specialists/workflows).',
	default: "all",
});

const ThinOrchestratorParams = Type.Object({
	workflow: Type.Optional(
		Type.String({
			description:
				'Workflow template name to execute deterministically (e.g., "bugfix", "feature", "scout-and-plan", "review-and-fix").',
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				'Single specialist agent name when delegating a single isolated step (e.g., "scout", "planner", "implementer", "verifier", "reviewer").',
		}),
	),
	tasks: Type.Optional(
		Type.Array(ParallelTaskSchema, {
			description: "Array of {agent, task} items to execute concurrently in isolated specialist contexts.",
		}),
	),
	task: Type.String({
		description: "User request or problem statement to route through the workflow or specialist.",
	}),
	fields: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional structured key-value fields gathered for the workflow/specialist.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectResources: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local workflows/specialists in untrusted repos. Default: true.",
			default: true,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// 1. Register the model-callable Thin Orchestrator tool
	pi.registerTool({
		name: "thin_orchestrator",
		label: "Thin Orchestrator",
		exposure: "model-only",
		description: [
			"Deterministic Thin Orchestrator following Meta's 7-Step Protocol (Read -> Check -> Gather -> Auto-discover -> Reliability Gate -> Delegate -> Handle).",
			"Performs zero domain reasoning itself: routes work through deterministic workflow state machines (`workflow`) or isolated domain specialists (`agent` / `tasks`), loading specialist knowledge files on demand at runtime.",
			"Built-in workflows: `bugfix` (scout->planner->implementer->verifier->reviewer), `feature` (scout->planner->implementer->verifier->reviewer), `scout-and-plan` (scout->planner), `review-and-fix` (reviewer->implementer->verifier).",
			"Built-in specialists: `scout`, `planner`, `implementer`, `verifier`, `reviewer`.",
		].join(" "),
		parameters: ThinOrchestratorParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "all";
			const catalog = discoverCatalog(ctx.cwd, agentScope);

			const hasWorkflow = Boolean(params.workflow && params.workflow.trim());
			const hasSingle = Boolean(params.agent && params.agent.trim());
			const hasParallel = Boolean(params.tasks && params.tasks.length > 0);
			const modeCount = Number(hasWorkflow) + Number(hasSingle) + Number(hasParallel);

			if (modeCount !== 1) {
				const wfNames = catalog.workflows.map((w) => w.name).join(", ") || "none";
				const spNames = catalog.specialists.map((s) => s.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one orchestration mode: \`workflow\`, \`agent\`, or \`tasks\`.\n- Available workflows: ${wfNames}\n- Available specialists: ${spNames}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const mode: "workflow" | "single" | "parallel" = hasWorkflow
				? "workflow"
				: hasParallel
					? "parallel"
					: "single";

			return runThinOrchestratorProtocol({
				ctx,
				catalog,
				agentScope,
				mode,
				workflowName: params.workflow?.trim(),
				singleAgentName: params.agent?.trim(),
				parallelTasks: params.tasks,
				task: params.task,
				fields: params.fields ?? {},
				confirmProjectResources: params.confirmProjectResources ?? true,
				signal,
				onUpdate,
			});
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "all";
			const taskPreview = args.task ? (args.task.length > 68 ? `${args.task.slice(0, 68)}...` : args.task) : "...";

			if (args.workflow) {
				const header =
					theme.fg("toolTitle", theme.bold("thin_orchestrator ")) +
					theme.fg("accent", `workflow:${args.workflow}`) +
					theme.fg("muted", ` [${scope}]`);
				return new Text(`${header}\n  ${theme.fg("dim", taskPreview)}`, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				const header =
					theme.fg("toolTitle", theme.bold("thin_orchestrator ")) +
					theme.fg("accent", `parallel (${args.tasks.length} specialists)`) +
					theme.fg("muted", ` [${scope}]`);
				const list = args.tasks
					.slice(0, 3)
					.map((t) => `  • ${theme.fg("accent", t.agent)}: ${theme.fg("dim", t.task.slice(0, 45))}`)
					.join("\n");
				return new Text(`${header}\n${list}`, 0, 0);
			}

			const header =
				theme.fg("toolTitle", theme.bold("thin_orchestrator ")) +
				theme.fg("accent", `specialist:${args.agent || "?"}`) +
				theme.fg("muted", ` [${scope}]`);
			return new Text(`${header}\n  ${theme.fg("dim", taskPreview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as OrchestratorDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const totalStages = details.results.length;
			const completedStages = details.results.filter((r) => r.exitCode !== -1 && !isStageFailed(r)).length;
			const failedStages = details.results.filter((r) => r.exitCode !== -1 && isStageFailed(r)).length;
			const runningStages = details.results.filter((r) => r.exitCode === -1).length;

			const topIcon =
				runningStages > 0
					? theme.fg("warning", "⏳")
					: failedStages > 0 || details.protocolSteps.some((s) => s.status === "failed")
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");

			const titleLabel =
				details.mode === "workflow"
					? `workflow:${details.workflowName}`
					: details.mode === "parallel"
						? `parallel (${totalStages} specialists)`
						: `specialist:${details.results[0]?.agent ?? "single"}`;

			const headerLine =
				`${topIcon} ${theme.fg("toolTitle", theme.bold("thin_orchestrator "))}` +
				`${theme.fg("accent", titleLabel)} ` +
				`${theme.fg("muted", `[${completedStages}/${totalStages} stages]`)}`;

			const protocolLine = renderProtocolBar(details.protocolSteps, theme);

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(headerLine, 0, 0));
				container.addChild(new Text(`  ${protocolLine}`, 0, 0));

				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── 7-Step Protocol Audit ───"), 0, 0));
				for (const s of details.protocolSteps) {
					const sIcon =
						s.status === "passed"
							? theme.fg("success", "✓")
							: s.status === "failed"
								? theme.fg("error", "✗")
								: s.status === "running"
									? theme.fg("warning", "⏳")
									: theme.fg("muted", "○");
					const kindTag = s.deterministic ? theme.fg("muted", "[DET]") : theme.fg("accent", "[LLM]");
					const dur = s.durationMs !== undefined ? theme.fg("dim", ` (${s.durationMs}ms)`) : "";
					container.addChild(
						new Text(`  ${sIcon} ${s.step}. ${theme.bold(s.name)} ${kindTag}: ${theme.fg("dim", s.summary)}${dur}`, 0, 0),
					);
				}

				for (const r of details.results) {
					const rFailed = r.exitCode !== -1 && isStageFailed(r);
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: rFailed
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");

					const kBadge =
						r.knowledgeLoaded.length > 0
							? theme.fg("muted", ` +knowledge:[${r.knowledgeLoaded.join(", ")}]`)
							: "";
					const gateBadge = r.gateCmd
						? r.gatePassed
							? theme.fg("success", ` [GATE PASS: ${r.gateCmd}]`)
							: theme.fg("error", ` [GATE FAIL: ${r.gateCmd}]`)
						: "";
					const retryBadge = r.attempts > 1 ? theme.fg("warning", ` (attempt ${r.attempts})`) : "";

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							`${theme.fg("muted", `─── Stage ${r.stepIndex} (${r.stepId}): `)}${theme.fg("accent", r.agent)} ${rIcon}${retryBadge}${kBadge}${gateBadge}`,
							0,
							0,
						),
					);

					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalAssistantText(r.messages);

					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(`  ${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`, 0, 0),
							);
						}
					}

					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					} else if (rFailed && r.stderr) {
						container.addChild(new Text(theme.fg("error", r.stderr.trim()), 0, 0));
					}

					const stageUsage = formatUsageStats(r.usage, r.model);
					if (stageUsage) {
						container.addChild(new Text(theme.fg("dim", `  ${stageUsage}`), 0, 0));
					}
				}

				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total Telemetry: ${totalUsage}`), 0, 0));
				}
				return container;
			}

			// Collapsed View
			let text = `${headerLine}\n  ${protocolLine}`;

			for (const r of details.results) {
				const rFailed = r.exitCode !== -1 && isStageFailed(r);
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: rFailed
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const kCount =
					r.knowledgeLoaded.length > 0 ? theme.fg("muted", ` (${r.knowledgeLoaded.length} knowledge file(s))`) : "";
				const gateBadge = r.gateCmd
					? r.gatePassed
						? theme.fg("success", " [GATE✓]")
						: theme.fg("error", " [GATE✗]")
					: "";

				text += `\n\n${theme.fg("muted", `─── ${r.stepIndex}. ${r.stepId} → `)}${theme.fg("accent", r.agent)} ${rIcon}${kCount}${gateBadge}`;

				const displayItems = getDisplayItems(r.messages);
				if (displayItems.length === 0) {
					text += `\n  ${theme.fg("muted", r.exitCode === -1 ? "(running in isolated context...)" : "(no tool calls)")}`;
				} else {
					const recent = displayItems.slice(-COLLAPSED_TOOL_LIMIT);
					if (displayItems.length > COLLAPSED_TOOL_LIMIT) {
						text += `\n  ${theme.fg("muted", `... ${displayItems.length - COLLAPSED_TOOL_LIMIT} earlier items`)}`;
					}
					for (const item of recent) {
						if (item.type === "toolCall") {
							text += `\n  ${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
						} else {
							const firstLine = item.text.split("\n")[0]?.slice(0, 90) || "";
							text += `\n  ${theme.fg("toolOutput", firstLine)}`;
						}
					}
				}
			}

			const totalUsage = formatUsageStats(aggregateUsage(details.results));
			if (totalUsage) {
				text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
			}
			text += `\n${theme.fg("muted", "(Ctrl+O to expand full 7-step audit & specialist outputs)")}`;
			return new Text(text, 0, 0);
		},
	});

	// 2. Register deterministic `/orchestrate` slash command
	pi.registerCommand("orchestrate", {
		description:
			"Run or inspect Meta Thin Orchestrator workflows (/orchestrate [list | <workflow> <task>])",
		handler: async (rawArgs, ctx) => {
			const catalog = discoverCatalog(ctx.cwd, "all");
			const trimmed = (rawArgs || "").trim();

			if (trimmed === "list" || trimmed === "ls" || trimmed === "status") {
				const ws = autoDiscoverWorkspace(ctx.cwd);
				const wfLines = catalog.workflows
					.map((w) => {
						const chainStr = w.steps.map((s) => s.agent).join(" → ");
						return `- **\`${w.name}\`** (${w.source}): ${w.description}\n  Pipeline: \`${chainStr}\``;
					})
					.join("\n");
				const spLines = catalog.specialists
					.map((s) => {
						const toolsStr = s.tools ? s.tools.join(", ") : "default";
						const kStr = s.knowledgeFiles.length > 0 ? s.knowledgeFiles.join(", ") : "none";
						return `- **\`${s.name}\`** (${s.source}) — ${s.description}\n  Tools: \`[${toolsStr}]\` | Runtime Knowledge: \`[${kStr}]\``;
					})
					.join("\n");

				const summary = [
					"## Thin Orchestrator Catalog",
					"",
					"### Workspace Auto-Discovery (Step 4)",
					formatWorkspaceSummary(ws),
					"",
					`### Workflow Templates (${catalog.workflows.length})`,
					wfLines || "(none)",
					"",
					`### Specialist Subagents (${catalog.specialists.length})`,
					spLines || "(none)",
				].join("\n");

				pi.sendMessage({
					customType: "thin-orchestrator-catalog",
					content: summary,
					display: true,
				});
				return;
			}

			let selectedWorkflow = "";
			let taskText = "";

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /orchestrate <workflow> <task> | /orchestrate list", "warning");
					return;
				}
				const options = catalog.workflows.map(
					(w) => `${w.name} — ${w.steps.map((s) => s.agent).join(" → ")} (${w.description})`,
				);
				const choice = await ctx.ui.select("Select Thin Orchestrator Workflow Template", options);
				if (!choice) return;
				selectedWorkflow = choice.split(" — ")[0].trim();

				const inputTask = await ctx.ui.input(
					`Workflow: ${selectedWorkflow}`,
					"Describe the task to execute:",
				);
				if (!inputTask || !inputTask.trim()) return;
				taskText = inputTask.trim();
			} else {
				const firstSpace = trimmed.indexOf(" ");
				if (firstSpace === -1) {
					const matchedWf = catalog.workflows.find((w) => w.name === trimmed);
					if (matchedWf && ctx.hasUI) {
						selectedWorkflow = matchedWf.name;
						const inputTask = await ctx.ui.input(
							`Workflow: ${selectedWorkflow}`,
							"Describe the task to execute:",
						);
						if (!inputTask || !inputTask.trim()) return;
						taskText = inputTask.trim();
					} else {
						ctx.ui.notify(
							`Usage: /orchestrate <workflow> <task> (available: ${catalog.workflows.map((w) => w.name).join(", ")})`,
							"warning",
						);
						return;
					}
				} else {
					selectedWorkflow = trimmed.slice(0, firstSpace).trim();
					taskText = trimmed.slice(firstSpace + 1).trim();
				}
			}

			// Dispatch a concise routing directive so the turn executes `thin_orchestrator` directly
			pi.sendUserMessage(
				`Call \`thin_orchestrator\` with workflow="${selectedWorkflow}" and task=${JSON.stringify(taskText)}. Do not perform domain exploration yourself; let the thin_orchestrator workflow handle all stages.`,
			);
		},
	});
}
