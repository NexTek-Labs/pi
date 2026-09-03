/**
 * Adapt MCP tools to the agent loop's `AgentTool` shape.
 *
 * `createMcpTools()` lists a server's tools once and wraps each one so the loop
 * can run it unchanged. Input schemas are handed over as plain JSON Schema
 * objects: `validateToolArguments` in @earendil-works/pi-ai validates those
 * directly, so no TypeBox conversion is needed.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentTool } from "../types.ts";
import type { McpContent, McpHttpClient, McpToolDefinition } from "./client.ts";

/** Options for `createMcpTools`. */
export interface CreateMcpToolsOptions {
	/** Prefix for tool names only, e.g. "gbrain_" turns `get_page` into `gbrain_get_page`. */
	namePrefix?: string;
}

/** `details` returned by every MCP tool execution, for logs and UI rendering. */
export interface McpToolDetails {
	server: string;
	tool: string;
	isError: boolean;
	structuredContent?: unknown;
}

const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

function isTextContent(content: TextContent | ImageContent): content is TextContent {
	return content.type === "text";
}

/** Map one MCP content block onto the content types the agent loop accepts. */
function toAgentContent(item: McpContent): TextContent | ImageContent {
	if (item.type === "image") {
		const data = (item as { data?: unknown }).data;
		const mimeType = (item as { mimeType?: unknown }).mimeType;
		if (typeof data === "string" && typeof mimeType === "string") {
			return { type: "image", data, mimeType };
		}
	}
	if (item.type === "text") {
		const text = (item as { text?: unknown }).text;
		if (typeof text === "string") {
			return { type: "text", text };
		}
	}
	// resource, resource_link, audio and anything unknown reach the model as JSON text.
	return { type: "text", text: JSON.stringify(item) };
}

function toAgentTool(client: McpHttpClient, definition: McpToolDefinition, namePrefix: string): AgentTool {
	const parameters = (definition.inputSchema ?? EMPTY_INPUT_SCHEMA) as TSchema;
	return {
		name: `${namePrefix}${definition.name}`,
		label: definition.name,
		description: definition.description ?? "",
		parameters,
		execute: async (_toolCallId, params, signal) => {
			const result = await client.callTool(definition.name, (params ?? {}) as Record<string, unknown>, signal);
			const content = result.content.map(toAgentContent);
			const details: McpToolDetails = {
				server: client.config.name,
				tool: definition.name,
				isError: !!result.isError,
				structuredContent: result.structuredContent,
			};
			if (result.isError) {
				// The loop turns a throw into an error tool result; do not return one as a success.
				const text = content
					.filter(isTextContent)
					.map((entry) => entry.text)
					.join("\n");
				throw new Error(text || `MCP tool "${definition.name}" failed`);
			}
			return { content, details };
		},
	};
}

/**
 * List the client's tools and wrap them as `AgentTool`s.
 * The listing happens once; call again after the server's tool set changes.
 */
export async function createMcpTools(client: McpHttpClient, options?: CreateMcpToolsOptions): Promise<AgentTool[]> {
	const definitions = await client.listTools();
	const namePrefix = options?.namePrefix ?? "";
	return definitions.map((definition) => toAgentTool(client, definition, namePrefix));
}
