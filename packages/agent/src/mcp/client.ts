/**
 * Browser-safe MCP client for the Streamable HTTP transport.
 *
 * Speaks the JSON-RPC 2.0 subset of the Model Context Protocol
 * (2025-06-18, Streamable HTTP transport) that an agent loop needs:
 * `initialize`, `tools/list` and `tools/call`. Requests are plain `POST`s to the
 * configured url, and responses are read as either `application/json` or
 * `text/event-stream`. Only `fetch`, `Headers`, `Response` and `AbortSignal` are
 * used, so this bundles into a browser extension without an SDK dependency.
 *
 * The caller supplies the url and headers; nothing is stored or read back here.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

/** Target MCP server. `headers` are spread onto every request (e.g. `Authorization`). */
export interface McpServerConfig {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

/** A tool as advertised by `tools/list`. */
export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Content block returned by `tools/call`. Unhandled types pass through untouched. */
export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: string; [key: string]: unknown };

/** Result payload of `tools/call`. */
export interface McpToolCallResult {
	content: McpContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

export interface McpHttpClientOptions {
	/** Fetch implementation to use. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Protocol version offered to the server. Default: "2025-06-18". */
	protocolVersion?: string;
	/** Client identity sent in the `initialize` params. */
	clientInfo?: { name: string; version: string };
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_CLIENT_INFO = { name: "pi-agent-core", version: "0.0.0" };

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: Record<string, unknown>;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Servers may echo request ids as numbers or strings, so compare loosely. */
function isResponseFor(message: Record<string, unknown>, id: number): boolean {
	const value = message.id;
	if (typeof value === "number") {
		return value === id;
	}
	return typeof value === "string" && value === String(id);
}

function toToolDefinition(entry: Record<string, unknown>): McpToolDefinition {
	const definition: McpToolDefinition = { name: entry.name as string };
	if (typeof entry.description === "string") {
		definition.description = entry.description;
	}
	if (isRecord(entry.inputSchema)) {
		definition.inputSchema = entry.inputSchema;
	}
	return definition;
}

export class McpHttpClient {
	readonly config: McpServerConfig;

	private readonly fetchImpl: typeof fetch;
	private readonly protocolVersion: string;
	private readonly clientInfo: { name: string; version: string };
	private nextRequestId = 1;
	private sessionId?: string;
	private negotiatedProtocolVersion?: string;
	private initialized = false;
	private initialization?: Promise<void>;

	constructor(config: McpServerConfig, options?: McpHttpClientOptions) {
		this.config = config;
		// Wrapped instead of assigned so the global fetch is never called detached from globalThis.
		this.fetchImpl = options?.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.protocolVersion = options?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
		this.clientInfo = options?.clientInfo ?? DEFAULT_CLIENT_INFO;
	}

	/**
	 * Send `initialize` followed by the `notifications/initialized` notification.
	 * A second call is a no-op, and concurrent calls share one handshake.
	 */
	async initialize(signal?: AbortSignal): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (!this.initialization) {
			this.initialization = this.runInitialize(signal);
		}
		await this.initialization;
	}

	/** All tools the server advertises, following `nextCursor` across pages. */
	async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
		await this.initialize(signal);
		const tools: McpToolDefinition[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (;;) {
			const params: Record<string, unknown> = {};
			if (cursor !== undefined) {
				params.cursor = cursor;
			}
			const result = await this.request("tools/list", params, signal);
			if (isRecord(result) && Array.isArray(result.tools)) {
				for (const entry of result.tools) {
					if (isRecord(entry) && typeof entry.name === "string") {
						tools.push(toToolDefinition(entry));
					}
				}
			}
			const next = isRecord(result) && typeof result.nextCursor === "string" ? result.nextCursor : undefined;
			// Stop on a missing cursor, and on a repeated one so a broken server cannot spin us forever.
			if (next === undefined || next === cursor || seenCursors.has(next)) {
				break;
			}
			seenCursors.add(next);
			cursor = next;
		}
		return tools;
	}

