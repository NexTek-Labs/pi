import { describe, expect, test } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";
import { hardFallbackSystemMessages, resolveMessageToolLoadout } from "../src/utils/system-messages.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "signed" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-4-8",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

class PayloadCaptured extends Error {}

describe("resolveMessageToolLoadout", () => {
	test("normalizes rich system loadouts and legacy added tool names", () => {
		const tool = { name: "late_tool", description: "late", parameters: { type: "object" } };
		const system = resolveMessageToolLoadout({
			role: "system",
			content: [{ type: "toolLoadout", tools: [tool], added: [tool], removed: [] }],
			timestamp: 1,
		});
		const legacy = resolveMessageToolLoadout(
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "loader",
				content: [{ type: "text", text: "loaded" }],
				isError: false,
				addedToolNames: ["late_tool"],
				timestamp: 2,
			},
			(name) => (name === tool.name ? tool : undefined),
		);

		expect(system.added).toEqual([tool]);
		expect(legacy.added).toEqual([tool]);
		expect(system.addedNames).toEqual(legacy.addedNames);
	});
});

describe("hardFallbackSystemMessages", () => {
	test("uses complete current state and removes incompatible replay", () => {
		const context: Context = {
			systemPrompt: "old",
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "loader",
					content: [{ type: "text", text: "loaded" }],
					isError: false,
					timestamp: 2,
					addedToolNames: ["late_tool"],
				},
				{
					role: "system",
					content: "changed",
					systemPrompt: "new",
					timestamp: 3,
				},
			],
		};

		const fallback = hardFallbackSystemMessages(context);

		expect(fallback.systemPrompt).toBe("new");
		expect(fallback.messages).toEqual([
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "reasoning" }],
			}),
			expect.objectContaining({ role: "toolResult" }),
		]);
		expect(fallback.messages[1]).not.toHaveProperty("addedToolNames");
	});

	test("keeps guidance appended after the latest complete prompt", () => {
		const fallback = hardFallbackSystemMessages({
			systemPrompt: "old",
			messages: [
				{ role: "system", content: "first delta", systemPrompt: "complete", timestamp: 1 },
				{ role: "system", content: "later standalone guidance", timestamp: 2 },
			],
		});

		expect(fallback.systemPrompt).toBe("complete\n\nlater standalone guidance");
	});

	test("lets unsupported Anthropic models hard-fallback instead of throwing", async () => {
		const context: Context = {
			systemPrompt: "old",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{ role: "system", content: "changed", systemPrompt: "new", timestamp: 2 },
			],
		};
		let payload: { system?: Array<{ text?: string }>; messages?: Array<{ role: string }> } | undefined;
		const stream = streamSimple(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey: "test",
			onPayload: (value) => {
				payload = value as typeof payload;
				throw new PayloadCaptured();
			},
		});
		await stream.result();

		expect(payload?.system?.[0]?.text).toBe("new");
		expect(payload?.messages?.map((message) => message.role)).toEqual(["user"]);
	});
});
