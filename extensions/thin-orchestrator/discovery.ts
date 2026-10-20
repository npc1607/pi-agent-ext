import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentScope, SpecialistAgent, WorkflowStep, WorkflowTemplate, WorkspaceDiscovery } from "./types.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

type SpecialistFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	knowledge?: unknown;
	required_fields?: unknown;
	pre_check?: unknown;
	post_gate?: unknown;
};

function parseStringList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function isDirectory(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectConfigDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME);
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function loadSpecialistsFromDir(dir: string, source: "builtin" | "user" | "project"): SpecialistAgent[] {
	if (!isDirectory(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const specialists: SpecialistAgent[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<SpecialistFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const tools = parseStringList(frontmatter.tools);
		specialists.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools: tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
			knowledgeFiles: parseStringList(frontmatter.knowledge),
			requiredFields: parseStringList(frontmatter.required_fields),
			preCheckCmd:
				typeof frontmatter.pre_check === "string" && frontmatter.pre_check.trim()
					? frontmatter.pre_check.trim()
					: undefined,
			postGateCmd:
				typeof frontmatter.post_gate === "string" && frontmatter.post_gate.trim()
					? frontmatter.post_gate.trim()
					: undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return specialists;
}

function loadWorkflowsFromDir(dir: string, source: "builtin" | "user" | "project"): WorkflowTemplate[] {
	if (!isDirectory(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const workflows: WorkflowTemplate[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
			if (typeof raw.name !== "string" || typeof raw.description !== "string" || !Array.isArray(raw.steps)) {
				continue;
			}

			const steps: WorkflowStep[] = [];
			for (let i = 0; i < raw.steps.length; i++) {
				const item = raw.steps[i] as Record<string, unknown>;
				if (!item || typeof item.agent !== "string" || typeof item.taskTemplate !== "string") continue;
				steps.push({
					id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `step_${i + 1}`,
					agent: item.agent.trim(),
					taskTemplate: item.taskTemplate,
					gateCmd: typeof item.gateCmd === "string" && item.gateCmd.trim() ? item.gateCmd.trim() : undefined,
					maxRetries: typeof item.maxRetries === "number" ? Math.max(0, Math.min(3, item.maxRetries)) : 1,
				});
			}

			if (steps.length === 0) continue;

			workflows.push({
				name: raw.name.trim(),
				description: raw.description.trim(),
				requiredFields: parseStringList(raw.requiredFields),
				preChecks: parseStringList(raw.preChecks),
				steps,
				source,
				filePath,
			});
		} catch {
			continue;
		}
	}

	return workflows;
}

export interface OrchestratorCatalog {
	specialists: SpecialistAgent[];
	workflows: WorkflowTemplate[];
	projectConfigDir: string | null;
}

/**
 * Step 1 (Read): Discover all available Specialist Subagents and Workflow Templates.
 */
export function discoverCatalog(cwd: string, scope: AgentScope = "all"): OrchestratorCatalog {
	const builtinAgentsDir = path.join(EXTENSION_DIR, "agents");
	const builtinWorkflowsDir = path.join(EXTENSION_DIR, "workflows");
	const userAgentDir = getAgentDir();
	const projectConfigDir = findNearestProjectConfigDir(cwd);

	const specialistMap = new Map<string, SpecialistAgent>();
	const workflowMap = new Map<string, WorkflowTemplate>();

	const includeBuiltin = scope === "builtin" || scope === "user" || scope === "all";
	const includeUser = scope === "user" || scope === "all";
	const includeProject = (scope === "project" || scope === "all") && projectConfigDir !== null;

	if (includeBuiltin) {
		for (const s of loadSpecialistsFromDir(builtinAgentsDir, "builtin")) specialistMap.set(s.name, s);
		for (const w of loadWorkflowsFromDir(builtinWorkflowsDir, "builtin")) workflowMap.set(w.name, w);
	}
	if (includeUser) {
		for (const s of loadSpecialistsFromDir(path.join(userAgentDir, "agents"), "user")) specialistMap.set(s.name, s);
		for (const w of loadWorkflowsFromDir(path.join(userAgentDir, "workflows"), "user")) workflowMap.set(w.name, w);
	}
	if (includeProject && projectConfigDir) {
		for (const s of loadSpecialistsFromDir(path.join(projectConfigDir, "agents"), "project")) {
			specialistMap.set(s.name, s);
		}
		for (const w of loadWorkflowsFromDir(path.join(projectConfigDir, "workflows"), "project")) {
			workflowMap.set(w.name, w);
		}
	}

	return {
		specialists: Array.from(specialistMap.values()),
		workflows: Array.from(workflowMap.values()),
		projectConfigDir,
	};
}

/**
 * Runtime on-demand knowledge loader.
 * Resolves a knowledge file relative to project `.pi/`, user `~/.pi/agent/`, or the extension's `knowledge/` dir.
 */
export function loadRuntimeKnowledgeFiles(
	specialist: SpecialistAgent,
	cwd: string,
	projectConfigDir: string | null,
): { loadedPaths: string[]; combinedMarkdown: string } {
	if (specialist.knowledgeFiles.length === 0) {
		return { loadedPaths: [], combinedMarkdown: "" };
	}

	const searchRoots = [
		...(projectConfigDir ? [projectConfigDir] : []),
		cwd,
		getAgentDir(),
		EXTENSION_DIR,
		path.dirname(specialist.filePath),
	];

	const loadedPaths: string[] = [];
	const sections: string[] = [];

	for (const relPath of specialist.knowledgeFiles) {
		let resolved: string | null = null;
		for (const root of searchRoots) {
			const candidate = path.resolve(root, relPath);
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				resolved = candidate;
				break;
			}
		}
		if (!resolved) continue;
		try {
			const content = fs.readFileSync(resolved, "utf-8").trim();
			if (content) {
				loadedPaths.push(relPath);
				sections.push(`<!-- Runtime Knowledge: ${relPath} -->\n${content}`);
			}
		} catch {
			// Skip unreadable knowledge file
		}
	}

	return {
		loadedPaths,
		combinedMarkdown:
			sections.length > 0
				? `\n\n# Runtime Domain Knowledge (Isolated Context)\n\n${sections.join("\n\n---\n\n")}`
				: "",
	};
}

function safeExecGit(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Step 4 (Auto-discover): Deterministically infer repository type, language stack, Go module, and modified files.
 * Zero LLM tokens spent on environment recon.
 */
export function autoDiscoverWorkspace(cwd: string): WorkspaceDiscovery {
	const repoRoot = safeExecGit(cwd, ["rev-parse", "--show-toplevel"]);
	const effectiveRoot = repoRoot || cwd;
	const repoName = path.basename(effectiveRoot);
	const gitBranch = safeExecGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const statusRaw = safeExecGit(cwd, ["status", "--porcelain"]);
	const gitDirtyFiles = statusRaw
		? statusRaw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.slice(0, 25)
		: [];

	const languageStack: string[] = [];
	let goModule: string | null = null;

	const goModPath = path.join(effectiveRoot, "go.mod");
	if (fs.existsSync(goModPath)) {
		languageStack.push("Go");
		try {
			const goMod = fs.readFileSync(goModPath, "utf-8");
			const match = goMod.match(/^module\s+(\S+)/m);
			if (match) goModule = match[1];
		} catch {
			// ignore
		}
	}
	if (fs.existsSync(path.join(effectiveRoot, "package.json"))) languageStack.push("TypeScript/Node");
	if (fs.existsSync(path.join(effectiveRoot, "Cargo.toml"))) languageStack.push("Rust");
	if (fs.existsSync(path.join(effectiveRoot, "pyproject.toml")) || fs.existsSync(path.join(effectiveRoot, "requirements.txt"))) {
		languageStack.push("Python");
	}
	if (fs.existsSync(path.join(effectiveRoot, "CMakeLists.txt")) || fs.existsSync(path.join(effectiveRoot, "Makefile"))) {
		languageStack.push("C/C++/Make");
	}

	return {
		cwd,
		repoRoot,
		repoName,
		gitBranch,
		gitDirtyFiles,
		languageStack: languageStack.length > 0 ? languageStack : ["Unknown"],
		goModule,
	};
}

export function formatWorkspaceSummary(ws: WorkspaceDiscovery): string {
	const lines = [
		`- Working Directory: \`${ws.cwd}\``,
		`- Repository: \`${ws.repoName}\`${ws.repoRoot ? ` (\`${ws.repoRoot}\`)` : ""}`,
		`- Git Branch: \`${ws.gitBranch ?? "non-git"}\` (${ws.gitDirtyFiles.length} uncommitted file(s))`,
		`- Language Stack: ${ws.languageStack.join(", ")}${ws.goModule ? ` (Go module: \`${ws.goModule}\`)` : ""}`,
	];
	if (ws.gitDirtyFiles.length > 0) {
		lines.push(`- Modified Files (top ${Math.min(10, ws.gitDirtyFiles.length)}): ${ws.gitDirtyFiles.slice(0, 10).join(", ")}`);
	}
	return lines.join("\n");
}
