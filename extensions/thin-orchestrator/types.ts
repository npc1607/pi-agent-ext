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
	/** Number of automatic retries if the specialist or its post-stage gate fails (default: 1). */
	maxRetries?: number;
}

/**
 * Deterministic Workflow Template: sequences existing specialist agents without writing new agent code.
 */
export interface WorkflowTemplate {
	name: string;
	description: string;
	requiredFields: string[];
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
