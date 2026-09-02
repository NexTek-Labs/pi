import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
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
		expect(harness.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "system_prompt" }),
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role: "system" }),
				}),
			]),
		);
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

	test("records provider-independent tool additions and removals", async () => {
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
						if (event.prompt === "second") event.systemPromptOptions.selectedTools = ["second_tool"];
					});
				},
			],
		});

		let loadout: { added: string[]; removed: string[] } | undefined;
		let updateText = "";
		harness.setResponses([
			() => fauxAssistantMessage("first"),
			(context) => {
				for (const message of context.messages) {
					if (message.role !== "system" || typeof message.content === "string") continue;
					for (const block of message.content) {
						if (block.type === "text") updateText += block.text;
						if (block.type === "toolLoadout") {
							loadout = {
								added: block.added.map((tool) => tool.name),
								removed: block.removed.map((tool) => tool.name),
							};
						}
					}
				}
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(loadout).toEqual({ added: ["second_tool"], removed: ["first_tool"] });
		expect(updateText).toContain("second_tool prompt snippet");
		expect(updateText).toContain("Use second_tool carefully");
		expect(harness.session.getActiveToolNames()).toEqual(["second_tool"]);
		const storedStates = harness.sessionManager.getEntries().filter((entry) => entry.type === "system_prompt");
		expect(storedStates.at(-1)?.tools.map((tool) => tool.name)).toEqual(["second_tool"]);
	});
});
