import type { Context, Tool } from "../types.ts";
import { resolveMessageToolChange } from "./system-messages.ts";

type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

/** Split current tools into prefix and transcript-loaded definitions. */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
	normalizeName: ToolNameNormalizer = identityToolName,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);
	if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "system" || message.role === "toolResult") {
			const change = resolveMessageToolChange(message, (name) => uniqueTools.get(normalizeName(name)));
			for (const name of change.addedNames) {
				const normalizedName = normalizeName(name);
				if (!usedNames.has(normalizedName)) deferredNames.add(normalizedName);
			}
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(normalizeName(block.name));
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}
