import { Store } from "../store.ts";
import type { StoreConfig } from "../types.ts";

/**
 * One configured Model Context Protocol server on the Streamable HTTP transport.
 *
 * `headers` carries credentials (e.g. `Authorization`). Its values are secrets:
 * they are only ever sent to `url`, and nothing in this package renders one —
 * `describeMcpServer` reports a count, `redactMcpServer` masks the values, and
 * `McpServerCard` never reads the map.
 */
export interface McpServerEntry {
	/** Stable id (`crypto.randomUUID()`), the key of the object store. */
	id: string;
	/** Display name. */
	name: string;
	/** Streamable HTTP endpoint of the server. */
	url: string;
	/** Extra headers sent to `url`, e.g. an `Authorization` value. */
	headers?: Record<string, string>;
	/** Whether the host app should load tools from this server. */
	enabled: boolean;
	/** Optional prefix applied to tool names taken from this server. */
	namePrefix?: string;
}

const STORE_NAME = "mcp-servers";

/** Fixed mask for redacted header values. Never derived from the value it replaces. */
const HEADER_MASK = "••••••••";

/**
 * Store for MCP server settings, keyed by `McpServerEntry.id`.
 */
export class McpServersStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: STORE_NAME,
		};
	}

	async get(id: string): Promise<McpServerEntry | null> {
		return this.getBackend().get<McpServerEntry>(STORE_NAME, id);
	}

	async set(entry: McpServerEntry): Promise<void> {
		await this.getBackend().set(STORE_NAME, entry.id, entry);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete(STORE_NAME, id);
	}

	/** All entries, ordered by display name, case-insensitively. */
	async getAll(): Promise<McpServerEntry[]> {
		const keys = await this.getBackend().keys(STORE_NAME);
		const entries: McpServerEntry[] = [];
		for (const key of keys) {
			const entry = await this.get(key);
			if (entry) {
				entries.push(entry);
			}
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	}

	async has(id: string): Promise<boolean> {
		return this.getBackend().has(STORE_NAME, id);
	}
}

/**
 * One line naming the server, its url, and how many headers it carries.
 * Safe for lists and logs: a header value never appears, only their count.
 */
export function describeMcpServer(entry: McpServerEntry): string {
	const count = entry.headers ? Object.keys(entry.headers).length : 0;
	if (count === 0) {
		return `${entry.name} · ${entry.url} · no headers`;
	}
	return `${entry.name} · ${entry.url} · ${count} ${count === 1 ? "header" : "headers"}`;
}

/**
 * A copy of `entry` whose header values are all replaced by a fixed mask.
 * The input is never mutated, so a redacted copy can be handed to UI code that
 * must not see credentials.
 */
export function redactMcpServer(entry: McpServerEntry): McpServerEntry {
	const redacted: McpServerEntry = { ...entry };
	if (entry.headers) {
		const headers: Record<string, string> = {};
		for (const name of Object.keys(entry.headers)) {
			headers[name] = HEADER_MASK;
		}
		redacted.headers = headers;
	}
	return redacted;
}
