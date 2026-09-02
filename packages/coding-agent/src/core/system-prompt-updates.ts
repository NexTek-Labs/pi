import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, SystemMessage, TextContent, Tool, ToolLoadoutContent } from "@earendil-works/pi-ai/compat";
import {
	type BuildSystemPromptOptions,
	buildSystemPromptPieces,
	diffSystemPrompts,
	renderSystemPrompt,
	type SystemPromptPiece,
} from "./system-prompt.ts";

export type ContextUpdateCapabilities =
	| { systemMessages: "none"; toolAddition: "none"; toolRemoval: "none" }
	| {
			systemMessages: "native";
			toolAddition: "none" | "native";
			toolRemoval: "none" | "soft";
	  };

const NO_CONTEXT_UPDATES = {
	systemMessages: "none",
	toolAddition: "none",
	toolRemoval: "none",
} as const satisfies ContextUpdateCapabilities;

/** Resolve the chronological context updates supported by a model transport. */
export function getContextUpdateCapabilities(model: Model<Api> | undefined): ContextUpdateCapabilities {
	if (!model) return NO_CONTEXT_UPDATES;
	if (model.api === "faux" || model.api.startsWith("faux:")) {
		return { systemMessages: "native", toolAddition: "native", toolRemoval: "soft" };
	}
	if (model.api === "mistral-conversations" || model.api === "azure-openai-responses") {
		return { systemMessages: "native", toolAddition: "none", toolRemoval: "none" };
	}
	if (model.api === "openai-completions") {
		const supportsToolAddition =
			model.compat !== undefined && "deferredToolsMode" in model.compat && model.compat.deferredToolsMode === "kimi";
		return {
			systemMessages: "native",
			toolAddition: supportsToolAddition ? "native" : "none",
			toolRemoval: "none",
		};
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		const supportsToolAddition =
			model.compat !== undefined &&
			"supportsAdditionalTools" in model.compat &&
			(model.compat.supportsAdditionalTools === true || model.compat.supportsToolSearch === true);
		return {
			systemMessages: "native",
			toolAddition: supportsToolAddition ? "native" : "none",
			toolRemoval: "soft",
		};
	}
	return NO_CONTEXT_UPDATES;
}

export interface ModelContextState {
	prompt: {
		pieces: SystemPromptPiece[];
		effective: string;
		baseline: string;
	};
	tools: {
		visible: Map<string, Tool>;
		catalog: Map<string, Tool>;
	};
}

interface ToolLoadoutChange {
	added: Tool[];
	removed: Tool[];
}

type IncrementalModelContextUpdate =
	| {
			type: "incremental";
			state: ModelContextState;
			promptText: string;
			toolChange?: ToolLoadoutChange;
	  }
	| {
			type: "incremental";
			state: ModelContextState;
			promptText?: undefined;
			toolChange: ToolLoadoutChange;
	  };

export type PreparedModelContextUpdate =
	| { type: "initial"; state: ModelContextState }
	| { type: "unchanged"; state: ModelContextState }
	| IncrementalModelContextUpdate
	| { type: "replacement"; state: ModelContextState };

/** Convert an executable agent tool into the provider-independent declaration stored in prompt updates. */
export function systemPromptTool(tool: AgentTool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
	};
}

function toolDeclarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Prepare one coherent prompt and tool transition for the next provider boundary. */
export function prepareModelContextUpdate(input: {
	options: BuildSystemPromptOptions;
	tools: Map<string, Tool>;
	previous?: ModelContextState;
	capabilities: ContextUpdateCapabilities;
}): PreparedModelContextUpdate {
	const pieces = buildSystemPromptPieces(input.options);
	const effective = renderSystemPrompt(pieces);
	const previous = input.previous;
	if (!previous) {
		return {
			type: "initial",
			state: {
				prompt: { pieces, effective, baseline: effective },
				tools: { visible: input.tools, catalog: new Map(input.tools) },
			},
		};
	}

	const promptDiff =
		previous.prompt.effective === effective
			? ({ type: "unchanged" } as const)
			: diffSystemPrompts(previous.prompt.pieces, pieces);
	const added = [...input.tools].filter(([name]) => !previous.tools.visible.has(name)).map(([, tool]) => tool);
	const removed = [...previous.tools.visible].filter(([name]) => !input.tools.has(name)).map(([, tool]) => tool);
	const declarationChanged = [...input.tools].some(([name, tool]) => {
		const previousTool = previous.tools.visible.get(name) ?? previous.tools.catalog.get(name);
		return previousTool !== undefined && !toolDeclarationsEqual(previousTool, tool);
	});
	const previousNames = [...previous.tools.visible.keys()];
	const currentNames = [...input.tools.keys()];
	const declarationOrderChanged =
		added.length === 0 && removed.length === 0 && previousNames.some((name, index) => name !== currentNames[index]);
	const toolsChanged = added.length > 0 || removed.length > 0 || declarationChanged || declarationOrderChanged;
	const requiresReplacement =
		promptDiff.type === "replace" ||
		(input.options.forceSystemPrompt !== undefined && promptDiff.type !== "unchanged") ||
		(promptDiff.type === "update" && input.capabilities.systemMessages === "none") ||
		declarationChanged ||
		declarationOrderChanged ||
		(added.length > 0 && input.capabilities.toolAddition === "none") ||
		(removed.length > 0 && input.capabilities.toolRemoval === "none");

	if (requiresReplacement) {
		return {
			type: "replacement",
			state: {
				prompt: { pieces, effective, baseline: effective },
				tools: { visible: input.tools, catalog: new Map(input.tools) },
			},
		};
	}

	if (promptDiff.type === "unchanged" && !toolsChanged) {
		return {
			type: "unchanged",
			state: {
				prompt: { pieces, effective, baseline: previous.prompt.baseline },
				tools: { visible: input.tools, catalog: previous.tools.catalog },
			},
		};
	}

	const catalog = new Map(previous.tools.catalog);
	for (const tool of added) catalog.set(tool.name, tool);
	const state: ModelContextState = {
		prompt: { pieces, effective, baseline: previous.prompt.baseline },
		tools: { visible: input.tools, catalog },
	};
	const toolChange = added.length > 0 || removed.length > 0 ? { added, removed } : undefined;
	if (promptDiff.type === "update") {
		return { type: "incremental", state, promptText: promptDiff.text, toolChange };
	}
	return { type: "incremental", state, toolChange: { added, removed } };
}

/** Serialize one incremental prompt/tool transition into provider-independent context. */
export function createSystemPromptUpdateMessage(
	update: Extract<PreparedModelContextUpdate, { type: "incremental" }>,
): SystemMessage {
	const content: Array<TextContent | ToolLoadoutContent> = [];
	const text = update.promptText ? [update.promptText] : [];
	if (update.toolChange) {
		content.push({
			type: "toolLoadout",
			tools: [...update.state.tools.catalog.values()],
			added: update.toolChange.added,
			removed: update.toolChange.removed,
		});
		if (update.toolChange.added.length > 0) {
			text.push(
				`The following tools are now available and may be used: ${update.toolChange.added.map((tool) => tool.name).join(", ")}.`,
			);
		}
		if (update.toolChange.removed.length > 0) {
			text.push(
				`The following tools are no longer available. Do not call them; such calls will be rejected: ${update.toolChange.removed.map((tool) => tool.name).join(", ")}.`,
			);
		}
	}
	content.push({ type: "text", text: text.join("\n\n") });
	return {
		role: "system",
		content,
		timestamp: Date.now(),
	};
}

/** Remove chronological updates and provider-bound reasoning before complete-state replacement. */
export function consolidateSystemPromptMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages
		.filter((message) => message.role !== "system")
		.map((message) => {
			if (message.role === "toolResult" && message.addedToolNames !== undefined) {
				const toolResult = { ...message };
				delete toolResult.addedToolNames;
				return toolResult;
			}
			if (message.role !== "assistant") return message;
			return {
				...message,
				content: message.content.flatMap((block) => {
					if (block.type === "thinking") {
						return block.thinking.trim().length > 0 ? [{ type: "text" as const, text: block.thinking }] : [];
					}
					if (block.type === "toolCall" && block.thoughtSignature !== undefined) {
						const toolCall = { ...block };
						delete toolCall.thoughtSignature;
						return [toolCall];
					}
					return [block];
				}),
			};
		});
}
