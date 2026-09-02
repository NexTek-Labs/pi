import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML system prompt update rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("renders prompt state entries in the sidebar and conversation path", () => {
		expect(templateJs).toContain("case 'system_prompt':");
		expect(templateJs).toContain("[system prompt update]");
		expect(templateJs).toMatch(/entry\.type === 'system_prompt'[\s\S]*class="system-prompt-change"/);
	});
});
