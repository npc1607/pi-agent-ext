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

export function isStageFailed(stage: StageResult): boolean {
	if (stage.exitCode !== 0 || stage.stopReason === "error" || stage.stopReason === "aborted") {
		return true;
	}
	if (stage.gateCmd && stage.gatePassed === false) {
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
		return stage.errorMessage || stage.stderr || getFinalAssistantText(stage.messages) || "(no output)";
	}
	return getFinalAssistantText(stage.messages) || "(no output)";
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
	attempt: number;
	signal?: AbortSignal;
	onProgress?: (currentStage: StageResult) => void;
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
		attempt,
		signal,
		onProgress,
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
		task: taskPrompt,
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
		const effectiveGate = stageResult.gateCmd;
		if (effectiveGate && exitCode === 0 && stageResult.stopReason !== "error") {
			const gateRes = runDeterministicShellCheck(effectiveGate, cwd);
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
	for (const fieldName of requiredFieldNames) {
		if (!gatheredFields[fieldName] || !gatheredFields[fieldName].trim()) {
			if (ctx.hasUI) {
				const userVal = await ctx.ui.input(
					`[Thin Orchestrator] Required field "${fieldName}"`,
					`Enter value for "${fieldName}" before delegating:`,
				);
				if (userVal && userVal.trim()) {
					gatheredFields[fieldName] = userVal.trim();
					continue;
				}
			}
			missingFields.push(fieldName);
		}
	}

	if (missingFields.length > 0) {
		protocolSteps[2].status = "failed";
		protocolSteps[2].durationMs = Date.now() - t3;
		protocolSteps[2].summary = `Missing required field(s): ${missingFields.join(", ")}`;
		return {
			content: [
				{
					type: "text",
					text: `[Step 3 Gather Blocked] Missing required field(s): ${missingFields.join(", ")}. Provide them in \`fields\` before running.`,
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
			? `Verified ${requiredFieldNames.size} required field(s): ${Array.from(requiredFieldNames).join(", ")}`
			: "Core task input verified";
	emitProgress("Step 3/7 (Gather) complete...");

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

				const stageRes = await executeSpecialistStage({
					cwd: ctx.cwd,
					projectConfigDir: catalog.projectConfigDir,
					dispatchDefaults,
					specialist: spec,
					stepIndex: idx + 1,
					stepId: step.id,
					taskPrompt: renderedTask,
					gateCmd: step.gateCmd,
					attempt: 1,
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
		for (let i = 0; i < resolvedSteps.length; i++) {
			const step = resolvedSteps[i];
			const spec = referencedSpecialists.get(step.agent)!;
			const maxRetries = step.maxRetries ?? 1;
			let attempt = 0;
			let gateError: string | undefined;
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

				const stageRes = await executeSpecialistStage({
					cwd: ctx.cwd,
					projectConfigDir: catalog.projectConfigDir,
					dispatchDefaults,
					specialist: spec,
					stepIndex: i + 1,
					stepId: step.id,
					taskPrompt: renderedTask,
					gateCmd: step.gateCmd,
					attempt,
					signal,
					onProgress: (current) => {
						results[i] = current;
						emitProgress(
							`Step 6/7 (Delegate [${i + 1}/${resolvedSteps.length}] ${spec.name}${attempt > 1 ? ` retry #${attempt - 1}` : ""}): ${
								getFinalAssistantText(current.messages).slice(0, 80) || "running..."
							}`,
						);
					},
				});

				results[i] = stageRes;
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
				protocolSteps[5].status = "failed";
				protocolSteps[5].durationMs = Date.now() - t6;
				protocolSteps[5].summary = `Stage ${i + 1} (${spec.name}) failed after ${attempt} attempt(s)`;
				protocolSteps[6].status = "failed";
				protocolSteps[6].summary = `Contained failure at stage "${step.id}" (${spec.name})`;

				const errText = finalStageResult ? getStageOutput(finalStageResult) : "Unknown error";
				return {
					content: [
						{
							type: "text",
							text: `[Thin Orchestrator Contained Failure] Workflow stopped at stage ${i + 1}/${resolvedSteps.length} (\`${step.id}\` → specialist \`${spec.name}\`):\n\n${errText}`,
						},
					],
					details: makeDetails(),
					isError: true,
				};
			}

			const stageText = getFinalAssistantText(finalStageResult.messages);
			stepOutputs.set(step.id, stageText);
			previousOutput = stageText;
		}
	}

	protocolSteps[5].status = "passed";
	protocolSteps[5].durationMs = Date.now() - t6;
	protocolSteps[5].summary = `Completed ${results.length} isolated specialist stage(s)`;

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
		return `### Stage ${r.stepIndex}: \`${r.stepId}\` → Specialist \`${r.agent}\` (${statusLabel}${gateBadge})\n\n${getStageOutput(r)}`;
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
