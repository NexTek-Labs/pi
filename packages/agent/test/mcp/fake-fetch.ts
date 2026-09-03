import type { McpServerConfig } from "../../src/mcp/client.js";
import { McpHttpClient } from "../../src/mcp/client.js";

/** A request as observed by `createFakeFetch`. Header names are lower-cased. */
export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: Record<string, unknown>;
}

export type Respond = (request: RecordedRequest, index: number) => Response;

export interface FakeFetch {
	readonly requests: RecordedRequest[];
	fetch: typeof globalThis.fetch;
}

/** Fetch replacement that records every request and answers from `respond`. No network. */
export function createFakeFetch(respond: Respond): FakeFetch {
	const requests: RecordedRequest[] = [];
	const fetchImpl: typeof fetch = (input, init) => {
		const headers = new Headers(init?.headers ?? {});
		const record: RecordedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(headers.entries()),
		};
		if (typeof init?.body === "string") {
			record.body = JSON.parse(init.body) as Record<string, unknown>;
		}
		requests.push(record);
		return Promise.resolve(respond(record, requests.length - 1));
	};
	return { requests, fetch: fetchImpl };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
}

/** SSE body: one `event: message` block per message, as real Streamable HTTP servers send. */
export function sseResponse(messages: unknown[], init?: ResponseInit): Response {
	const body = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		...init,
		headers: { "content-type": "text/event-stream", ...(init?.headers ?? {}) },
	});
}

/** Successful JSON-RPC result for whatever id the request carried. */
export function rpcResult(request: RecordedRequest, result: unknown, init?: ResponseInit): Response {
	return jsonResponse({ jsonrpc: "2.0", id: request.body?.id, result }, init);
}

/** Failed JSON-RPC response for whatever id the request carried. */
export function rpcError(request: RecordedRequest, code: number, message: string): Response {
	return jsonResponse({ jsonrpc: "2.0", id: request.body?.id, error: { code, message } });
}

/** A client pointed at the root path of a server, with a caller-supplied auth header. */
export function createTestClient(fetchImpl: typeof globalThis.fetch, headers?: Record<string, string>): McpHttpClient {
	const config: McpServerConfig = {
		name: "test-server",
		url: "http://mcp.test/",
		headers: { Authorization: "Bearer test-token", ...headers },
	};
	return new McpHttpClient(config, { fetch: fetchImpl });
}
