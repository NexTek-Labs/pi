import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai/compat";
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
			toolsAdded: Tool[];
			toolsRemoved: Tool[];
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
}): PreparedModelContextUpdate {
	const { options, tools, previous } = input;
	const pieces = buildSystemPromptPieces(options);
	const currentPrompt = renderSystemPrompt(pieces);
	if (!previous) {
		return {
			type: "initial",
			state: { prompt: { pieces, baseline: currentPrompt }, tools },
		};
	}

	const promptDiff =
		renderSystemPrompt(previous.prompt.pieces) === currentPrompt
			? ({ type: "unchanged" } as const)
			: diffSystemPrompts(previous.prompt.pieces, pieces);
	const currentToolEntries = [...tools];
	let toolsAdded = currentToolEntries.filter(([name]) => !previous.tools.has(name)).map(([, tool]) => tool);
	let toolsRemoved = [...previous.tools].filter(([name]) => !tools.has(name)).map(([, tool]) => tool);
	for (const [name, tool] of tools) {
		const previousTool = previous.tools.get(name);
		if (previousTool !== undefined && !toolDeclarationsEqual(previousTool, tool)) {
			toolsAdded.push(tool);
			toolsRemoved.push(previousTool);
		}
	}

	// Map insertion order is provider-visible. If applying the minimal delta would
	// not reproduce the exact current declaration list, encode a full remove/add
	// transition. Adapters can then replay the same provider-neutral delta either
	// incrementally or as a complete provider snapshot.
	const replayedTools = new Map(previous.tools);
	for (const tool of toolsRemoved) replayedTools.delete(tool.name);
	for (const tool of toolsAdded) replayedTools.set(tool.name, tool);
	if (
		[...replayedTools].some(([name, tool], index) => {
			const current = currentToolEntries[index];
			return current === undefined || current[0] !== name || !toolDeclarationsEqual(current[1], tool);
		}) ||
		replayedTools.size !== tools.size
	) {
		toolsAdded = [...tools.values()];
		toolsRemoved = [...previous.tools.values()];
	}

	const requiresReplacement =
		promptDiff.type === "replace" || (options.forceSystemPrompt !== undefined && promptDiff.type !== "unchanged");

	if (requiresReplacement) {
		return {
			type: "replacement",
			state: { prompt: { pieces, baseline: currentPrompt }, tools },
		};
	}

	if (promptDiff.type === "unchanged" && toolsAdded.length === 0 && toolsRemoved.length === 0) {
		return {
			type: "unchanged",
			state: { prompt: { pieces, baseline: previous.prompt.baseline }, tools },
		};
	}

	const state: ModelContextState = {
		prompt: { pieces, baseline: previous.prompt.baseline },
		tools,
	};
	return {
		type: "incremental",
		state,
		promptText: promptDiff.type === "update" ? promptDiff.text : undefined,
		toolsAdded,
		toolsRemoved,
	};
}

/** Serialize one incremental prompt/tool transition into provider-independent context. */
export function createSystemPromptUpdateMessage(
	update: Extract<PreparedModelContextUpdate, { type: "incremental" }>,
): SystemMessage {
	const text = update.promptText ? [update.promptText] : [];
	const addedNames = new Set(update.toolsAdded.map((tool) => tool.name));
	const removedNames = new Set(update.toolsRemoved.map((tool) => tool.name));
	const refreshedNames = [...addedNames].filter((name) => removedNames.has(name));
	const newNames = [...addedNames].filter((name) => !removedNames.has(name));
	const unavailableNames = [...removedNames].filter((name) => !addedNames.has(name));
	if (refreshedNames.length > 0) {
		text.push(`The active declarations for the following tools have changed: ${refreshedNames.join(", ")}.`);
	}
	if (newNames.length > 0) {
		text.push(`The following tools are now available and may be used: ${newNames.join(", ")}.`);
	}
	if (unavailableNames.length > 0) {
		text.push(
			`The following tools are no longer available. Do not call them; such calls will be rejected: ${unavailableNames.join(", ")}.`,
		);
	}
	return {
		role: "system",
		content: text.join("\n\n"),
		toolsAdded: update.toolsAdded.length > 0 ? update.toolsAdded : undefined,
		toolsRemoved: update.toolsRemoved.length > 0 ? update.toolsRemoved : undefined,
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
