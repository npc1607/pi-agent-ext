import assert from "node:assert";
import {
	evaluateGuardedActionEligibility,
	executeCertifiedCallbackSubstitution,
	isStageFailed,
} from "../extensions/thin-orchestrator/runner.ts";

console.log("=== Running HarnessMM Unit Tests ===");

const mockWorkspace = {
	cwd: process.cwd(),
	repoRoot: process.cwd(),
	repoName: "test-repo",
	gitBranch: "main",
	gitDirtyFiles: [],
	languageStack: ["TypeScript"],
	goModule: null,
};

// -----------------------------------------------------------------------------
// Test 1: evaluateGuardedActionEligibility
// -----------------------------------------------------------------------------
console.log("\n1. Testing evaluateGuardedActionEligibility...");

// Case 1.1: No guardedAction
{
	const step = {
		id: "verify",
		agent: "verifier",
		taskTemplate: "verify",
	};
	const res = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "All good",
		stepOutputs: new Map(),
		task: "Fix bug",
	});
	assert.strictEqual(res.eligible, false);
	console.log("  ✓ Case 1.1: returns eligible=false when no guardedAction");
}

// Case 1.2: guardedAction passes all default checks
{
	const step = {
		id: "verify",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			guard: { predecessorGatePassed: true },
			actionCmd: "echo 'running verification for {task}'",
		},
	};
	const mockPrevStage = {
		stepIndex: 1,
		stepId: "implement",
		agent: "implementer",
		agentSource: "builtin",
		task: "implement",
		knowledgeLoaded: [],
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		attempts: 1,
		gatePassed: true,
	};
	const res = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "Fix implemented cleanly",
		stepOutputs: new Map([["implement", "Fix implemented cleanly"]]),
		task: "Fix auth token bug",
		previousStageResult: mockPrevStage,
	});
	assert.strictEqual(res.eligible, true);
	assert.strictEqual(res.resolvedCmd, "echo 'running verification for Fix auth token bug'");
	console.log("  ✓ Case 1.2: returns eligible=true with interpolated resolvedCmd");
}

// Case 1.3: Rejects when predecessor stage failed
{
	const step = {
		id: "verify",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			guard: { predecessorGatePassed: true },
			actionCmd: "echo 'should not run'",
		},
	};
	const mockFailedPrevStage = {
		stepIndex: 1,
		stepId: "implement",
		agent: "implementer",
		agentSource: "builtin",
		task: "implement",
		knowledgeLoaded: [],
		exitCode: 1,
		messages: [],
		stderr: "Compilation failed",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		attempts: 1,
		gatePassed: false,
	};
	const res = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "Error",
		stepOutputs: new Map(),
		task: "Fix bug",
		previousStageResult: mockFailedPrevStage,
	});
	assert.strictEqual(res.eligible, false);
	assert.match(res.reason, /Predecessor stage failed/);
	console.log("  ✓ Case 1.3: returns eligible=false when predecessor stage failed");
}

// Case 1.4: Output pattern matching
{
	const step = {
		id: "verify",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			guard: { outputMatches: "STATUS:\\s*READY_FOR_TEST" },
			actionCmd: "echo 'test'",
		},
	};
	// Output mismatch
	const resFail = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "Still working on fix...",
		stepOutputs: new Map(),
		task: "Fix bug",
	});
	assert.strictEqual(resFail.eligible, false);
	assert.match(resFail.reason, /Previous output did not match guard pattern/);

	// Output match
	const resPass = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "Changes committed.\nSTATUS: READY_FOR_TEST",
		stepOutputs: new Map(),
		task: "Fix bug",
	});
	assert.strictEqual(resPass.eligible, true);
	console.log("  ✓ Case 1.4: respects outputMatches regex guard");
}

