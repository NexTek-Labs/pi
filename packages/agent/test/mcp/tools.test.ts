import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMcpTools } from "../../src/mcp/tools.js";
import { createFakeFetch, createTestClient, jsonResponse, type Respond, rpcResult } from "./fake-fetch.js";

const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } };

const SEARCH_SCHEMA = {
	type: "object",
	properties: { query: { type: "string" }, limit: { type: "integer" } },
	required: ["query"],
};

const TOOL_DEFINITIONS = [
	{ name: "search", description: "Search pages", inputSchema: SEARCH_SCHEMA },
	{ name: "get_page" },
];

/** Handshake, then answer tools/list with `TOOL_DEFINITIONS` and tools/call with `callResult`. */
function mcpServer(callResult: unknown): Respond {
	return (request) => {
		switch (request.body?.method) {
			case "initialize":
				return rpcResult(request, INIT_RESULT);
			case "notifications/initialized":
				return new Response(null, { status: 202 });
			case "tools/list":
				return rpcResult(request, { tools: TOOL_DEFINITIONS });
			case "tools/call":
				return rpcResult(request, callResult);
			default:
				return jsonResponse({});
		}
	};
}

describe("createMcpTools", () => {
	it("prefixes names and passes the server inputSchema through unchanged", async () => {
		const client = createTestClient(createFakeFetch(mcpServer({ content: [] })).fetch);

		const tools = await createMcpTools(client, { namePrefix: "gbrain_" });

		expect(tools.map((tool) => tool.name)).toEqual(["gbrain_search", "gbrain_get_page"]);
		expect(tools.map((tool) => tool.label)).toEqual(["search", "get_page"]);
		expect(tools[0].description).toBe("Search pages");
		expect(tools[1].description).toBe("");

		// The plain JSON Schema from the server is used as-is: same content, no TypeBox metadata.
		expect(tools[0].parameters).toEqual(SEARCH_SCHEMA);
		expect(Object.getOwnPropertySymbols(tools[0].parameters)).toEqual([]);
		expect(tools[1].parameters).toEqual({ type: "object", properties: {} });
	});

	it("validates arguments against the server schema", async () => {
		const client = createTestClient(createFakeFetch(mcpServer({ content: [] })).fetch);
		const [search] = await createMcpTools(client, { namePrefix: "gbrain_" });

		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "gbrain_search",
			arguments: { query: "mcp client", limit: 5 },
		};
		expect(validateToolArguments(search, toolCall)).toEqual({ query: "mcp client", limit: 5 });

		const missingRequired = { ...toolCall, arguments: { limit: 5 } };
		expect(() => validateToolArguments(search, missingRequired)).toThrow(/query/);
	});

	it("maps text and image content onto the agent tool result", async () => {
		const resource = { type: "resource", resource: { uri: "wiki/x", text: "body" } };
		const client = createTestClient(
			createFakeFetch(
				mcpServer({
					content: [
						{ type: "text", text: "found 1 page" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						resource,
					],
					structuredContent: { slug: "x" },
				}),
			).fetch,
		);
		const [search] = await createMcpTools(client, { namePrefix: "gbrain_" });

		const result = await search.execute("call-1", { query: "mcp client" });

		expect(result.content).toEqual([
			{ type: "text", text: "found 1 page" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: JSON.stringify(resource) },
		]);
		expect(result.details).toEqual({
			server: "test-server",
			tool: "search",
			isError: false,
			structuredContent: { slug: "x" },
		});
	});

	it("rejects with the joined text content when the tool call reports an error", async () => {
		const client = createTestClient(
			createFakeFetch(
				mcpServer({
					content: [
						{ type: "text", text: "no such page" },
						{ type: "text", text: "try search first" },
					],
					isError: true,
				}),
			).fetch,
		);
		const [search] = await createMcpTools(client, { namePrefix: "gbrain_" });

		await expect(search.execute("call-2", { query: "missing" })).rejects.toThrow("no such page\ntry search first");
	});
});
