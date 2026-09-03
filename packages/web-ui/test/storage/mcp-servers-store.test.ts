/**
 * Contract tests for McpServersStore, written BEFORE the implementation
 * (test-first for the credentials/egress risk zone, sitegeist-nex docs/WORKFLOW.md).
 *
 * They define what `src/storage/stores/mcp-servers-store.ts` must provide:
 *   - McpServerEntry: { id, name, url, headers?, enabled, namePrefix? }
 *   - McpServersStore extends Store: get / set / delete / getAll (sorted by name) / has
 *   - describeMcpServer(entry): one line for lists and logs that never contains a header value
 *   - redactMcpServer(entry): a copy whose header values are masked, input left untouched
 * and that AppStorage exposes the store as `mcpServers`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AppStorage } from "../../src/storage/app-storage.ts";
import { CustomProvidersStore } from "../../src/storage/stores/custom-providers-store.ts";
import {
	describeMcpServer,
	type McpServerEntry,
	McpServersStore,
	redactMcpServer,
} from "../../src/storage/stores/mcp-servers-store.ts";
import { ProviderKeysStore } from "../../src/storage/stores/provider-keys-store.ts";
import { SessionsStore } from "../../src/storage/stores/sessions-store.ts";
import { SettingsStore } from "../../src/storage/stores/settings-store.ts";
import { MemoryStorageBackend } from "./memory-backend.ts";

const SECRET = "Bearer sk-live-THIS-MUST-NEVER-BE-SHOWN";

function entry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "gbrain",
		url: "http://127.0.0.1:8795/mcp",
		headers: { Authorization: SECRET },
		enabled: true,
		namePrefix: "gbrain_",
		...overrides,
	};
}

describe("McpServersStore", () => {
	let store: McpServersStore;

	beforeEach(() => {
		store = new McpServersStore();
		store.setBackend(new MemoryStorageBackend());
	});

	it("uses the object store name mcp-servers", () => {
		expect(store.getConfig().name).toBe("mcp-servers");
	});

	it("round-trips an entry including its headers", async () => {
		const server = entry();
		await store.set(server);
		expect(await store.get(server.id)).toEqual(server);
		expect(await store.has(server.id)).toBe(true);
	});

	it("returns null and false for an unknown id", async () => {
		expect(await store.get("missing")).toBeNull();
		expect(await store.has("missing")).toBe(false);
	});

	it("overwrites on set with the same id instead of duplicating", async () => {
		await store.set(entry());
		await store.set(entry({ url: "http://127.0.0.1:9999/mcp" }));
		const all = await store.getAll();
		expect(all).toHaveLength(1);
		expect(all[0].url).toBe("http://127.0.0.1:9999/mcp");
	});

	it("getAll returns entries sorted by name, case-insensitively", async () => {
		await store.set(entry({ id: "a", name: "honcho" }));
		await store.set(entry({ id: "b", name: "Gbrain" }));
		await store.set(entry({ id: "c", name: "alpha" }));
		expect((await store.getAll()).map((e) => e.name)).toEqual(["alpha", "Gbrain", "honcho"]);
	});

	it("delete removes the entry", async () => {
		const server = entry();
		await store.set(server);
		await store.delete(server.id);
		expect(await store.get(server.id)).toBeNull();
		expect(await store.getAll()).toEqual([]);
	});

	it("stores entries without headers and without a prefix", async () => {
		const server = entry({ headers: undefined, namePrefix: undefined, enabled: false });
		await store.set(server);
		const loaded = await store.get(server.id);
		expect(loaded?.headers).toBeUndefined();
		expect(loaded?.namePrefix).toBeUndefined();
		expect(loaded?.enabled).toBe(false);
	});
});

describe("describeMcpServer", () => {
	it("names the server, its url and how many headers it has, never a header value", () => {
		const text = describeMcpServer(entry({ headers: { Authorization: SECRET, "X-Honcho-User-Name": "Gin" } }));
		expect(text).toContain("gbrain");
		expect(text).toContain("http://127.0.0.1:8795/mcp");
		expect(text).toContain("2");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("sk-live");
		expect(text).not.toContain("Gin");
	});

	it("says there are no headers when there are none", () => {
		const text = describeMcpServer(entry({ headers: undefined }));
		expect(text).toContain("gbrain");
		expect(text).not.toContain("undefined");
	});
});

describe("redactMcpServer", () => {
	it("keeps header names, masks every value, and does not mutate the input", () => {
		const server = entry({ headers: { Authorization: SECRET, "X-Honcho-User-Name": "Gin" } });
		const redacted = redactMcpServer(server);
		expect(Object.keys(redacted.headers ?? {})).toEqual(["Authorization", "X-Honcho-User-Name"]);
		for (const value of Object.values(redacted.headers ?? {})) {
			expect(value).not.toContain(SECRET);
			expect(value).not.toBe("Gin");
			expect(value.length).toBeGreaterThan(0);
		}
		expect(JSON.stringify(redacted)).not.toContain("sk-live");
		expect(server.headers?.Authorization).toBe(SECRET);
		expect(redacted).not.toBe(server);
	});

	it("leaves an entry without headers unchanged in shape", () => {
		const server = entry({ headers: undefined });
		expect(redactMcpServer(server)).toEqual(server);
	});
});

describe("AppStorage", () => {
	it("exposes the store as mcpServers when one is passed", () => {
		const backend = new MemoryStorageBackend();
		const mcpServers = new McpServersStore();
		mcpServers.setBackend(backend);
		const storage = new AppStorage(
			new SettingsStore(),
			new ProviderKeysStore(),
			new SessionsStore(),
			new CustomProvidersStore(),
			backend,
			mcpServers,
		);
		expect(storage.mcpServers).toBe(mcpServers);
	});
});
