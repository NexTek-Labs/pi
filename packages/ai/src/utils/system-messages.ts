import type { Context, Message, SystemMessage, TextContent, Tool } from "../types.ts";

export interface ResolvedToolLoadoutChange {
	tools: Tool[];
	added: Tool[];
	removed: Tool[];
	addedNames: string[];
	removedNames: string[];
}

export function getSystemMessageText(message: SystemMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function getSystemMessageToolLoadout(message: SystemMessage): {
	tools: Tool[];
	added: Tool[];
	removed: Tool[];
} {
	if (typeof message.content === "string") return { tools: [], added: [], removed: [] };
	let tools: Tool[] = [];
	const added: Tool[] = [];
	const removed: Tool[] = [];
	for (const block of message.content) {
		if (block.type !== "toolLoadout") continue;
		tools = [...block.tools];
		added.push(...block.added);
		removed.push(...block.removed);
	}
	return { tools, added, removed };
}

/** Normalize rich system loadouts and legacy tool-result additions into one chronological change. */
export function resolveMessageToolLoadout(
	message: Message,
	resolveTool: (name: string) => Tool | undefined = () => undefined,
): ResolvedToolLoadoutChange {
	if (message.role === "system") {
		const loadout = getSystemMessageToolLoadout(message);
		return {
			...loadout,
			addedNames: loadout.added.map((tool) => tool.name),
			removedNames: loadout.removed.map((tool) => tool.name),
		};
	}
	if (message.role === "toolResult") {
		const addedNames = [...new Set(message.addedToolNames ?? [])];
		return {
			tools: [],
			added: addedNames.flatMap((name) => {
				const tool = resolveTool(name);
				return tool ? [tool] : [];
			}),
			removed: [],
			addedNames,
			removedNames: [],
		};
	}
	return { tools: [], added: [], removed: [], addedNames: [], removedNames: [] };
}

/** Fold transcript system updates into complete top-level state for providers without native support. */
export function hardFallbackSystemMessages(context: Context): Context {
	const systemMessages = context.messages.filter((message) => message.role === "system");
	if (systemMessages.length === 0) return context;

	let systemPrompt = context.systemPrompt ?? "";
	let appendedGuidance: string[] = [];
	for (const message of systemMessages) {
		if (message.systemPrompt !== undefined) {
			systemPrompt = message.systemPrompt;
			appendedGuidance = [];
		} else {
			const text = getSystemMessageText(message);
			if (text.length > 0) appendedGuidance.push(text);
		}
	}
	if (appendedGuidance.length > 0) {
		systemPrompt = [systemPrompt, ...appendedGuidance].filter((text) => text.length > 0).join("\n\n");
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
	return { ...context, systemPrompt, messages };
}
