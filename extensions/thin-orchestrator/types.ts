import type { Message } from "@earendil-works/pi-ai";

export type AgentScope = "builtin" | "user" | "project" | "all";

/**
 * Standardized 5-part Specialist Subagent configuration (Meta Thin Orchestrator pattern).
 */
export interface SpecialistAgent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Relative paths to runtime knowledge files (loaded on demand at Step 6, never in main prompt). */
	knowledgeFiles: string[];
	/** Skill names to mount on demand via `--skill` in the isolated child process (all other global skills are disabled via `-ns`). */
	skills: string[];
	/** Whether to enable `builtin:mcp` in the isolated child process (default: false, passes `--no-mcp`). */
	mcp?: boolean;
	/** Required input fields that Step 3 (Gather) must collect before delegation. */
	requiredFields: string[];
	/** Optional deterministic shell command run at Step 2 (Check) before invoking this specialist. */
	preCheckCmd?: string;
	/** Optional deterministic shell command run at Step 5/7 (Reliability Gate) after this specialist finishes. */
	postGateCmd?: string;
	/** Specialist system prompt (markdown body). */
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

/**
 * A single stage in a deterministic Workflow Template state machine.
 */
export interface WorkflowStep {
	id: string;
	agent: string;
	/**
	 * Prompt template for this specialist.
	 * Placeholders: {task}, {previous}, {step:<id>}, {workspace}, {field:<name>}, {gate_error}
	 */
	taskTemplate: string;
	/** Optional deterministic shell command that must exit 0 after this stage completes. */
	gateCmd?: string;
	/**
	 * Timeout in milliseconds for `gateCmd` (default: 30000, clamped to 1000..1800000).
	 * Long-running suites (e.g. `go test ./...`) must raise this explicitly.
	 */
	gateTimeoutMs?: number;
	/** Number of automatic retries if the specialist or its post-stage gate fails (default: 1). */
	maxRetries?: number;
	/**
	 * Repair loop: when this stage still fails after its own retries, jump back to an earlier
	 * stage in the same workflow, pass the failure output to it, and re-run the chain from there.
	 * Only honored in sequential (workflow/single) mode; ignored in parallel mode.
	 */
	onGateFail?: {
		/** `id` of an earlier step in the same workflow to re-run. */
		retryFrom: string;
		/** Maximum loop-backs for this stage (default: 1, clamped to 0..3). 0 disables looping. */
		maxLoops?: number;
	};
}

/**
 * Deterministic Gather (Step 3) prompt definition for a required field.
 * When `options` is present the user picks from a selector instead of typing free text.
 */
export interface FieldPrompt {
	/** Dialog title, e.g. `接口鉴权方式`. Defaults to `[Thin Orchestrator] Required field "<name>"`. */
	title?: string;
	/** Choice list rendered through `ctx.ui.select`. Omit for a free-text input. */
	options?: string[];
	/** Placeholder / hint shown for free-text input. */
	placeholder?: string;
	/** Fallback value used when no interactive UI is available (print/json modes). */
	default?: string;
	/** Treat the value as a secret: redact it from the protocol audit, progress stream, and tool result. */
	secret?: boolean;
}

/**
 * Deterministic Workflow Template: sequences existing specialist agents without writing new agent code.
 */
export interface WorkflowTemplate {
	name: string;
	description: string;
	requiredFields: string[];
	/** Optional per-field Gather (Step 3) prompts, keyed by field name. */
	fieldPrompts?: Record<string, FieldPrompt>;
	/** Deterministic pre-flight shell checks run at Step 2 before any LLM call. */
	preChecks: string[];
	steps: WorkflowStep[];
	source: "builtin" | "user" | "project";
	filePath: string;
}

/**
 * Step 4: Deterministic Workspace Auto-Discovery metadata.
 */
export interface WorkspaceDiscovery {
	cwd: string;
	repoRoot: string | null;
	repoName: string;
	gitBranch: string | null;
	gitDirtyFiles: string[];
	languageStack: string[];
	goModule: string | null;
}

/**
 * Meta's 7-Step Deterministic Orchestration Protocol tracking.
 */
export type ProtocolStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ProtocolStepRecord {
	step: ProtocolStepNumber;
	name: "Read" | "Check" | "Gather" | "Auto-discover" | "Reliability Gate" | "Delegate" | "Handle";
	deterministic: boolean;
	status: "pending" | "running" | "passed" | "failed" | "skipped";
	summary: string;
	durationMs?: number;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface StageResult {
	stepIndex: number;
	stepId: string;
	agent: string;
	agentSource: "builtin" | "user" | "project" | "unknown";
	task: string;
	knowledgeLoaded: string[];
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	attempts: number;
	gateCmd?: string;
	gatePassed?: boolean;
	gateOutput?: string;
	/** Explicit `GATE_STATUS: PASS|FAIL` line reported by the specialist in its final message. */
	reportedGateStatus?: "PASS" | "FAIL";
}

export interface OrchestratorDetails {
	mode: "workflow" | "single" | "parallel";
	workflowName?: string;
	task: string;
	agentScope: AgentScope;
	workspace?: WorkspaceDiscovery;
	protocolSteps: ProtocolStepRecord[];
	results: StageResult[];
}
