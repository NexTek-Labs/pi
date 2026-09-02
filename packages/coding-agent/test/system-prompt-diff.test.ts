import { describe, expect, test } from "vitest";
import { buildSystemPromptPieces, diffSystemPrompts, type SystemPromptPiece } from "../src/core/system-prompt.ts";

function prompt(value: string): SystemPromptPiece[] {
	return [
		{ type: "literal", text: "before\n" },
		{ type: "value", key: "guidance", text: value },
		{ type: "literal", text: "\nafter" },
	];
}

describe("diffSystemPrompts", () => {
	test("renders semantic value replacements", () => {
		const diff = diffSystemPrompts(prompt("<guidance>old</guidance>"), prompt("<guidance>new</guidance>"));

		expect(diff).toEqual({
			type: "update",
			text: expect.stringContaining(
				"<guidance>old</guidance>\n\nUse the following system guidance instead:\n\n<guidance>new</guidance>",
			),
		});
	});

	test("renders source-specific replacement guidance", () => {
		const cases = [
			{
				key: "projectContext",
				expected: "project context supersedes all previously supplied project-specific instructions",
			},
			{ key: "skills", expected: "available skills have changed" },
			{ key: "tools", expected: "available tool guidance has changed" },
			{ key: "guidelines", expected: "operating guidelines have changed" },
			{ key: "section:review_mode", expected: "<review_mode> system guidance has changed" },
		];
		for (const { key, expected } of cases) {
			const diff = diffSystemPrompts([{ type: "value", key, text: "old" }], [{ type: "value", key, text: "new" }]);
			expect(diff).toEqual({ type: "update", text: expect.stringContaining(expected) });
			expect(diff.type === "update" ? diff.text : "").toContain("new");
		}
	});

	test("renders source-specific removal guidance", () => {
		expect(
			diffSystemPrompts(
				[{ type: "value", key: "skills", text: "old skills" }],
				[{ type: "value", key: "skills", text: "" }],
			),
		).toEqual({
			type: "update",
			text: "Skill guidance is no longer available. Do not use any previously listed skill.",
		});
	});

	test("supports adding keyed guidance without changing the literal layout", () => {
		const previous = prompt("same");
		const current = [...previous, { type: "value" as const, key: "section:new", text: "new guidance" }];

		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: expect.stringContaining("new guidance"),
		});
	});

	test("keeps remaining custom sections stable when an earlier section is removed", () => {
		const previous = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "custom",
			sections: { first: "one", second: "two" },
		});
		const current = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "custom",
			sections: { second: "two" },
		});

		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: "The <first> system guidance no longer applies.",
		});
	});

	test("requires complete replacement when values move across literal boundaries", () => {
		const previous = prompt("same");
		const current: SystemPromptPiece[] = [previous[0], previous[2], previous[1]];

		expect(diffSystemPrompts(previous, current)).toEqual({ type: "replace" });
	});

	test("requires complete replacement when existing values are reordered", () => {
		const previous: SystemPromptPiece[] = [
			{ type: "value", key: "first", text: "one" },
			{ type: "value", key: "second", text: "two" },
		];
		const current = [previous[1], previous[0]];

		expect(diffSystemPrompts(previous, current)).toEqual({ type: "replace" });
	});

	test("requires complete replacement when only value whitespace changes", () => {
		expect(diffSystemPrompts(prompt("same"), prompt(" same "))).toEqual({ type: "replace" });
	});

	test("requires complete replacement when literals change", () => {
		const previous = prompt("same");
		const current = prompt("same");
		current[0] = { type: "literal", text: "changed\n" };

		expect(diffSystemPrompts(previous, current)).toEqual({ type: "replace" });
	});
});
