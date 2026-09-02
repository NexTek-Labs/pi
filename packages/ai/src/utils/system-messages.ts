import type { Context, Message, SystemMessage, Tool } from "../types.ts";

export interface ResolvedToolChange {
	added: Tool[];
	removed: Tool[];
	addedNames: string[];
}

export function getSystemMessageText(message: SystemMessage): string {
	return typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
}

export function getSystemMessageToolChange(message: SystemMessage): ResolvedToolChange {
	const added = message.toolsAdded ?? [];
	const removed = message.toolsRemoved ?? [];
	return {
		added,
		removed,
		addedNames: added.map((tool) => tool.name),
	};
}

/** Normalize first-class system updates and legacy tool-result additions into one chronological change. */
export function resolveMessageToolChange(
	message: Message,
	resolveTool: (name: string) => Tool | undefined = () => undefined,
): ResolvedToolChange {
	if (message.role === "system") return getSystemMessageToolChange(message);
	if (message.role === "toolResult") {
		const addedNames = [...new Set(message.addedToolNames ?? [])];
		return {
			added: addedNames.flatMap((name) => {
				const tool = resolveTool(name);
				return tool ? [tool] : [];
			}),
			removed: [],
			addedNames,
		};
	}
	return { added: [], removed: [], addedNames: [] };
}

/** Fold transcript system updates into complete top-level state for providers without native support. */
export function hardFallbackSystemMessages(context: Context): Context {
	const systemMessages = context.messages.filter((message) => message.role === "system");
	if (systemMessages.length === 0) return context;

	let systemPrompt = context.effectiveSystemPrompt ?? context.systemPrompt ?? "";
	if (context.effectiveSystemPrompt === undefined) {
		const appendedGuidance = systemMessages.map(getSystemMessageText).filter((text) => text.length > 0);
		if (appendedGuidance.length > 0) {
			systemPrompt = [systemPrompt, ...appendedGuidance].filter((text) => text.length > 0).join("\n\n");
		}
	}
	const messages = context.messages
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
	return { ...context, systemPrompt, effectiveSystemPrompt: systemPrompt, messages };
}

export type ToolChangeSupport = "none" | "additions" | "all";

/** Replace chronological updates when a transport cannot represent their tool deltas. */
export function fallbackUnsupportedToolChanges(context: Context, support: ToolChangeSupport): Context {
	if (support === "all") return context;
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		const change = getSystemMessageToolChange(message);
		if (change.removed.length > 0 || (support === "none" && change.added.length > 0)) {
			return hardFallbackSystemMessages(context);
		}
	}
	return context;
}
