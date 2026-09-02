import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Tool } from "../src/types.ts";
import { fallbackUnsupportedToolChanges, hardFallbackSystemMessages } from "../src/utils/system-messages.ts";

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

describe("hardFallbackSystemMessages", () => {
	test("uses complete current state and removes incompatible replay", () => {
		const context: Context = {
			systemPrompt: "old",
			effectiveSystemPrompt: "new",
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

	test("preserves provider replay data when no fallback is needed", () => {
		const context: Context = { systemPrompt: "prompt", messages: [assistant] };

		expect(hardFallbackSystemMessages(context)).toBe(context);
	});

	test("falls back only for tool changes unsupported by the transport", () => {
		const tool: Tool = { name: "late_tool", description: "late tool", parameters: Type.Object({}) };
		const addition: Context = {
			systemPrompt: "old",
			effectiveSystemPrompt: "current",
			messages: [{ role: "system", content: "added", toolsAdded: [tool], timestamp: 1 }],
			tools: [tool],
		};
		const removal: Context = {
			...addition,
			messages: [{ role: "system", content: "removed", toolsRemoved: [tool], timestamp: 1 }],
			tools: [],
		};

		expect(fallbackUnsupportedToolChanges(addition, "all")).toBe(addition);
		expect(fallbackUnsupportedToolChanges(addition, "additions")).toBe(addition);
		expect(fallbackUnsupportedToolChanges(addition, "none").messages).toEqual([]);
		expect(fallbackUnsupportedToolChanges(removal, "additions").messages).toEqual([]);
	});

	test("appends standalone guidance when complete effective state is unavailable", () => {
		const fallback = hardFallbackSystemMessages({
			systemPrompt: "old",
			messages: [
				{ role: "system", content: "first delta", timestamp: 1 },
				{ role: "system", content: "later standalone guidance", timestamp: 2 },
			],
		});

		expect(fallback.systemPrompt).toBe("old\n\nfirst delta\n\nlater standalone guidance");
	});

	test("lets unsupported Anthropic models hard-fallback instead of throwing", async () => {
		const context: Context = {
			systemPrompt: "old",
			effectiveSystemPrompt: "new",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{ role: "system", content: "changed", timestamp: 2 },
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
