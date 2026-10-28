import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	autoDiscoverWorkspace,
	formatWorkspaceSummary,
	loadRuntimeKnowledgeFiles,
	type OrchestratorCatalog,
	resolveSpecialistSkills,
} from "./discovery.ts";
import type {
	AgentScope,
	FieldPrompt,
	OrchestratorDetails,
	ProtocolStepRecord,
	SpecialistAgent,
	StageResult,
	WorkflowStep,
	WorkflowTemplate,
	WorkspaceDiscovery,
} from "./types.ts";

export type OnOrchestratorUpdate = (partial: AgentToolResult<OrchestratorDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export function createInitialProtocolSteps(): ProtocolStepRecord[] {
	return [
		{ step: 1, name: "Read", deterministic: true, status: "pending", summary: "Load specialist specs & workflow template" },
		{ step: 2, name: "Check", deterministic: true, status: "pending", summary: "Run pre-flight duplicate/conflict checks" },
		{ step: 3, name: "Gather", deterministic: true, status: "pending", summary: "Verify required fields before delegation" },
		{ step: 4, name: "Auto-discover", deterministic: true, status: "pending", summary: "Infer repo, stack, and modified files" },
		{ step: 5, name: "Reliability Gate", deterministic: true, status: "pending", summary: "Enforce trust & pre-execution gates" },
		{ step: 6, name: "Delegate", deterministic: false, status: "pending", summary: "Execute isolated specialist subagent(s)" },
		{ step: 7, name: "Handle", deterministic: true, status: "pending", summary: "Verify post-stage gates & surface results" },
	];
}

export function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

/**
 * Read the specialist's self-reported `GATE_STATUS: PASS|FAIL` verdict from its final message.
 *
 * Only a LINE-ANCHORED verdict counts, and the LAST one wins. This prevents a specialist that
 * merely quotes the reporting contract (`ending with GATE_STATUS: PASS or GATE_STATUS: FAIL`)
 * from being misread as a failure.
 */
export function getReportedGateStatus(messages: Message[]): "PASS" | "FAIL" | null {
	const text = getFinalAssistantText(messages);
	if (!text) return null;
	const matches = Array.from(text.matchAll(/^[ \t>*_`-]*GATE_STATUS[ \t]*:[ \t]*[*_`\s]*(PASS|FAIL)\b/gim));
	if (matches.length === 0) return null;
	return matches[matches.length - 1]![1]!.toUpperCase() as "PASS" | "FAIL";
}

export function isStageFailed(stage: StageResult): boolean {
	if (stage.exitCode !== 0 || stage.stopReason === "error" || stage.stopReason === "aborted") {
		return true;
	}
	if (stage.gateCmd && stage.gatePassed === false) {
		return true;
	}
	// A specialist that advertises an explicit verdict (e.g. the verifier) must not be overridden
	// by an exit code of 0: `GATE_STATUS: FAIL` is a real failure even when the process exited cleanly.
	const reported = stage.reportedGateStatus ?? getReportedGateStatus(stage.messages);
	if (reported === "FAIL") {
		return true;
	}
	return false;
}

export function getStageOutput(stage: StageResult): string {
	if (isStageFailed(stage)) {
		if (stage.exitCode !== 0 || stage.stopReason === "error" || stage.stopReason === "aborted") {
			return stage.errorMessage || stage.stderr || getFinalAssistantText(stage.messages) || `Process exited with code ${stage.exitCode}`;
		}
		if (stage.gateCmd && stage.gatePassed === false) {
			return `Gate failed (${stage.gateCmd}):\n${stage.gateOutput || "(no gate output)"}`;
		}
		if (getReportedGateStatus(stage.messages) === "FAIL") {
			return `Specialist reported GATE_STATUS: FAIL\n\n${getFinalAssistantText(stage.messages)}`;
		}
		return stage.errorMessage || stage.stderr || getFinalAssistantText(stage.messages) || "(no output)";
	}
	return getFinalAssistantText(stage.messages) || "(no output)";
}

/**
 * Replace every known secret value with `***`. Used on anything that is displayed, aggregated,
 * or handed to another specialist — never on the prompt that is actually spawned.
 */
export function redactSecrets(text: string, secretValues?: string[]): string {
	if (!secretValues || secretValues.length === 0) return text;
	let out = text;
	for (const value of secretValues) {
		if (value && value.length >= 4) out = out.split(value).join("***");
	}
	return out;
}

/**
 * Deterministic shell check helper used for Step 2 (Pre-Check) and Step 5/7 (Reliability Gate).
 */
export function runDeterministicShellCheck(
	command: string,
	cwd: string,
	timeoutMs = 30_000,
): { passed: boolean; output: string } {
	try {
		const stdout = execSync(command, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
		return { passed: true, output: stdout.trim() };
	} catch (err: any) {
		const stdout = typeof err?.stdout === "string" ? err.stdout : "";
		const stderr = typeof err?.stderr === "string" ? err.stderr : "";
		const combined = [stdout.trim(), stderr.trim(), err?.message || "Command failed"].filter(Boolean).join("\n");
		return { passed: false, output: combined.slice(0, 4000) };
	}
}

async function writeIsolatedPromptToTempFile(
	agentName: string,
	promptContent: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-thin-orch-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `specialist-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, promptContent, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Interpolate deterministic placeholders into a stage's task prompt.
 */
export function renderTaskTemplate(
	template: string,
	opts: {
		task: string;
		previous: string;
		stepOutputs: Map<string, string>;
		workspace: WorkspaceDiscovery;
		fields: Record<string, string>;
		gateError?: string;
	},
): string {
	let rendered = template
		.replace(/\{task\}/g, opts.task)
		.replace(/\{previous\}/g, opts.previous || "(none)")
		.replace(/\{workspace\}/g, formatWorkspaceSummary(opts.workspace))
		.replace(/\{gate_error\}/g, opts.gateError || "");

	rendered = rendered.replace(/\{step:([a-zA-Z0-9_-]+)\}/g, (_match, stepId: string) => {
		return opts.stepOutputs.get(stepId) ?? "(not available)";
	});

	rendered = rendered.replace(/\{field:([a-zA-Z0-9_-]+)\}/g, (_match, key: string) => {
		return opts.fields[key] ?? "(unspecified)";
	});

	if (opts.gateError && !template.includes("{gate_error}")) {
		rendered += `\n\n## Previous Attempt Gate Failure (Must Fix)\n\`\`\`\n${opts.gateError}\n\`\`\``;
	}

	return rendered;
}

/**
 * Step 6 (Delegate) executor signature. Exposed as an injection seam so the sequential state
 * machine (in particular repair loops) can be driven deterministically without spawning
 * real specialist subprocesses.
 */
export type StageExecutor = (opts: {
	cwd: string;
	projectConfigDir: string | null;
	dispatchDefaults: DispatchDefaults;
	specialist: SpecialistAgent;
	stepIndex: number;
	stepId: string;
	taskPrompt: string;
	gateCmd?: string;
	gateTimeoutMs?: number;
	attempt: number;
	signal?: AbortSignal;
	onProgress?: (currentStage: StageResult) => void;
	/** Secret field values to redact from the stored/audited copy of the prompt. */
	secretValues?: string[];
}) => Promise<StageResult>;

/**
 * Step 6 (Delegate): Spawn an isolated specialist `pi` subprocess with only its domain knowledge loaded.
 */
export async function executeSpecialistStage(opts: {
	cwd: string;
	projectConfigDir: string | null;
	dispatchDefaults: DispatchDefaults;
	specialist: SpecialistAgent;
	stepIndex: number;
	stepId: string;
	taskPrompt: string;
	gateCmd?: string;
	gateTimeoutMs?: number;
	attempt: number;
	signal?: AbortSignal;
	onProgress?: (currentStage: StageResult) => void;
	secretValues?: string[];
}): Promise<StageResult> {
	const {
		cwd,
		projectConfigDir,
		dispatchDefaults,
		specialist,
		stepIndex,
		stepId,
		taskPrompt,
		gateCmd,
		gateTimeoutMs,
		attempt,
		signal,
		onProgress,
		secretValues,
	} = opts;

	// Load domain knowledge files on demand at runtime (never in main orchestrator context)
	const { loadedPaths, combinedMarkdown } = loadRuntimeKnowledgeFiles(specialist, cwd, projectConfigDir);
	const resolvedSkillDirs = resolveSpecialistSkills(specialist, cwd, projectConfigDir);
	const fullSystemPrompt = `${specialist.systemPrompt}${combinedMarkdown}`.trim();

	// Isolate the specialist subprocess context:
	// - Keep extensions enabled so custom model providers (e.g. npm:pi-antigravity, npm:pi-provider-qoder) load normally.
	// - Set `PI_ORCHESTRATOR_SUBAGENT=1` in child env so interactive-only approval guards (`confirm-edit-only.ts`) do not deadlock headless `--mode json -p` runs.
	// - `-ns`: disable global skills by default (only explicit `--skill` mounts below are loaded).
	// - `-nc`: disable global AGENTS.md/CLAUDE.md context files so only the specialist's domain knowledge enters context.
	const args: string[] = ["--mode", "json", "-p", "--no-session", "-ns", "-nc"];
	for (const skillDir of resolvedSkillDirs) {
		args.push("--skill", skillDir);
	}
	const inheritsDispatchConfig = !specialist.model;
	const model = specialist.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (specialist.tools && specialist.tools.length > 0) {
		args.push("--tools", specialist.tools.join(","));
	}

	const stageResult: StageResult = {
		stepIndex,
		stepId,
		agent: specialist.name,
		agentSource: specialist.source,
		// The live prompt is spawned as-is; the audited copy is redacted so plaintext credentials
		// gathered at Step 3 never surface in the TUI audit or the tool result.
		task: redactSecrets(taskPrompt, secretValues),
		knowledgeLoaded: [
			...loadedPaths,
			...specialist.skills.map((s) => `skill:${s}`),
		],
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		attempts: attempt,
		gateCmd: gateCmd ?? specialist.postGateCmd,
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		if (fullSystemPrompt) {
			const tmp = await writeIsolatedPromptToTempFile(specialist.name, fullSystemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(taskPrompt);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				env: {
					...process.env,
					PI_ORCHESTRATOR_SUBAGENT: "1",
				},
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					stageResult.messages.push(msg);

					if (msg.role === "assistant") {
						stageResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							stageResult.usage.input += usage.input || 0;
							stageResult.usage.output += usage.output || 0;
							stageResult.usage.cacheRead += usage.cacheRead || 0;
							stageResult.usage.cacheWrite += usage.cacheWrite || 0;
							stageResult.usage.cost += usage.cost?.total || 0;
							stageResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!stageResult.model && msg.model) stageResult.model = msg.model;
						if (msg.stopReason) stageResult.stopReason = msg.stopReason;
						if (msg.errorMessage) stageResult.errorMessage = msg.errorMessage;
					}
					onProgress?.(stageResult);
				}

				if (event.type === "tool_result_end" && event.message) {
					stageResult.messages.push(event.message as Message);
					onProgress?.(stageResult);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stageResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		stageResult.exitCode = exitCode;
		if (wasAborted) {
			stageResult.stopReason = "aborted";
			throw new Error("Specialist subagent was aborted");
		}

		// Deterministic post-stage reliability gate check
		stageResult.reportedGateStatus = getReportedGateStatus(stageResult.messages) ?? undefined;
		const effectiveGate = stageResult.gateCmd;
		if (effectiveGate && exitCode === 0 && stageResult.stopReason !== "error") {
			const gateRes = runDeterministicShellCheck(effectiveGate, cwd, gateTimeoutMs);
			stageResult.gatePassed = gateRes.passed;
			stageResult.gateOutput = gateRes.output;
		} else if (effectiveGate) {
			stageResult.gatePassed = false;
		}

		return stageResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// ignore
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				// ignore
			}
		}
	}
}

