/**
 * MCP tool layer: shared context, tool definition contract, registration.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { SynapseDatabase } from '../../db/connection.js';
import type { Embedder } from '../../engine/embedding.js';

export interface ToolContext {
  db: SynapseDatabase;
  embedder: Embedder;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler(ctx: ToolContext, args: ToolArgs): Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function jsonResult(value: unknown, isError = false): ToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function errorText(error: unknown): string {
  return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
}

/** Local pragmatic shape for `registerTool` (Zod input schema, untyped args). */
type RegisterToolLike = (
  name: string,
  config: { title?: string; description?: string; inputSchema?: z.ZodTypeAny },
  cb: (args: unknown) => Promise<ToolResult>,
) => void;

/** Register every tool definition on an MCP server, wrapping handlers with error handling. */
export function registerTools(server: McpServer, ctx: ToolContext, definitions: readonly ToolDefinition[]): void {
  const register = server.registerTool.bind(server) as unknown as RegisterToolLike;
  for (const tool of definitions) {
    register(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        try {
          return await tool.handler(ctx, (args ?? {}) as ToolArgs);
        } catch (error) {
          return textResult(errorText(error), true);
        }
      },
    );
  }
}