// Case 1.5: Rejects when placeholder argument is unclosed
{
	const step = {
		id: "verify",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			actionCmd: "echo 'running on {field:undefined_field}'",
		},
	};
	const res = evaluateGuardedActionEligibility(step, {
		cwd: process.cwd(),
		workspace: mockWorkspace,
		fields: {},
		previousOutput: "Done",
		stepOutputs: new Map(),
		task: "Fix bug",
	});
	assert.strictEqual(res.eligible, false);
	assert.match(res.reason, /unclosed placeholder arguments/);
	console.log("  ✓ Case 1.5: safely rejects when command has unclosed placeholders");
}

// -----------------------------------------------------------------------------
// Test 2: executeCertifiedCallbackSubstitution (CCS)
// -----------------------------------------------------------------------------
console.log("\n2. Testing executeCertifiedCallbackSubstitution...");

const mockSpecialist = {
	name: "verifier",
	description: "verifier specialist",
	knowledgeFiles: [],
	skills: [],
	requiredFields: [],
	systemPrompt: "verify",
	source: "builtin",
	filePath: "/fake/verifier.md",
};

// Case 2.1: Native execution succeeds -> Issues valid certificate & 0 tokens
{
	const step = {
		id: "verify_step",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			actionCmd: "echo 'all 12 unit tests passed'",
			description: "Unit test suite execution",
		},
	};
	const stageRes = executeCertifiedCallbackSubstitution({
		cwd: process.cwd(),
		step,
		specialist: mockSpecialist,
		stepIndex: 2,
		resolvedCmd: "echo 'all 12 unit tests passed'",
		reason: "Unit test suite execution",
	});

	assert.strictEqual(stageRes.exitCode, 0);
	assert.strictEqual(isStageFailed(stageRes), false);
	assert.strictEqual(stageRes.usage.input, 0);
	assert.strictEqual(stageRes.usage.output, 0);
	assert.strictEqual(stageRes.usage.turns, 0);
	assert.ok(stageRes.substitution, "Substitution certificate must be present");
	assert.strictEqual(stageRes.substitution.bypassedAgent, "verifier");
	assert.strictEqual(stageRes.substitution.actionCmd, "echo 'all 12 unit tests passed'");
	assert.ok(stageRes.substitution.graphHash.length >= 8);
	assert.match(stageRes.messages[0].content[0].text, /Certified Callback Substitution/);
	console.log("  ✓ Case 2.1: successful native action generates valid substitution certificate with 0 tokens");
}

// Case 2.2: Native execution fails -> Captures non-zero exit code & stderr for fallback
{
	const step = {
		id: "verify_step",
		agent: "verifier",
		taskTemplate: "verify",
		guardedAction: {
			actionCmd: "sh -c 'echo \"syntax error in test_auth.go\" >&2; exit 2'",
		},
	};
	const stageRes = executeCertifiedCallbackSubstitution({
		cwd: process.cwd(),
		step,
		specialist: mockSpecialist,
		stepIndex: 2,
		resolvedCmd: "sh -c 'echo \"syntax error in test_auth.go\" >&2; exit 2'",
		reason: "Test failure check",
	});

	assert.strictEqual(stageRes.exitCode, 1);
	assert.strictEqual(isStageFailed(stageRes), true);
	assert.match(stageRes.stderr, /syntax error in test_auth.go/);
	console.log("  ✓ Case 2.2: failing native action properly flags failure with captured stderr for LLM fallback");
}

// -----------------------------------------------------------------------------
// Test 3: Full Protocol End-to-End Simulation with runThinOrchestratorProtocol
// -----------------------------------------------------------------------------
console.log("\n3. Testing runThinOrchestratorProtocol with GDR & CCS...");

import { runThinOrchestratorProtocol } from "../extensions/thin-orchestrator/runner.ts";

