import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("AgentSession system prompt updates", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	test("keeps the provider baseline stable and appends value changes as system messages", async () => {
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.prompt === "plan") {
							event.systemPromptOptions.sections.plan_mode = "Do not modify files.";
						}
					});
				},
			],
		});

		expect(harness.session.model?.api).toMatch(/^faux:/);
		const providerPrompts: string[] = [];
		const providerSystemMessages: string[][] = [];
		const capture = (context: Context, response: string) => {
			providerPrompts.push(context.systemPrompt ?? "");
			providerSystemMessages.push(
				context.messages.flatMap((message) => {
					if (message.role !== "system") return [];
					if (typeof message.content === "string") return [message.content];
					return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				}),
			);
			return fauxAssistantMessage(response);
		};
		harness.setResponses([
			(context) => capture(context, "first"),
			(context) => capture(context, "second"),
			(context) => capture(context, "third"),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("plan");
		await harness.session.prompt("resume");

		expect(providerPrompts[1]).toBe(providerPrompts[0]);
		expect(providerPrompts[2]).toBe(providerPrompts[0]);
		expect(providerSystemMessages[0]).toEqual([]);
		expect(providerSystemMessages[1]?.[0]).toContain("<plan_mode>\nDo not modify files.\n</plan_mode>");
		expect(providerSystemMessages[2]?.at(-1)).toContain("<plan_mode> system guidance no longer applies");
	});

	test("uses persisted prompt pieces to generate an update after restart", async () => {
		let guidance = "old guidance";
		const createGuidanceExtension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections.runtime_guidance = guidance;
			});
		};
		const firstHarness = await createHarness({ extensionFactories: [createGuidanceExtension] });
		firstHarness.setResponses([fauxAssistantMessage("first")]);
		await firstHarness.session.prompt("first");
		const sessionManager = firstHarness.sessionManager;
		firstHarness.cleanup();

		guidance = "new guidance";
		harness = await createHarness({ sessionManager, extensionFactories: [createGuidanceExtension] });
		let systemMessages: string[] = [];
		harness.setResponses([
			(context) => {
				systemMessages = context.messages.flatMap((message) => {
					if (message.role !== "system") return [];
					if (typeof message.content === "string") return [message.content];
					return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				});
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("second");

		expect(systemMessages.at(-1)).toContain("new guidance");
		expect(systemMessages.at(-1)).toContain("supersedes the previous");
	});

	test("uses complete-state fallback for legacy full prompt replacements", async () => {
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) =>
						event.prompt === "replace" ? { systemPrompt: "replacement prompt" } : undefined,
					);
				},
			],
		});
		const contexts: Context[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("first");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("replace");

		expect(contexts[1]?.systemPrompt).toBe("replacement prompt");
		expect(contexts[1]?.messages.some((message) => message.role === "system")).toBe(false);
	});

	test("checkpoints the effective prompt after compaction", async () => {
		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compact summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.compact();

		const entries = harness.sessionManager.getEntries();
		const compactionIndex = entries.map((entry) => entry.type).lastIndexOf("compaction");
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		const checkpoint = entries[compactionIndex + 1];
		expect(checkpoint?.type).toBe("system_prompt");
		if (checkpoint?.type === "system_prompt") {
			expect(checkpoint.prompt.map((piece) => piece.text).join("")).toBe(harness.session.systemPrompt);
		}
	});

	test("does not commit a tool loadout when prompt validation fails", async () => {
		const makeTool = (name: string) => ({
			name,
			label: name,
			description: `${name} description`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
		});
		harness = await createHarness({
			tools: [makeTool("first_tool"), makeTool("second_tool")],
			initialActiveToolNames: ["first_tool"],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.prompt !== "invalid") return;
						event.systemPromptOptions.selectedTools = ["second_tool"];
						event.systemPromptOptions.sections.INVALID = "invalid section";
					});
				},
			],
		});
		let nextTools: string[] | undefined;
		let nextHasLoadout = false;
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				nextTools = context.tools?.map((tool) => tool.name);
				nextHasLoadout = context.messages.some(
					(message) =>
						message.role === "system" &&
						typeof message.content !== "string" &&
						message.content.some((block) => block.type === "toolLoadout"),
				);
				return fauxAssistantMessage("next");
			},
		]);

		await harness.session.prompt("first");
		await expect(harness.session.prompt("invalid")).rejects.toThrow("Invalid system prompt section name");
		expect(harness.session.getActiveToolNames()).toEqual(["first_tool"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "system_prompt")).toHaveLength(1);

		await harness.session.prompt("next");
		expect(nextTools).toEqual(["first_tool"]);
		expect(nextHasLoadout).toBe(false);
	});

	test("records tool additions and falls back to a snapshot for removals", async () => {
		harness = await createHarness({
			initialActiveToolNames: ["first_tool"],
			extensionFactories: [
				(pi) => {
					for (const name of ["first_tool", "second_tool"]) {
						pi.registerTool({
							name,
							label: name,
							description: `${name} description`,
							parameters: Type.Object({}),
							promptSnippet: `${name} prompt snippet`,
							promptGuidelines: [`Use ${name} carefully`],
							execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
						});
					}
					pi.on("before_agent_start", (event) => {
						if (event.prompt === "first") event.systemPromptOptions.selectedTools = ["first_tool"];
						if (event.prompt === "second")
							event.systemPromptOptions.selectedTools = ["first_tool", "second_tool"];
						if (event.prompt === "third") event.systemPromptOptions.selectedTools = ["second_tool"];
					});
				},
			],
		});

		let loadout: string[] | undefined;
		let updateText = "";
		let removalHasSystemMessage = true;
		harness.setResponses([
			() => fauxAssistantMessage("first"),
			(context) => {
				for (const message of context.messages) {
					if (message.role !== "system" || typeof message.content === "string") continue;
					for (const block of message.content) {
						if (block.type === "text") updateText += block.text;
						if (block.type === "toolLoadout") loadout = block.tools.map((tool) => tool.name);
					}
				}
				return fauxAssistantMessage("second");
			},
			(context) => {
				removalHasSystemMessage = context.messages.some((message) => message.role === "system");
				return fauxAssistantMessage("third");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.prompt("third");

		expect(loadout).toEqual(["second_tool"]);
		expect(removalHasSystemMessage).toBe(false);
		expect(updateText).toContain("second_tool prompt snippet");
		expect(updateText).toContain("Use second_tool carefully");
		expect(harness.session.getActiveToolNames()).toEqual(["second_tool"]);
		const storedStates = harness.sessionManager.getEntries().filter((entry) => entry.type === "system_prompt");
		expect(storedStates.at(-1)?.tools.map((tool) => tool.name)).toEqual(["second_tool"]);
	});
});
