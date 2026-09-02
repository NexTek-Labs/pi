import type { Context, Message, SystemMessage, TextContent, Tool } from "../types.ts";

export function getSystemMessageText(message: SystemMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function getSystemMessageTools(message: SystemMessage): Tool[] {
	if (typeof message.content === "string") return [];
	return message.content.flatMap((block) => (block.type === "toolLoadout" ? block.tools : []));
}

/** Normalize rich system loadouts and legacy tool-result additions. */
export function resolveMessageToolLoadout(
	message: Message,
	resolveTool: (name: string) => Tool | undefined = () => undefined,
) {
	if (message.role === "system") {
		const tools = getSystemMessageTools(message);
		return { tools, names: tools.map((tool) => tool.name) };
	}
	if (message.role === "toolResult") {
		const names = [...new Set(message.addedToolNames ?? [])];
		return {
			tools: names.flatMap((name) => {
				const tool = resolveTool(name);
				return tool ? [tool] : [];
			}),
			names,
		};
	}
	return { tools: [], names: [] };
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
