import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, SystemMessage, TextContent, Tool, ToolLoadoutContent } from "@earendil-works/pi-ai/compat";
import { getContextUpdateCapabilities } from "@earendil-works/pi-ai/compat";
import {
	type BuildSystemPromptOptions,
	buildSystemPromptPieces,
	diffSystemPrompts,
	renderSystemPrompt,
	type SystemPromptPiece,
} from "./system-prompt.ts";

export interface ModelContextState {
	prompt: {
		pieces: SystemPromptPiece[];
		effective: string;
		baseline: string;
	};
	tools: Map<string, Tool>;
}

export type PreparedModelContextUpdate =
	| { type: "initial" | "unchanged" | "replacement"; state: ModelContextState }
	| {
			type: "incremental";
			state: ModelContextState;
			promptText?: string;
			addedTools: Tool[];
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
	model?: Model<Api>;
}): PreparedModelContextUpdate {
	const { options, tools, previous } = input;
	const capabilities = getContextUpdateCapabilities(input.model);
	const pieces = buildSystemPromptPieces(options);
	const effective = renderSystemPrompt(pieces);
	if (!previous) {
		return {
			type: "initial",
			state: { prompt: { pieces, effective, baseline: effective }, tools },
		};
	}

	const promptDiff =
		previous.prompt.effective === effective
			? ({ type: "unchanged" } as const)
			: diffSystemPrompts(previous.prompt.pieces, pieces);
	const added = [...tools].filter(([name]) => !previous.tools.has(name)).map(([, tool]) => tool);
	const hasRemovedTools = [...previous.tools.keys()].some((name) => !tools.has(name));
	const declarationChanged = [...tools].some(([name, tool]) => {
		const previousTool = previous.tools.get(name);
		return previousTool !== undefined && !toolDeclarationsEqual(previousTool, tool);
	});
	const previousNames = [...previous.tools.keys()];
	const currentNames = [...tools.keys()];
	const declarationOrderChanged =
		added.length === 0 && !hasRemovedTools && previousNames.some((name, index) => name !== currentNames[index]);
	const requiresReplacement =
		promptDiff.type === "replace" ||
		(options.forceSystemPrompt !== undefined && promptDiff.type !== "unchanged") ||
		(promptDiff.type === "update" && capabilities.systemMessages === "none") ||
		declarationChanged ||
		declarationOrderChanged ||
		hasRemovedTools ||
		(added.length > 0 && capabilities.toolAddition === "none");

	if (requiresReplacement) {
		return {
			type: "replacement",
			state: { prompt: { pieces, effective, baseline: effective }, tools },
		};
	}

	if (promptDiff.type === "unchanged" && added.length === 0) {
		return {
			type: "unchanged",
			state: { prompt: { pieces, effective, baseline: previous.prompt.baseline }, tools },
		};
	}

	const state: ModelContextState = {
		prompt: { pieces, effective, baseline: previous.prompt.baseline },
		tools,
	};
	return {
		type: "incremental",
		state,
		promptText: promptDiff.type === "update" ? promptDiff.text : undefined,
		addedTools: added,
	};
}

/** Serialize one incremental prompt/tool transition into provider-independent context. */
export function createSystemPromptUpdateMessage(
	update: Extract<PreparedModelContextUpdate, { type: "incremental" }>,
): SystemMessage {
	const content: Array<TextContent | ToolLoadoutContent> = [];
	const text = update.promptText ? [update.promptText] : [];
	if (update.addedTools.length > 0) {
		content.push({ type: "toolLoadout", tools: update.addedTools });
		text.push(
			`The following tools are now available and may be used: ${update.addedTools.map((tool) => tool.name).join(", ")}.`,
		);
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
