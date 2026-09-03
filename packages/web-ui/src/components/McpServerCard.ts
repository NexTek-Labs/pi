import { i18n } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { describeMcpServer, type McpServerEntry } from "../storage/stores/mcp-servers-store.ts";

/** Result of a "Test connection" run against one MCP server. */
export type McpServerStatus = { state: "connected"; toolCount: number } | { state: "error"; message: string };

/**
 * One MCP server row: its description line, whether it is enabled, the last
 * test result, and the actions the tab owns.
 *
 * This component deliberately never looks at the header map of its entry. The
 * only place header information is shown is the count inside
 * `describeMcpServer(entry)`, so a saved credential cannot be rendered.
 */
@customElement("mcp-server-card")
export class McpServerCard extends LitElement {
	@property({ type: Object }) entry!: McpServerEntry;
	@property({ type: Object }) status?: McpServerStatus;
	@property() onTest?: (entry: McpServerEntry) => void | Promise<void>;
	@property() onEdit?: (entry: McpServerEntry) => void;
	@property() onDelete?: (entry: McpServerEntry) => void;
	@property() onToggle?: (entry: McpServerEntry) => void;

	@state() private testing = false;

	protected createRenderRoot() {
		return this;
	}

	private async runTest() {
		if (!this.onTest) {
			return;
		}
		this.testing = true;
		this.requestUpdate();
		try {
			await this.onTest(this.entry);
		} finally {
			this.testing = false;
			this.requestUpdate();
		}
	}

	private renderStatus(): TemplateResult | string {
		if (this.testing) {
			return Badge(i18n("Testing..."), "outline");
		}
		if (!this.status) {
			return "";
		}
		// The error text is server-supplied and display-only; it never carries a header value,
		// because the client does not interpolate request headers into its messages.
		return this.status.state === "connected"
			? Badge(`${this.status.toolCount} ${this.status.toolCount === 1 ? "tool" : "tools"}`, "secondary")
			: Badge(this.status.message, "destructive");
	}

	render(): TemplateResult {
		return html`
			<div class="border border-border rounded-lg p-4 space-y-2">
				<div class="flex items-center justify-between gap-4">
					<div class="flex-1 min-w-0">
						<div class="text-sm text-foreground break-all">${describeMcpServer(this.entry)}</div>
						<div class="text-xs text-muted-foreground mt-1 flex items-center gap-2">
							<span>${this.entry.enabled ? "Enabled" : "Disabled"}</span>
							${this.renderStatus()}
						</div>
					</div>
					<div class="flex items-center gap-2 flex-shrink-0">
						${Switch({
							checked: this.entry.enabled,
							onChange: () => this.onToggle?.(this.entry),
						})}
						${Button({
							onClick: () => void this.runTest(),
							variant: "ghost",
							size: "sm",
							disabled: this.testing,
							children: this.testing ? i18n("Testing...") : i18n("Test Connection"),
						})}
						${Button({
							onClick: () => this.onEdit?.(this.entry),
							variant: "ghost",
							size: "sm",
							children: i18n("Edit"),
						})}
						${Button({
							onClick: () => this.onDelete?.(this.entry),
							variant: "ghost",
							size: "sm",
							children: i18n("Delete"),
						})}
					</div>
				</div>
			</div>
		`;
	}
}