/**
 * Render the allowed values for enumerated (selector-backed) gather fields, so a headless caller
 * knows exactly which strings are accepted instead of guessing.
 */
function renderAllowedFieldValues(missingFields: string[], fieldPrompts: Record<string, FieldPrompt>): string {
	const lines = missingFields
		.filter((f) => fieldPrompts[f]?.options?.length)
		.map((f) => `- \`${f}\`: ${fieldPrompts[f]!.options!.map((o) => `"${o}"`).join(" | ")}`);
	return lines.length > 0 ? `\n\nAllowed values:\n${lines.join("\n")}` : "";
}

/**
 * Execute Meta's full 7-Step Thin Orchestrator Protocol for a workflow or single/parallel specialist delegation.
 */
export async function runThinOrchestratorProtocol(opts: {
	ctx: ExtensionContext;
	catalog: OrchestratorCatalog;
	agentScope: AgentScope;
	mode: "workflow" | "single" | "parallel";
	workflowName?: string;
	singleAgentName?: string;
	parallelTasks?: Array<{ agent: string; task: string }>;
	task: string;
	fields: Record<string, string>;
	confirmProjectResources: boolean;
	signal?: AbortSignal;
	onUpdate?: OnOrchestratorUpdate;
	/** Test/debug seam: override how a single specialist stage is executed (defaults to a real subprocess). */
	stageExecutor?: StageExecutor;
}): Promise<AgentToolResult<OrchestratorDetails>> {
	const {
		ctx,
		catalog,
		agentScope,
		mode,
		workflowName,
		singleAgentName,
		parallelTasks,
		task,
		fields,
		confirmProjectResources,
		signal,
		onUpdate,
	} = opts;

	const protocolSteps = createInitialProtocolSteps();
	const results: StageResult[] = [];
	let workspace: WorkspaceDiscovery | undefined;

	const makeDetails = (): OrchestratorDetails => ({
		mode,
		workflowName,
		task,
		agentScope,
		workspace,
		protocolSteps: protocolSteps.map((s) => ({ ...s })),
		results: [...results],
	});

	const emitProgress = (statusText: string) => {
		onUpdate?.({
			content: [{ type: "text", text: statusText }],
			details: makeDetails(),
		});
	};

	const executeStage: StageExecutor = opts.stageExecutor ?? executeSpecialistStage;

	const dispatchDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};

	// =========================================================================
	// STEP 1: READ (Deterministic) — Resolve workflow template & specialist specs
	// =========================================================================
	const t1 = Date.now();
	protocolSteps[0].status = "running";
	let resolvedSteps: WorkflowStep[] = [];
	let resolvedWorkflow: WorkflowTemplate | undefined;
	const referencedSpecialists = new Map<string, SpecialistAgent>();

	if (mode === "workflow") {
		resolvedWorkflow = catalog.workflows.find((w) => w.name === workflowName);
		if (!resolvedWorkflow) {
			const available = catalog.workflows.map((w) => w.name).join(", ") || "none";
			protocolSteps[0].status = "failed";
			protocolSteps[0].summary = `Unknown workflow "${workflowName}". Available: ${available}`;
			return {
				content: [{ type: "text", text: `[Step 1 Read Failed] Unknown workflow "${workflowName}". Available workflows: ${available}` }],
				details: makeDetails(),
				isError: true,
			};
		}
		resolvedSteps = resolvedWorkflow.steps;
	} else if (mode === "single") {
		if (!singleAgentName) {
			protocolSteps[0].status = "failed";
			protocolSteps[0].summary = "Missing specialist agent name";
			return {
				content: [{ type: "text", text: "[Step 1 Read Failed] Missing `agent` parameter for single mode." }],
				details: makeDetails(),
				isError: true,
			};
		}
		resolvedSteps = [
			{
				id: "step_1",
				agent: singleAgentName,
				taskTemplate: "## Workspace Auto-Discovery\n{workspace}\n\n## Task\n{task}",
				maxRetries: 1,
			},
		];
	} else if (mode === "parallel") {
		if (!parallelTasks || parallelTasks.length === 0) {
			protocolSteps[0].status = "failed";
			protocolSteps[0].summary = "Missing parallel tasks array";
			return {
				content: [{ type: "text", text: "[Step 1 Read Failed] Missing `tasks` array for parallel mode." }],
				details: makeDetails(),
				isError: true,
			};
		}
		resolvedSteps = parallelTasks.map((pt, idx) => ({
			id: `parallel_${idx + 1}`,
			agent: pt.agent,
			taskTemplate: `## Workspace Auto-Discovery\n{workspace}\n\n## Task\n${pt.task}`,
			maxRetries: 0,
		}));
	}

	for (const step of resolvedSteps) {
		const spec = catalog.specialists.find((s) => s.name === step.agent);
		if (!spec) {
			const available = catalog.specialists.map((s) => s.name).join(", ") || "none";
			protocolSteps[0].status = "failed";
			protocolSteps[0].summary = `Unknown specialist "${step.agent}" in step "${step.id}"`;
			return {
				content: [
					{
						type: "text",
						text: `[Step 1 Read Failed] Unknown specialist agent "${step.agent}" referenced in "${step.id}". Available specialists: ${available}`,
					},
				],
				details: makeDetails(),
				isError: true,
			};
		}
		referencedSpecialists.set(spec.name, spec);
	}

	// Deterministic workflow integrity checks: unique step ids, and repair loops that can only
	// jump backwards (forward jumps would silently create infinite/undefined execution orders).
	switch (mode) {
		case "workflow": {
			const seenStepIds = new Set<string>();
			for (const step of resolvedSteps) {
				if (seenStepIds.has(step.id)) {
					protocolSteps[0].status = "failed";
					protocolSteps[0].summary = `Duplicate step id "${step.id}" in workflow "${workflowName}"`;
					return {
						content: [
							{
								type: "text",
								text: `[Step 1 Read Failed] Duplicate step id "${step.id}" in workflow "${workflowName}". Step ids must be unique because they are referenced by \`{step:<id>}\` placeholders and \`onGateFail.retryFrom\`.`,
							},
						],
						details: makeDetails(),
						isError: true,
					};
				}
				seenStepIds.add(step.id);
			}

			for (let i = 0; i < resolvedSteps.length; i++) {
				const step = resolvedSteps[i]!;
				const directive = step.onGateFail;
				if (!directive) continue;
				const targetIndex = resolvedSteps.findIndex((s) => s.id === directive.retryFrom);
				if (targetIndex < 0 || targetIndex >= i) {
					protocolSteps[0].status = "failed";
					protocolSteps[0].summary = `Invalid onGateFail.retryFrom "${directive.retryFrom}" on step "${step.id}"`;
					return {
						content: [
							{
								type: "text",
								text: `[Step 1 Read Failed] Step "${step.id}" declares \`onGateFail.retryFrom: "${directive.retryFrom}"\`, which must reference an EARLIER step in the same workflow. Earlier step ids: ${resolvedSteps
									.slice(0, i)
									.map((s) => `\`${s.id}\``)
									.join(", ") || "(none)"}.`,
							},
						],
						details: makeDetails(),
						isError: true,
					};
				}
			}
			break;
		}
		case "single":
		case "parallel":
			break;
	}

	const totalKnowledgeFiles = Array.from(referencedSpecialists.values()).reduce(
		(acc, s) => acc + s.knowledgeFiles.length,
		0,
	);
	protocolSteps[0].status = "passed";
	protocolSteps[0].durationMs = Date.now() - t1;
	protocolSteps[0].summary = `Loaded ${resolvedSteps.length} stage(s), ${referencedSpecialists.size} specialist(s), ${totalKnowledgeFiles} runtime knowledge ref(s)`;
	emitProgress("Step 1/7 (Read) complete...");

	// =========================================================================
	// STEP 2: CHECK (Deterministic) — Pre-flight checks before LLM execution
	// =========================================================================
	const t2 = Date.now();
	protocolSteps[1].status = "running";
	const preChecks = [
		...(resolvedWorkflow?.preChecks ?? []),
		...Array.from(referencedSpecialists.values())
			.map((s) => s.preCheckCmd)
			.filter((cmd): cmd is string => Boolean(cmd)),
	];

	if (preChecks.length === 0) {
		protocolSteps[1].status = "passed";
		protocolSteps[1].durationMs = Date.now() - t2;
		protocolSteps[1].summary = "Workspace exists; no blocking pre-checks configured";
	} else {
		for (const checkCmd of preChecks) {
			const checkRes = runDeterministicShellCheck(checkCmd, ctx.cwd);
			if (!checkRes.passed) {
				protocolSteps[1].status = "failed";
				protocolSteps[1].durationMs = Date.now() - t2;
				protocolSteps[1].summary = `Pre-check failed: ${checkCmd}`;
				return {
					content: [
						{
							type: "text",
							text: `[Step 2 Check Failed] Deterministic pre-flight check failed before LLM invocation:\nCommand: \`${checkCmd}\`\nOutput:\n${checkRes.output}`,
						},
					],
					details: makeDetails(),
					isError: true,
				};
			}
		}
		protocolSteps[1].status = "passed";
		protocolSteps[1].durationMs = Date.now() - t2;
		protocolSteps[1].summary = `Passed ${preChecks.length} deterministic pre-check(s)`;
	}
	emitProgress("Step 2/7 (Check) complete...");

	// =========================================================================
	// STEP 3: GATHER (Deterministic) — Ensure all required fields are present
	// =========================================================================
	const t3 = Date.now();
	protocolSteps[2].status = "running";
	const requiredFieldNames = new Set<string>(resolvedWorkflow?.requiredFields ?? []);
	for (const spec of referencedSpecialists.values()) {
		for (const reqField of spec.requiredFields) requiredFieldNames.add(reqField);
	}

	const gatheredFields: Record<string, string> = { ...fields };
	if (task.trim() && !gatheredFields.task) {
		gatheredFields.task = task.trim();
	}

	const missingFields: string[] = [];
	const fieldPrompts = resolvedWorkflow?.fieldPrompts ?? {};
	let promptedFieldCount = 0;

	for (const fieldName of requiredFieldNames) {
		if (gatheredFields[fieldName] && gatheredFields[fieldName].trim()) continue;

		const fieldPrompt = fieldPrompts[fieldName];
		const dialogTitle = fieldPrompt?.title ?? `[Thin Orchestrator] Required field "${fieldName}"`;

		if (ctx.hasUI) {
			if (fieldPrompt?.options?.length) {
				// Deterministic choice list: no free-text ambiguity for enumerated decisions
				// (e.g. required request headers vs JWT token).
				const picked = await ctx.ui.select(dialogTitle, fieldPrompt.options);
				if (picked && picked.trim()) {
					gatheredFields[fieldName] = picked.trim();
					promptedFieldCount++;
					continue;
				}
			} else {
				const userVal = await ctx.ui.input(
					dialogTitle,
					fieldPrompt?.placeholder ?? `Enter value for "${fieldName}" before delegating:`,
				);
				if (userVal && userVal.trim()) {
					gatheredFields[fieldName] = userVal.trim();
					promptedFieldCount++;
					continue;
				}
			}
		}

		// Non-interactive runs (print/json/isolated subagents) fall back to the declared default.
		if (fieldPrompt?.default) {
			gatheredFields[fieldName] = fieldPrompt.default;
			continue;
		}
		missingFields.push(fieldName);
	}

	if (missingFields.length > 0) {
		protocolSteps[2].status = "failed";
		protocolSteps[2].durationMs = Date.now() - t3;
		protocolSteps[2].summary = `Missing required field(s): ${missingFields.join(", ")}`;
		return {
			content: [
				{
					type: "text",
					text: `[Step 3 Gather Blocked] Missing required field(s): ${missingFields.join(", ")}. Provide them in \`fields\` before running.${renderAllowedFieldValues(missingFields, fieldPrompts)}`,
				},
			],
			details: makeDetails(),
			isError: true,
		};
	}

	protocolSteps[2].status = "passed";
	protocolSteps[2].durationMs = Date.now() - t3;
	protocolSteps[2].summary =
		requiredFieldNames.size > 0
			? `Verified ${requiredFieldNames.size} required field(s): ${Array.from(requiredFieldNames).join(", ")}${
					promptedFieldCount > 0 ? ` (${promptedFieldCount} collected interactively)` : ""
				}`
			: "Core task input verified";
	emitProgress("Step 3/7 (Gather) complete...");

	// Secret fields (e.g. a plaintext API token) must never appear in the audit trail, the
	// progress stream, downstream specialist prompts, or the aggregated tool result.
	const secretValues = Array.from(
		new Set(
			Object.entries(fieldPrompts)
				.filter(([, prompt]) => prompt.secret)
				.map(([name]) => gatheredFields[name])
				.filter((v): v is string => Boolean(v && v.length >= 4)),
		),
	);
	const redact = (text: string) => redactSecrets(text, secretValues);

	// =========================================================================
	// STEP 4: AUTO-DISCOVER (Deterministic) — Zero-LLM environment discovery
	// =========================================================================
	const t4 = Date.now();
	protocolSteps[3].status = "running";
	workspace = autoDiscoverWorkspace(ctx.cwd);
	protocolSteps[3].status = "passed";
	protocolSteps[3].durationMs = Date.now() - t4;
	protocolSteps[3].summary = `Repo: ${workspace.repoName} [${workspace.languageStack.join("/")}] branch=${workspace.gitBranch ?? "none"} (${workspace.gitDirtyFiles.length} dirty)`;
	emitProgress("Step 4/7 (Auto-discover) complete...");

	// =========================================================================
	// STEP 5: RELIABILITY GATE (Deterministic) — Trust & safety verification
	// =========================================================================
	const t5 = Date.now();
	protocolSteps[4].status = "running";
	const hasProjectResources =
		resolvedWorkflow?.source === "project" ||
		Array.from(referencedSpecialists.values()).some((s) => s.source === "project");

	if (hasProjectResources && confirmProjectResources && ctx.hasUI && !ctx.isProjectTrusted()) {
		const approved = await ctx.ui.confirm(
			"Thin Orchestrator Reliability Gate",
			`Workflow uses project-local definitions from ${catalog.projectConfigDir ?? ".pi"}. Approve execution?`,
		);
		if (!approved) {
			protocolSteps[4].status = "failed";
			protocolSteps[4].durationMs = Date.now() - t5;
			protocolSteps[4].summary = "Canceled at project trust gate";
			return {
				content: [{ type: "text", text: "[Step 5 Reliability Gate] Execution canceled by user at project trust gate." }],
				details: makeDetails(),
				isError: true,
			};
		}
	}

	protocolSteps[4].status = "passed";
	protocolSteps[4].durationMs = Date.now() - t5;
	protocolSteps[4].summary = "Pre-delegation safety & scope gates passed";
	emitProgress("Step 5/7 (Reliability Gate) passed. Delegating to specialists...");

	// =========================================================================
	// STEP 6: DELEGATE (Probabilistic LLM in Isolated Subagent Contexts)
	// =========================================================================
	const t6 = Date.now();
	protocolSteps[5].status = "running";
	const stepOutputs = new Map<string, string>();
	let previousOutput = "";
	let totalLoopBacks = 0;

	if (mode === "parallel") {
		const placeholders: StageResult[] = resolvedSteps.map((step, i) => {
			const spec = referencedSpecialists.get(step.agent)!;
			return {
				stepIndex: i + 1,
				stepId: step.id,
				agent: spec.name,
				agentSource: spec.source,
				task: step.taskTemplate,
				knowledgeLoaded: spec.knowledgeFiles,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				attempts: 1,
			};
		});
		results.push(...placeholders);

		const concurrency = Math.min(4, resolvedSteps.length);
		let nextIdx = 0;
		const workers = new Array(concurrency).fill(null).map(async () => {
			while (true) {
				const idx = nextIdx++;
				if (idx >= resolvedSteps.length) return;
				const step = resolvedSteps[idx];
				const spec = referencedSpecialists.get(step.agent)!;
				const renderedTask = renderTaskTemplate(step.taskTemplate, {
					task,
					previous: "",
					stepOutputs,
					workspace: workspace!,
					fields: gatheredFields,
				});

				const stageRes = await executeStage({
					cwd: ctx.cwd,
					projectConfigDir: catalog.projectConfigDir,
					dispatchDefaults,
					specialist: spec,
					stepIndex: idx + 1,
					stepId: step.id,
					taskPrompt: renderedTask,
					gateCmd: step.gateCmd,
					gateTimeoutMs: step.gateTimeoutMs,
					attempt: 1,
					secretValues,
					signal,
					onProgress: (current) => {
						results[idx] = current;
						const doneCount = results.filter((r) => r.exitCode !== -1).length;
						emitProgress(`Step 6/7 (Delegate Parallel): ${doneCount}/${results.length} specialists finished...`);
					},
				});
				results[idx] = stageRes;
				emitProgress(`Step 6/7 (Delegate Parallel): ${results.filter((r) => r.exitCode !== -1).length}/${results.length} finished`);
			}
		});
		await Promise.all(workers);
	} else {
		// Sequential workflow state machine or single specialist
		const stepIndexById = new Map(resolvedSteps.map((s, idx) => [s.id, idx]));
		// Deterministic repair loops: failure text handed to the next run of a stage.
		const pendingFeedback = new Map<string, string>();
		const loopBacksUsed = new Map<string, number>();
		let cursor = 0;

		while (cursor < resolvedSteps.length) {
			const step = resolvedSteps[cursor]!;
			const spec = referencedSpecialists.get(step.agent)!;
			const position = cursor;
			const maxRetries = step.maxRetries ?? 1;
			let attempt = 0;
			let gateError = pendingFeedback.get(step.id);
			pendingFeedback.delete(step.id);
			const isRepairPass = gateError !== undefined;
			let finalStageResult: StageResult | undefined;

			while (attempt <= maxRetries) {
				attempt++;
				const renderedTask = renderTaskTemplate(step.taskTemplate, {
					task,
					previous: previousOutput,
					stepOutputs,
					workspace: workspace!,
					fields: gatheredFields,
					gateError,
				});

				const stageRes = await executeStage({
					cwd: ctx.cwd,
					projectConfigDir: catalog.projectConfigDir,
					dispatchDefaults,
					specialist: spec,
					stepIndex: position + 1,
					stepId: step.id,
					taskPrompt: renderedTask,
					gateCmd: step.gateCmd,
					gateTimeoutMs: step.gateTimeoutMs,
					attempt,
					secretValues,
					signal,
					onProgress: (current) => {
						results[position] = current;
						emitProgress(
							`Step 6/7 (Delegate [${position + 1}/${resolvedSteps.length}] ${spec.name}${isRepairPass ? " repair" : ""}${attempt > 1 ? ` retry #${attempt - 1}` : ""}): ${
								redact(getFinalAssistantText(current.messages)).slice(0, 80) || "running..."
							}`,
						);
					},
				});

				results[position] = stageRes;
				finalStageResult = stageRes;

				if (!isStageFailed(stageRes)) {
					break;
				}

				if (attempt <= maxRetries && stageRes.stopReason !== "aborted") {
					gateError = getStageOutput(stageRes);
				} else {
					break;
				}
			}

			if (!finalStageResult || isStageFailed(finalStageResult)) {
				const directive = step.onGateFail;
				const targetIndex = directive ? (stepIndexById.get(directive.retryFrom) ?? -1) : -1;
				const loopsUsed = loopBacksUsed.get(step.id) ?? 0;
				const maxLoops = directive?.maxLoops ?? 0;
				const canLoopBack =
					directive !== undefined &&
					targetIndex >= 0 &&
					targetIndex < position &&
					loopsUsed < maxLoops &&
					finalStageResult?.stopReason !== "aborted";

				if (canLoopBack && directive) {
					const failureText = getStageOutput(finalStageResult!);
					loopBacksUsed.set(step.id, loopsUsed + 1);
					totalLoopBacks++;
					// Invalidate stage outputs produced inside the re-run window so the retried chain
					// never reads stale text from the attempt that just failed.
					for (let k = targetIndex; k < position; k++) {
						const windowStep = resolvedSteps[k]!;
						stepOutputs.delete(windowStep.id);
						pendingFeedback.delete(windowStep.id);
					}
					pendingFeedback.set(
						directive.retryFrom,
						`Stage "${step.id}" (${spec.name}) failed and requested a repair pass. Fix the root cause; the chain will then re-run starting at "${directive.retryFrom}".\n\n${failureText}`,
					);
					const previousStep = targetIndex > 0 ? resolvedSteps[targetIndex - 1] : undefined;
					previousOutput = previousStep ? (stepOutputs.get(previousStep.id) ?? "") : "";
					protocolSteps[5].summary = `Repair loop ${loopsUsed + 1}/${maxLoops}: stage "${step.id}" failed → re-running from "${directive.retryFrom}"`;
					emitProgress(protocolSteps[5].summary);
					cursor = targetIndex;
					continue;
				}

				protocolSteps[5].status = "failed";
				protocolSteps[5].durationMs = Date.now() - t6;
				protocolSteps[5].summary =
					directive && loopsUsed >= maxLoops
						? `Stage ${position + 1} (${spec.name}) failed after ${attempt} attempt(s) and ${loopsUsed}/${maxLoops} repair loop(s)`
						: `Stage ${position + 1} (${spec.name}) failed after ${attempt} attempt(s)`;
				protocolSteps[6].status = "failed";
				protocolSteps[6].summary = `Contained failure at stage "${step.id}" (${spec.name})`;

				const errText = redact(finalStageResult ? getStageOutput(finalStageResult) : "Unknown error");
				return {
					content: [
						{
							type: "text",
							text: `[Thin Orchestrator Contained Failure] Workflow stopped at stage ${position + 1}/${resolvedSteps.length} (\`${step.id}\` → specialist \`${spec.name}\`):\n\n${errText}`,
						},
					],
					details: makeDetails(),
					isError: true,
				};
			}

			const stageText = redact(getFinalAssistantText(finalStageResult.messages));
			stepOutputs.set(step.id, stageText);
			previousOutput = stageText;
			cursor++;
		}
	}

	protocolSteps[5].status = "passed";
	protocolSteps[5].durationMs = Date.now() - t6;
	protocolSteps[5].summary = `Completed ${results.length} isolated specialist stage(s)${
		totalLoopBacks > 0 ? `, ${totalLoopBacks} repair loop(s)` : ""
	}`;

	// =========================================================================
	// STEP 7: HANDLE (Deterministic) — Aggregate results, verify gates, surface summary
	// =========================================================================
	const t7 = Date.now();
	protocolSteps[6].status = "running";
	const failedStages = results.filter((r) => isStageFailed(r));
	if (failedStages.length > 0) {
		protocolSteps[6].status = "failed";
		protocolSteps[6].durationMs = Date.now() - t7;
		protocolSteps[6].summary = `${failedStages.length}/${results.length} specialist stage(s) failed`;
	} else {
		protocolSteps[6].status = "passed";
		protocolSteps[6].durationMs = Date.now() - t7;
		protocolSteps[6].summary = `All ${results.length} stage(s) and reliability gates succeeded`;
	}

	const summarySections = results.map((r) => {
		const statusLabel = isStageFailed(r) ? "FAILED" : "COMPLETED";
		const gateBadge = r.gateCmd ? (r.gatePassed ? " [GATE PASS]" : " [GATE FAIL]") : "";
		const signalBadge = r.reportedGateStatus === "FAIL" ? " [SIGNAL FAIL]" : "";
		return `### Stage ${r.stepIndex}: \`${r.stepId}\` → Specialist \`${r.agent}\` (${statusLabel}${gateBadge}${signalBadge})\n\n${redact(getStageOutput(r))}`;
	});

	const headerTitle =
		mode === "workflow"
			? `## Thin Orchestrator Workflow: \`${workflowName}\` (${results.length} stages)`
			: mode === "parallel"
				? `## Thin Orchestrator Parallel Delegation (${results.length} specialists)`
				: `## Thin Orchestrator Specialist: \`${singleAgentName}\``;

	return {
		content: [
			{
				type: "text",
				text: `${headerTitle}\n\n${summarySections.join("\n\n---\n\n")}`,
			},
		],
		details: makeDetails(),
		isError: failedStages.length > 0,
	};
}