{
	let executorInvocations = 0;
	const invokedSteps = [];

	const mockCatalog = {
		workflows: [
			{
				name: "test-pipeline",
				description: "Test Pipeline",
				requiredFields: ["task"],
				preChecks: [],
				source: "builtin",
				filePath: "/fake/workflow.json",
				steps: [
					{
						id: "step_implement",
						agent: "mock_implementer",
						taskTemplate: "implement {task}",
						gateCmd: "echo 'gate 1 passed'",
					},
					{
						id: "step_verify",
						agent: "mock_verifier",
						taskTemplate: "verify",
						guardedAction: {
							guard: { predecessorGatePassed: true },
							actionCmd: "echo 'native test suite passed'",
							description: "Fast native unit test substitution",
						},
						gateCmd: "echo 'gate 2 passed'",
					},
					{
						id: "step_review",
						agent: "mock_reviewer",
						taskTemplate: "review",
					},
				],
			},
		],
		specialists: [
			{
				name: "mock_implementer",
				description: "impl",
				knowledgeFiles: [],
				skills: [],
				requiredFields: [],
				systemPrompt: "impl",
				source: "builtin",
				filePath: "/fake/impl.md",
			},
			{
				name: "mock_verifier",
				description: "ver",
				knowledgeFiles: [],
				skills: [],
				requiredFields: [],
				systemPrompt: "ver",
				source: "builtin",
				filePath: "/fake/ver.md",
			},
			{
				name: "mock_reviewer",
				description: "rev",
				knowledgeFiles: [],
				skills: [],
				requiredFields: [],
				systemPrompt: "rev",
				source: "builtin",
				filePath: "/fake/rev.md",
			},
		],
		projectConfigDir: null,
	};

	const mockStageExecutor = async (opts) => {
		executorInvocations++;
		invokedSteps.push(opts.stepId);
		return {
			stepIndex: opts.stepIndex,
			stepId: opts.stepId,
			agent: opts.specialist.name,
			agentSource: opts.specialist.source,
			task: opts.taskPrompt,
			knowledgeLoaded: [],
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: `Mock execution of ${opts.specialist.name} completed` }],
				},
			],
			stderr: "",
			usage: { input: 1500, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2000, turns: 1 },
			attempts: 1,
			gateCmd: opts.gateCmd,
			gatePassed: true,
		};
	};

	const mockCtx = {
		cwd: process.cwd(),
		hasUI: false,
		model: { provider: "test", id: "test-model" },
		isProjectTrusted: () => true,
	};

	const result = await runThinOrchestratorProtocol({
		ctx: mockCtx,
		catalog: mockCatalog,
		agentScope: "builtin",
		mode: "workflow",
		workflowName: "test-pipeline",
		task: "Implement user authentication",
		fields: {},
		confirmProjectResources: false,
		stageExecutor: mockStageExecutor,
	});

	assert.strictEqual(result.isError, false);
	const details = result.details;
	assert.ok(details, "Details must be present");
	assert.strictEqual(details.results.length, 3, "Workflow must produce 3 stage results");

	// Step 2 (verify) must be bypassed via CCS!
	assert.strictEqual(executorInvocations, 2, "LLM stageExecutor must only be called 2 times (omitting verifier)");
	assert.deepStrictEqual(invokedSteps, ["step_implement", "step_review"]);
	assert.strictEqual(details.bypassedCallbacks, 1, "Must record 1 bypassed callback in details");

	const verifyStageResult = details.results[1];
	assert.ok(verifyStageResult.substitution, "Verify stage must have substitution certificate");
	assert.strictEqual(verifyStageResult.substitution.bypassedAgent, "mock_verifier");
	assert.strictEqual(verifyStageResult.substitution.actionCmd, "echo 'native test suite passed'");
	assert.strictEqual(verifyStageResult.usage.input, 0, "Bypassed stage must consume 0 input tokens");
	assert.strictEqual(verifyStageResult.usage.output, 0, "Bypassed stage must consume 0 output tokens");

	console.log("  ✓ Case 3.1: Sequential workflow successfully executes GDR, bypasses LLM callback via CCS, and issues certificate");
}
console.log("\n✅ All HarnessMM unit tests passed successfully!");
