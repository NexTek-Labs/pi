import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { getAppStorage } from "../storage/app-storage.ts";
import type { McpServerEntry } from "../storage/stores/mcp-servers-store.ts";

/** One key/value row of the header editor. */
interface McpHeaderRow {
	key: string;
	value: string;
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Add / edit dialog for one MCP server.
 *
 * Header values are write-only here: an existing entry contributes header
 * *names* only, each row's value input starts empty and shows `(unchanged)`,
 * and saving an empty value keeps what is stored. A value can therefore never
 * be displayed and never be blanked by an edit — deleting a header means
 * removing its row. Typing a value replaces it. Values are trimmed, so a
 * whitespace-only value counts as empty, and two rows for the same header
 * (compared case-insensitively) are rejected rather than resolved last-wins.
 */
export class McpServerDialog extends DialogBase {
	private entry?: McpServerEntry;
	private onSaveCallback?: () => void | Promise<void>;

	@state() private name = "";
	@state() private url = "";
	@state() private namePrefix = "";
	@state() private enabled = true;
	@state() private headerRows: McpHeaderRow[] = [];

	protected modalWidth = "min(700px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(entry?: McpServerEntry, onSave?: () => void | Promise<void>) {
		const dialog = new McpServerDialog();
		dialog.entry = entry;
		dialog.onSaveCallback = onSave;
		document.body.appendChild(dialog);
		dialog.initializeFromEntry();
		dialog.open();
		dialog.requestUpdate();
	}

	private initializeFromEntry() {
		this.name = this.entry?.name ?? "";
		this.url = this.entry?.url ?? "";
		this.namePrefix = this.entry?.namePrefix ?? "";
		this.enabled = this.entry?.enabled ?? true;
		// Names only: a stored value is never loaded into an input.
		const names = this.entry?.headers ? Object.keys(this.entry.headers) : [];
		this.headerRows = names.map((key) => ({ key, value: "" }));
		if (this.headerRows.length === 0) {
			this.headerRows = [{ key: "", value: "" }];
		}
	}

	/** The stored value for `key`, matched case-insensitively, or undefined for a new header. */
	private storedValue(key: string): string | undefined {
		const stored = this.entry?.headers;
		const wanted = key.trim().toLowerCase();
		if (!stored || !wanted) {
			return undefined;
		}
		for (const [name, value] of Object.entries(stored)) {
			if (name.toLowerCase() === wanted) {
				return value;
			}
		}
		return undefined;
	}

	private addHeaderRow() {
		this.headerRows = [...this.headerRows, { key: "", value: "" }];
	}

	private removeHeaderRow(index: number) {
		this.headerRows = this.headerRows.filter((_, rowIndex) => rowIndex !== index);
	}

	private async save() {
		const name = this.name.trim();
		const url = this.url.trim();
		if (!name || !url) {
			alert(i18n("Please fill in all required fields"));
			return;
		}
		if (!isHttpUrl(url)) {
			alert("Enter an http or https URL");
			return;
		}

		const rows: McpHeaderRow[] = [];
		for (const row of this.headerRows) {
			const key = row.key.trim();
			const value = row.value.trim();
			if (!key && !value) {
				continue; // an untouched blank row is not a header
			}
			if (!key) {
				alert(i18n("Please fill in all required fields"));
				return;
			}
			rows.push({ key, value });
		}

		const headers: Record<string, string> = {};
		const seen = new Set<string>();
		for (const row of rows) {
			const lower = row.key.toLowerCase();
			if (seen.has(lower)) {
				// Two rows for one header are never resolved by last-wins.
				alert(i18n("Please fill in all required fields"));
				return;
			}
			seen.add(lower);
			// An empty value keeps the stored one; a header that is new must carry a value.
			const value = row.value || this.storedValue(row.key);
			if (!value) {
				alert(i18n("Please fill in all required fields"));
				return;
			}
			headers[row.key] = value;
		}

		const entry: McpServerEntry = {
			id: this.entry?.id ?? crypto.randomUUID(),
			name,
			url,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			enabled: this.enabled,
			namePrefix: this.namePrefix.trim() || undefined,
		};

		try {
			const store = getAppStorage().mcpServers;
			if (!store) {
				alert("This application has not configured MCP server storage.");
				return;
			}
			await store.set(entry);
		} catch {
			alert("Failed to save MCP server");
			return;
		}

		if (this.onSaveCallback) {
			await this.onSaveCallback();
		}
		this.close();
	}

	private renderHeaderRows(): TemplateResult {
		return html`
			<div class="flex flex-col gap-2">
				${this.headerRows.map(
					(row, index) => html`
						<div class="flex items-center gap-2">
							<div class="flex-1">
								${Input({
									value: row.key,
									placeholder: "Header name",
									onInput: (e: Event) => {
										row.key = (e.target as HTMLInputElement).value;
									},
								})}
							</div>
							<div class="flex-1">
								${Input({
									value: row.value,
									placeholder: this.storedValue(row.key) === undefined ? "Header value" : "(unchanged)",
									onInput: (e: Event) => {
										row.value = (e.target as HTMLInputElement).value;
									},
								})}
							</div>
							${Button({
								onClick: () => this.removeHeaderRow(index),
								variant: "ghost",
								size: "sm",
								children: i18n("Remove"),
							})}
						</div>
					`,
				)}
				${Button({
					onClick: () => this.addHeaderRow(),
					variant: "outline",
					size: "sm",
					children: "Add header",
				})}
			</div>
		`;
	}

	protected override renderContent(): TemplateResult {
		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<h2 class="text-lg font-semibold text-foreground">${this.entry ? "Edit MCP Server" : "Add MCP Server"}</h2>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "mcp-name", children: "Name" })}
							${Input({
								id: "mcp-name",
								value: this.name,
								placeholder: "gbrain",
								onInput: (e: Event) => {
									this.name = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "mcp-url", children: "URL" })}
							${Input({
								id: "mcp-url",
								value: this.url,
								placeholder: "http://127.0.0.1:8795/mcp",
								onInput: (e: Event) => {
									this.url = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "mcp-name-prefix", children: "Tool name prefix (optional)" })}
							${Input({
								id: "mcp-name-prefix",
								value: this.namePrefix,
								placeholder: "gbrain_",
								onInput: (e: Event) => {
									this.namePrefix = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex items-center justify-between">
							<span class="text-sm font-medium text-foreground">Enabled</span>
							${Switch({
								checked: this.enabled,
								onChange: (checked: boolean) => {
									this.enabled = checked;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ children: "Headers" })}
							<p class="text-xs text-muted-foreground">
								Values are never shown after saving. Leave a value empty to keep the stored one, type to replace
								it, and remove the row to delete the header.
							</p>
							${this.renderHeaderRows()}
						</div>
					</div>
				</div>

				<div class="p-6 flex-shrink-0 border-t border-border flex justify-end gap-2">
					${Button({ onClick: () => this.close(), variant: "ghost", children: i18n("Cancel") })}
					${Button({
						onClick: () => void this.save(),
						variant: "default",
						disabled: !this.name || !this.url,
						children: i18n("Save"),
					})}
				</div>
			</div>
		`;
	}
}

customElements.define("mcp-server-dialog", McpServerDialog);
