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

export type PreparedModelContextUpdate =
	| { type: "initial" | "unchanged" | "replacement"; state: ModelContextState }
	| {
			type: "incremental";
			state: ModelContextState;
			promptText?: string;
			toolChange: ToolLoadoutChange;
	  };

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
	const { options, tools, previous, capabilities } = input;
	const pieces = buildSystemPromptPieces(options);
	const effective = renderSystemPrompt(pieces);
	if (!previous) {
		return {
			type: "initial",
			state: {
				prompt: { pieces, effective, baseline: effective },
				tools: { visible: tools, catalog: new Map(tools) },
			},
		};
	}

	const promptDiff =
		previous.prompt.effective === effective
			? ({ type: "unchanged" } as const)
			: diffSystemPrompts(previous.prompt.pieces, pieces);
	const added = [...tools].filter(([name]) => !previous.tools.visible.has(name)).map(([, tool]) => tool);
	const removed = [...previous.tools.visible].filter(([name]) => !tools.has(name)).map(([, tool]) => tool);
	const declarationChanged = [...tools].some(([name, tool]) => {
		const previousTool = previous.tools.visible.get(name) ?? previous.tools.catalog.get(name);
		return previousTool !== undefined && !toolDeclarationsEqual(previousTool, tool);
	});
	const previousNames = [...previous.tools.visible.keys()];
	const currentNames = [...tools.keys()];
	const declarationOrderChanged =
		added.length === 0 && removed.length === 0 && previousNames.some((name, index) => name !== currentNames[index]);
	const requiresReplacement =
		promptDiff.type === "replace" ||
		(options.forceSystemPrompt !== undefined && promptDiff.type !== "unchanged") ||
		(promptDiff.type === "update" && capabilities.systemMessages === "none") ||
		declarationChanged ||
		declarationOrderChanged ||
		(added.length > 0 && capabilities.toolAddition === "none") ||
		(removed.length > 0 && capabilities.toolRemoval === "none");

	if (requiresReplacement) {
		return {
			type: "replacement",
			state: {
				prompt: { pieces, effective, baseline: effective },
				tools: { visible: tools, catalog: new Map(tools) },
			},
		};
	}

	if (promptDiff.type === "unchanged" && added.length === 0 && removed.length === 0) {
		return {
			type: "unchanged",
			state: {
				prompt: { pieces, effective, baseline: previous.prompt.baseline },
				tools: { visible: tools, catalog: previous.tools.catalog },
			},
		};
	}

	const catalog = new Map(previous.tools.catalog);
	for (const tool of added) catalog.set(tool.name, tool);
	const state: ModelContextState = {
		prompt: { pieces, effective, baseline: previous.prompt.baseline },
		tools: { visible: tools, catalog },
	};
	return {
		type: "incremental",
		state,
		promptText: promptDiff.type === "update" ? promptDiff.text : undefined,
		toolChange: { added, removed },
	};
}

/** Serialize one incremental prompt/tool transition into provider-independent context. */
export function createSystemPromptUpdateMessage(
	update: Extract<PreparedModelContextUpdate, { type: "incremental" }>,
): SystemMessage {
	const content: Array<TextContent | ToolLoadoutContent> = [];
	const text = update.promptText ? [update.promptText] : [];
	const { added, removed } = update.toolChange;
	if (added.length > 0 || removed.length > 0) {
		content.push({
			type: "toolLoadout",
			tools: [...update.state.tools.catalog.values()],
			added,
			removed,
		});
		if (added.length > 0) {
			text.push(
				`The following tools are now available and may be used: ${added.map((tool) => tool.name).join(", ")}.`,
			);
		}
		if (removed.length > 0) {
			text.push(
				`The following tools are no longer available. Do not call them; such calls will be rejected: ${removed.map((tool) => tool.name).join(", ")}.`,
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