	/** Run one tool and return its `tools/call` result. */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.initialize(signal);
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		const content: McpContent[] = [];
		const callResult: McpToolCallResult = { content };
		if (isRecord(result)) {
			if (Array.isArray(result.content)) {
				for (const item of result.content) {
					if (isRecord(item)) {
						content.push(item as McpContent);
					}
				}
			}
			if (typeof result.isError === "boolean") {
				callResult.isError = result.isError;
			}
			if ("structuredContent" in result) {
				callResult.structuredContent = result.structuredContent;
			}
		}
		return callResult;
	}

	/**
	 * Delete the server session, if one was issued. Servers that do not implement
	 * `DELETE` answer 404 or 405; teardown is best effort either way.
	 */
	async close(signal?: AbortSignal): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		const response = await this.fetchImpl(this.config.url, {
			method: "DELETE",
			headers: this.requestHeaders(),
			signal,
		});
		if (response.ok || response.status === 404 || response.status === 405) {
			return;
		}
		throw new Error(`MCP close failed: HTTP ${response.status} ${response.statusText}`);
	}

	private async runInitialize(signal?: AbortSignal): Promise<void> {
		try {
			const result = await this.request(
				"initialize",
				{
					protocolVersion: this.protocolVersion,
					capabilities: {},
					clientInfo: this.clientInfo,
				},
				signal,
			);
			if (isRecord(result) && typeof result.protocolVersion === "string") {
				this.negotiatedProtocolVersion = result.protocolVersion;
			}
			await this.postNotification("notifications/initialized", signal);
			this.initialized = true;
		} catch (error) {
			// Allow a later call to retry the handshake after a failure.
			this.initialization = undefined;
			throw error;
		}
	}

	/** Send one JSON-RPC request and return its `result`, throwing on any error shape. */
	private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextRequestId++;
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const response = await this.fetchImpl(this.config.url, {
			method: "POST",
			headers: this.requestHeaders(),
			body: JSON.stringify(body),
			signal,
		});
		this.captureSessionId(response);
		if (!response.ok) {
			throw new Error(`MCP ${method} failed: HTTP ${response.status} ${response.statusText}`);
		}
		const message = await this.readResponseMessage(id, response);
		if (!message) {
			throw new Error(`MCP ${method}: no response for request ${id}`);
		}
		if (isRecord(message.error)) {
			const code = message.error.code;
			const codeText = typeof code === "number" ? String(code) : String(code ?? "unknown");
			const errorText = typeof message.error.message === "string" ? message.error.message : "unknown error";
			throw new Error(`MCP ${method} error ${codeText}: ${errorText}`);
		}
		return message.result;
	}

	private async postNotification(method: string, signal?: AbortSignal): Promise<void> {
		const body: JsonRpcNotification = { jsonrpc: "2.0", method };
		const response = await this.fetchImpl(this.config.url, {
			method: "POST",
			headers: this.requestHeaders(),
			body: JSON.stringify(body),
			signal,
		});
		this.captureSessionId(response);
		// Any 2xx is accepted, including 202 with an empty body.
		if (!response.ok) {
			throw new Error(`MCP ${method} failed: HTTP ${response.status} ${response.statusText}`);
		}
	}

	/**
	 * Read the message answering `id` from either response shape: an SSE body whose
	 * `data:` lines carry notifications and other messages, or a JSON body holding a
	 * single message or an array of them.
	 */
	private async readResponseMessage(id: number, response: Response): Promise<Record<string, unknown> | undefined> {
		const contentType = response.headers.get("content-type") ?? "";
		const text = await response.text();
		if (contentType.startsWith("text/event-stream")) {
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) {
					continue;
				}
				const message = parseJson(trimmed.slice("data:".length).trim());
				if (isRecord(message) && isResponseFor(message, id)) {
					return message;
				}
			}
			return undefined;
		}
		const parsed = parseJson(text);
		const candidates = Array.isArray(parsed) ? parsed : [parsed];
		for (const candidate of candidates) {
			if (isRecord(candidate) && isResponseFor(candidate, id)) {
				return candidate;
			}
		}
		return undefined;
	}

	private captureSessionId(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) {
			this.sessionId = sessionId;
		}
	}

	private requestHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		if (this.negotiatedProtocolVersion) {
			headers["Mcp-Protocol-Version"] = this.negotiatedProtocolVersion;
		}
		return headers;
	}
}
