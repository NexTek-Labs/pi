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
	test("renders additions, replacements, and removals as superseding guidance", () => {
		expect(diffSystemPrompts(prompt("old"), prompt("new"))).toEqual({
			type: "update",
			text: "The system guidance has changed. The following supersedes the previous system guidance:\n\nnew",
		});
		expect(diffSystemPrompts([], [{ type: "value", key: "section:review_mode", text: "Review carefully." }])).toEqual(
			{
				type: "update",
				text: "The following <review_mode> system guidance now applies:\n\nReview carefully.",
			},
		);
		expect(
			diffSystemPrompts(
				[{ type: "value", key: "skills", text: "old skills" }],
				[{ type: "value", key: "skills", text: "" }],
			),
		).toEqual({ type: "update", text: "The previous skill guidance no longer applies." });
	});

	test("emits only strict line suffixes added to base instructions", () => {
		const previous = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "base instructions",
			appendSystemPrompt: "existing addition",
		});
		const current = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "base instructions",
			appendSystemPrompt: "existing addition\nnew addition",
		});

		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: "The following additional base system instructions now apply:\n\nnew addition",
		});
	});

	test("replaces base instructions after non-additive changes", () => {
		const base = { cwd: "/tmp", customPrompt: "base instructions", appendSystemPrompt: "existing addition" };
		for (const current of [
			{ ...base, customPrompt: "changed instructions" },
			{ ...base, appendSystemPrompt: "replacement addition" },
			{ ...base, appendSystemPrompt: "" },
			{ ...base, appendSystemPrompt: "inserted addition\nexisting addition" },
		]) {
			expect(diffSystemPrompts(buildSystemPromptPieces(base), buildSystemPromptPieces(current))).toEqual({
				type: "replace",
			});
		}
	});

	test("only appends to prompt tails", () => {
		const previous = buildSystemPromptPieces({ cwd: "/tmp", promptTail: "\nold tail" });
		expect(
			diffSystemPrompts(previous, buildSystemPromptPieces({ cwd: "/tmp", promptTail: "\nold tail\nnew tail" })),
		).toEqual({
			type: "update",
			text: "The following additional system guidance now applies:\n\nnew tail",
		});
		for (const promptTail of ["", "\nnew tail", "\ninserted\nold tail"]) {
			expect(diffSystemPrompts(previous, buildSystemPromptPieces({ cwd: "/tmp", promptTail }))).toEqual({
				type: "replace",
			});
		}
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
			text: "The previous <first> system guidance no longer applies.",
		});
	});

	test("replaces structurally incompatible prompts", () => {
		const base = prompt("same");
		const reordered: SystemPromptPiece[] = [
			{ type: "value", key: "second", text: "two" },
			{ type: "value", key: "first", text: "one" },
		];
		const originalOrder = [reordered[1], reordered[0]];
		const changedLiteral = prompt("same");
		changedLiteral[0] = { type: "literal", text: "changed\n" };

		for (const [previous, current] of [
			[base, [base[0], base[2], base[1]]],
			[originalOrder, reordered],
			[base, prompt(" same ")],
			[base, changedLiteral],
		] as Array<[SystemPromptPiece[], SystemPromptPiece[]]>) {
			expect(diffSystemPrompts(previous, current)).toEqual({ type: "replace" });
		}
	});
});
