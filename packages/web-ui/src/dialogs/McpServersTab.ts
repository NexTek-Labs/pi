import { McpHttpClient } from "@earendil-works/pi-agent-core";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../components/McpServerCard.ts";
import type { McpServerStatus } from "../components/McpServerCard.ts";
import { getAppStorage } from "../storage/app-storage.ts";
import type { McpServerEntry, McpServersStore } from "../storage/stores/mcp-servers-store.ts";
import { McpServerDialog } from "./McpServerDialog.ts";
import { SettingsTab } from "./SettingsDialog.ts";

/**
 * Settings tab that lists, adds, edits, deletes and test-connects MCP servers.
 *
 * The store is optional by design: a host app that has not constructed an
 * `McpServersStore` sees a one-line message instead of the list. Nothing here
 * wires the servers' tools into an agent.
 */
@customElement("mcp-servers-tab")
export class McpServersTab extends SettingsTab {
	@state() private servers: McpServerEntry[] = [];
	@state() private statuses = new Map<string, McpServerStatus>();

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadServers();
	}

	getTabName(): string {
		return "MCP Servers";
	}

	/** The host-configured store, or undefined when there is none (including uninitialized storage). */
	private store(): McpServersStore | undefined {
		try {
			return getAppStorage().mcpServers;
		} catch {
			return undefined;
		}
	}

	private async loadServers() {
		const store = this.store();
		this.servers = store ? await store.getAll() : [];
		this.requestUpdate();
	}

	private async addServer() {
		await McpServerDialog.open(undefined, async () => {
			await this.loadServers();
		});
	}

	private async editServer(entry: McpServerEntry) {
		await McpServerDialog.open(entry, async () => {
			await this.loadServers();
		});
	}

	private async testServer(entry: McpServerEntry) {
		const client = new McpHttpClient({ name: entry.name, url: entry.url, headers: entry.headers });
		try {
			const tools = await client.listTools();
			this.statuses.set(entry.id, { state: "connected", toolCount: tools.length });
		} catch (error) {
			this.statuses.set(entry.id, {
				state: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		this.requestUpdate();
	}

	private async toggleServer(entry: McpServerEntry) {
		const store = this.store();
		if (!store) {
			return;
		}
		await store.set({ ...entry, enabled: !entry.enabled });
		await this.loadServers();
	}

	private async deleteServer(entry: McpServerEntry) {
		if (!confirm("Are you sure you want to delete this MCP server?")) {
			return;
		}
		const store = this.store();
		if (!store) {
			return;
		}
		try {
			await store.delete(entry.id);
		} catch {
			alert("Failed to delete MCP server");
			return;
		}
		this.statuses.delete(entry.id);
		await this.loadServers();
	}

	private renderServer(entry: McpServerEntry): TemplateResult {
		return html`
			<mcp-server-card
				.entry=${entry}
				.status=${this.statuses.get(entry.id)}
				.onTest=${(target: McpServerEntry) => this.testServer(target)}
				.onEdit=${(target: McpServerEntry) => this.editServer(target)}
				.onDelete=${(target: McpServerEntry) => this.deleteServer(target)}
				.onToggle=${(target: McpServerEntry) => this.toggleServer(target)}
			></mcp-server-card>
		`;
	}

	render(): TemplateResult {
		if (!this.store()) {
			return html`
				<p class="text-sm text-muted-foreground">This application has not configured MCP server storage.</p>
			`;
		}

		return html`
			<div class="flex flex-col gap-6">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-sm font-semibold text-foreground mb-2">MCP Servers</h3>
						<p class="text-sm text-muted-foreground">
							Streamable HTTP MCP servers whose tools the application can load. Credentials stay in this
							browser and are only ever sent to the server they belong to.
						</p>
					</div>
					${Button({
						onClick: () => void this.addServer(),
						variant: "outline",
						size: "sm",
						children: "Add Server",
					})}
				</div>

				${
					this.servers.length === 0
						? html`
							<div class="text-sm text-muted-foreground text-center py-8">
								No MCP servers configured. Click "Add Server" to get started.
							</div>
						`
						: html`<div class="flex flex-col gap-4">${this.servers.map((entry) => this.renderServer(entry))}</div>`
				}
			</div>
		`;
	}
}
