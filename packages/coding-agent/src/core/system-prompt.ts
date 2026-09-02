/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. */
	selectedTools: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines: string[];
	/** Text appended from user configuration. */
	appendSystemPrompt: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills: Skill[];
}

/** Backwards-compatible input accepted by the prompt builder. Hooks receive normalized options. */
export type BuildSystemPromptInput = Pick<BuildSystemPromptOptions, "cwd"> &
	Partial<Omit<BuildSystemPromptOptions, "cwd">>;

export type SystemPromptPiece = { type: "literal"; text: string } | { type: "value"; key: string; text: string };

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptInput): BuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? [])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: [...(input.skills ?? [])],
	};
}

export function renderSystemPrompt(pieces: readonly SystemPromptPiece[]): string {
	return pieces.map((piece) => piece.text).join("");
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return "";
	let context = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of contextFiles) {
		context += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${context}</project_context>\n`;
}

function appendCustomSectionPieces(
	pieces: SystemPromptPiece[],
	sections: Record<string, string>,
	separator: string,
	suffix: string,
): void {
	for (const [name, content] of Object.entries(sections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name)) {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
		if (content.length === 0) continue;
		pieces.push({
			type: "value",
			key: `section:${name}`,
			text: `${separator}<${name}>\n${content}\n</${name}>${suffix}`,
		});
	}
}

/** Build the system prompt as immutable literals interleaved with keyed dynamic values. */
export function buildSystemPromptPieces(input: BuildSystemPromptInput): SystemPromptPiece[] {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		forceSystemPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections,
		cwd,
		contextFiles,
		skills,
	} = options;

	if (forceSystemPrompt !== undefined) {
		return [{ type: "value", key: "forceSystemPrompt", text: forceSystemPrompt }];
	}

	const promptCwd = cwd.replace(/\\/g, "/");
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const projectContext = renderProjectContext(contextFiles);

	if (customPrompt) {
		const customPromptHasRead = selectedTools.includes("read");
		const pieces: SystemPromptPiece[] = [
			{ type: "value", key: "customPrompt", text: customPrompt },
			{ type: "value", key: "appendSystemPrompt", text: appendSection },
			{ type: "value", key: "projectContext", text: projectContext },
			{
				type: "value",
				key: "skills",
				text: customPromptHasRead && skills.length > 0 ? formatSkillsForPrompt(skills) : "",
			},
			{ type: "literal", text: "\nCurrent working directory: " },
			{ type: "value", key: "cwd", text: promptCwd },
			{ type: "literal", text: "\n" },
		];
		appendCustomSectionPieces(pieces, sections, "\n", "\n");
		return pieces;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");
	const hasRead = selectedTools.includes("read");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const guideline of toolGuidelines[name] ?? []) addGuideline(guideline);
	}
	for (const guideline of promptGuidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
	const pieces: SystemPromptPiece[] = [
		{
			type: "literal",
			text: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n",
		},
		{ type: "value", key: "tools", text: toolsList },
		{
			type: "literal",
			text: "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n",
		},
		{ type: "value", key: "guidelines", text: guidelines },
		{
			type: "literal",
			text: `\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`,
		},
		{ type: "value", key: "appendSystemPrompt", text: appendSection },
		{ type: "value", key: "projectContext", text: projectContext },
		{ type: "value", key: "skills", text: hasRead && skills.length > 0 ? formatSkillsForPrompt(skills) : "" },
		{ type: "literal", text: "\nCurrent working directory: " },
		{ type: "value", key: "cwd", text: promptCwd },
	];
	appendCustomSectionPieces(pieces, sections, "\n\n", "");
	return pieces;
}

/** Build the system prompt with tools, guidelines, and context. */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
	return renderSystemPrompt(buildSystemPromptPieces(input));
}

export type SystemPromptDiff = { type: "unchanged" } | { type: "update"; text: string } | { type: "replace" };

interface PromptLayout {
	literals: string[];
	values: Map<string, string>;
	placements: Array<{ key: string; literalIndex: number }>;
}

/** Render semantic, source-specific instructions for changed prompt values. */
export function diffSystemPrompts(
	previous: readonly SystemPromptPiece[],
	current: readonly SystemPromptPiece[],
): SystemPromptDiff {
	const previousLayout = collectPromptLayout(previous);
	const currentLayout = collectPromptLayout(current);
	if (!previousLayout || !currentLayout || !hasCompatiblePromptLayout(previousLayout, currentLayout)) {
		return { type: "replace" };
	}
	const updates: string[] = [];
	const keys = new Set([...previousLayout.values.keys(), ...currentLayout.values.keys()]);
	for (const key of keys) {
		const oldRawValue = previousLayout.values.get(key) ?? "";
		const newRawValue = currentLayout.values.get(key) ?? "";
		if (oldRawValue === newRawValue) continue;
		const oldValue = oldRawValue.trim();
		const newValue = newRawValue.trim();
		if (oldValue === newValue) return { type: "replace" };
		updates.push(renderSystemPromptValueUpdate(key, oldValue, newValue));
	}
	if (updates.length === 0) return { type: "unchanged" };
	return { type: "update", text: updates.join("\n\n") };
}

function collectPromptLayout(pieces: readonly SystemPromptPiece[]): PromptLayout | undefined {
	const literals: string[] = [];
	const values = new Map<string, string>();
	const placements: PromptLayout["placements"] = [];
	for (const piece of pieces) {
		if (piece.type === "literal") {
			literals.push(piece.text);
			continue;
		}
		if (values.has(piece.key)) return undefined;
		values.set(piece.key, piece.text);
		placements.push({ key: piece.key, literalIndex: literals.length });
	}
	return { literals, values, placements };
}

function hasCompatiblePromptLayout(previous: PromptLayout, current: PromptLayout): boolean {
	if (!sameStrings(previous.literals, current.literals)) return false;
	const previousPlacements = new Map(previous.placements.map((placement) => [placement.key, placement.literalIndex]));
	const currentPlacements = new Map(current.placements.map((placement) => [placement.key, placement.literalIndex]));
	for (const [key, literalIndex] of previousPlacements) {
		const currentLiteralIndex = currentPlacements.get(key);
		if (currentLiteralIndex !== undefined && currentLiteralIndex !== literalIndex) return false;
	}
	const previousCommonKeys = previous.placements
		.map((placement) => placement.key)
		.filter((key) => current.values.has(key));
	const currentCommonKeys = current.placements
		.map((placement) => placement.key)
		.filter((key) => previous.values.has(key));
	return sameStrings(previousCommonKeys, currentCommonKeys);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderSystemPromptValueUpdate(key: string, previous: string, current: string): string {
	if (key === "cwd") return `The current working directory is now: ${current}`;
	if (key === "projectContext") {
		if (!current) return "Previously supplied project-specific instructions no longer apply.";
		if (!previous) return `The following project-specific instructions now apply:\n\n${current}`;
		return `Project-specific instructions have changed. The following project context supersedes all previously supplied project-specific instructions.\n\n${current}`;
	}
	if (key === "skills") {
		if (!current) return "Skill guidance is no longer available. Do not use any previously listed skill.";
		if (!previous) return `The following skill guidance is now available:\n\n${current}`;
		return `The available skills have changed. This list supersedes the previous available skills list.\n\n${current}`;
	}
	if (key === "tools") {
		return `The available tool guidance has changed. This list supersedes the previous available tools list.\n\nAvailable tools:\n${current}`;
	}
	if (key === "guidelines") {
		return `The operating guidelines have changed. The following guidelines supersede the previous guidelines.\n\n${current}`;
	}
	if (key === "customPrompt") {
		if (!current) return "The previously supplied custom system instructions no longer apply.";
		if (!previous) return `The following custom system instructions now apply:\n\n${current}`;
		return `The custom system instructions have changed. These instructions replace the previous custom system instructions.\n\n${current}`;
	}
	if (key === "appendSystemPrompt") {
		if (!current) return "The previously appended system instructions no longer apply.";
		if (!previous) return `The following additional system instructions now apply:\n\n${current}`;
		return `The additional system instructions have changed. These instructions replace the previously appended system instructions.\n\n${current}`;
	}
	if (key.startsWith("section:")) {
		const name = key.slice("section:".length);
		if (!current) return `The <${name}> system guidance no longer applies.`;
		if (!previous) return `The following <${name}> system guidance now applies:\n\n${current}`;
		return `The <${name}> system guidance has changed. This section supersedes the previous <${name}> guidance.\n\n${current}`;
	}
	if (!previous) return `The following additional system guidance now applies:\n\n${current}`;
	if (!current) return `The following previously supplied system guidance no longer applies:\n\n${previous}`;
	return `The following previously supplied system guidance no longer applies:\n\n${previous}\n\nUse the following system guidance instead:\n\n${current}`;
}
