import { describe, expect, it } from "vitest";
import { McpHttpClient } from "../../src/mcp/client.js";
import {
	createFakeFetch,
	createTestClient,
	jsonResponse,
	type RecordedRequest,
	type Respond,
	rpcError,
	rpcResult,
	sseResponse,
} from "./fake-fetch.js";

const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } };

/** Answer by JSON-RPC method: initialize succeeds, tools/list returns `tools`. */
function server(options: { tools?: unknown[]; sessionId?: string } = {}): Respond {
	return (request) => respondTo(request, options);
}

function respondTo(request: RecordedRequest, options: { tools?: unknown[]; sessionId?: string }): Response {
	switch (request.body?.method) {
		case "initialize":
			return rpcResult(
				request,
				INIT_RESULT,
				options.sessionId ? { headers: { "Mcp-Session-Id": options.sessionId } } : undefined,
			);
		case "notifications/initialized":
			return new Response(null, { status: 202 });
		case "tools/list":
			return rpcResult(request, { tools: options.tools ?? [] });
		default:
			return rpcResult(request, {});
	}
}

describe("McpHttpClient", () => {
	it("sends initialize then notifications/initialized, and carries session id, protocol version and custom headers", async () => {
		const fake = createFakeFetch(
			server({
				sessionId: "session-1",
				tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
			}),
		);
		const client = createTestClient(fake.fetch);

		await client.initialize();
		await client.initialize(); // no-op the second time
		await client.listTools();

		// initialize, notifications/initialized, then tools/list. The repeated initialize added nothing.
		expect(fake.requests.map((request) => request.body?.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		expect(fake.requests[1].body?.id).toBeUndefined();
		expect(fake.requests[1].body?.method).toBe("notifications/initialized");
		expect(fake.requests[0].body?.params).toMatchObject({
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pi-agent-core", version: "0.0.0" },
		});

		// Every request carries the caller's headers and the JSON/SSE accept pair, and none of them hits a path.
		for (const request of fake.requests) {
			expect(request.url).toBe("http://mcp.test/");
			expect(request.method).toBe("POST");
			expect(request.headers.authorization).toBe("Bearer test-token");
			expect(request.headers["content-type"]).toBe("application/json");
			expect(request.headers.accept).toBe("application/json, text/event-stream");
		}

		// Session id from the initialize response is replayed, and so is the negotiated protocol version.
		expect(fake.requests[0].headers["mcp-session-id"]).toBeUndefined();
		for (const request of fake.requests.slice(1)) {
			expect(request.headers["mcp-session-id"]).toBe("session-1");
			expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
		}

		// Request ids increment per client instance.
		expect(fake.requests[0].body?.id).toBe(1);
		expect(fake.requests[2].body?.id).toBe(2);
	});

	it("parses text/event-stream bodies and returns the message whose id matches", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return sseResponse([
						{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1 } },
						{ jsonrpc: "2.0", id: request.body?.id, result: { tools: [{ name: "search" }] } },
					]);
				default:
					return jsonResponse({});
			}
		});

		const tools = await createTestClient(fake.fetch).listTools();

		expect(tools).toEqual([{ name: "search" }]);
		expect(fake.requests[2].headers["content-type"]).toBe("application/json");
	});

	it("parses application/json bodies, single message or array", async () => {
		const single = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return rpcResult(request, { tools: [{ name: "read_page" }] });
				default:
					return jsonResponse({});
			}
		});
		await expect(createTestClient(single.fetch).listTools()).resolves.toEqual([{ name: "read_page" }]);

		const array = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return jsonResponse([
						{ jsonrpc: "2.0", method: "notifications/message" },
						{ jsonrpc: "2.0", id: request.body?.id, result: { tools: [{ name: "list_dir" }] } },
					]);
				default:
					return jsonResponse({});
			}
		});
		await expect(createTestClient(array.fetch).listTools()).resolves.toEqual([{ name: "list_dir" }]);
	});

	it("follows nextCursor across pages and sends params.cursor", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list": {
					const params = request.body?.params as Record<string, unknown> | undefined;
					if (params?.cursor === "page-2") {
						return rpcResult(request, { tools: [{ name: "second" }] });
					}
					return rpcResult(request, { tools: [{ name: "first" }], nextCursor: "page-2" });
				}
				default:
					return jsonResponse({});
			}
		});

		const tools = await createTestClient(fake.fetch).listTools();

		expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
		const listCalls = fake.requests.filter((request) => request.body?.method === "tools/list");
		expect(listCalls).toHaveLength(2);
		expect(listCalls[0].body?.params).toEqual({});
		expect(listCalls[1].body?.params).toEqual({ cursor: "page-2" });
	});

	it("returns content and isError from a tools/call result", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/call":
					return rpcResult(request, {
						content: [{ type: "text", text: "not found" }],
						isError: true,
						structuredContent: { status: 404 },
					});
				default:
					return jsonResponse({});
			}
		});

		const result = await createTestClient(fake.fetch).callTool("get_page", { slug: "missing" });

		expect(result).toEqual({
			content: [{ type: "text", text: "not found" }],
			isError: true,
			structuredContent: { status: 404 },
		});
		const call = fake.requests.find((request) => request.body?.method === "tools/call");
		expect(call?.body?.params).toEqual({ name: "get_page", arguments: { slug: "missing" } });
	});

	it("rejects with the HTTP status and never the request headers or body", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				default:
					return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
			}
		});

		const error = await createTestClient(fake.fetch)
			.callTool("get_page", { slug: "a" })
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("401");
		expect(message).toBe("MCP tools/call failed: HTTP 401 Unauthorized");
		expect(message).not.toContain("test-token");
		expect(message).not.toContain("Bearer");
		expect(fake.requests.at(-1)?.body?.method).toBe("tools/call");
	});

	it("does not leak the authorization value into error messages", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				default:
					// A server that echoes the rejected credential back in the error body.
					return new Response("bad Authorization: Bearer test-token", { status: 403, statusText: "Forbidden" });
			}
		});
		const error = await createTestClient(fake.fetch)
			.callTool("get_page", { secret_argument: "argument-value" })
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("403");
		expect(message).not.toContain("test-token");
		expect(message).not.toContain("Authorization");
		expect(message).not.toContain("argument-value");
		expect(message).toBe("MCP tools/call failed: HTTP 403 Forbidden");
	});

	it("throws on a JSON-RPC error object and on a missing response", async () => {
		const rpcErrorServer = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/call":
					return rpcError(request, -32601, "Tool not found: nope");
				default:
					return jsonResponse({});
			}
		});
		await expect(createTestClient(rpcErrorServer.fetch).callTool("nope", {})).rejects.toThrow(
			"MCP tools/call error -32601: Tool not found: nope",
		);

		const silent = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, INIT_RESULT);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/call":
					return sseResponse([{ jsonrpc: "2.0", method: "notifications/progress", params: {} }]);
				default:
					return jsonResponse({});
			}
		});
		const client = createTestClient(silent.fetch);
		await expect(client.callTool("get_page", {})).rejects.toThrow("MCP tools/call: no response for request 2");
	});

	it("deletes the session on close, ignores 404, and is a no-op without a session", async () => {
		const fake = createFakeFetch((request) => {
			if (request.method === "DELETE") {
				return new Response(null, { status: 404 });
			}
			return respondTo(request, { sessionId: "session-9" });
		});
		const client = createTestClient(fake.fetch);
		await client.listTools();
		await client.close();

		const deleteCall = fake.requests.at(-1);
		expect(deleteCall?.method).toBe("DELETE");
		expect(deleteCall?.url).toBe("http://mcp.test/");
		expect(deleteCall?.headers["mcp-session-id"]).toBe("session-9");
		expect(deleteCall?.headers.authorization).toBe("Bearer test-token");
		expect(deleteCall?.body).toBeUndefined();

		const noSession = createFakeFetch(server());
		await createTestClient(noSession.fetch).close();
		expect(noSession.requests).toHaveLength(0);
	});

	it("accepts a caller-supplied fetch and defaults to SSE-friendly requests at the exact url", async () => {
		const fake = createFakeFetch((request) => {
			switch (request.body?.method) {
				case "initialize":
					return rpcResult(request, { protocolVersion: "2024-11-05" });
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				default:
					return rpcResult(request, { tools: [] });
			}
		});
		const client = new McpHttpClient({ name: "root-path", url: "http://mcp.test" }, { fetch: fake.fetch });

		await expect(client.listTools()).resolves.toEqual([]);

		// No session id was issued, so none is sent. The negotiated version still is.
		for (const request of fake.requests.slice(1)) {
			expect(request.headers["mcp-session-id"]).toBeUndefined();
			expect(request.headers["mcp-protocol-version"]).toBe("2024-11-05");
		}
		expect(fake.requests[0].url).toBe("http://mcp.test");
	});
});
