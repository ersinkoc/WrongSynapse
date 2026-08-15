/**
 * MCP server bootstrap: stdio (default) and optional SSE transports.
 *
 * The SSE transport is provided for environments that cannot speak stdio
 * (e.g. remote agents). It is intentionally minimal: one SSE stream per
 * session on GET /sse, JSON-RPC messages via POST /messages?sessionId=...
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { registerTools, type ToolContext } from './tools/index.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';

export const SERVER_NAME = 'wrongsynapse';
export const SERVER_VERSION = '0.1.0';

/** Build an MCP server with every WrongSynapse tool registered. */
export function createSynapseServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, ctx, TOOL_DEFINITIONS);
  return server;
}

/** Run the MCP server over stdio (blocks until the client disconnects). */
export async function runStdio(ctx: ToolContext): Promise<void> {
  const server = createSynapseServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface SseServerHandle {
  server: HttpServer;
  close(): Promise<void>;
}

/** Run the MCP server over SSE on the given port; returns once listening. */
export async function runSse(ctx: ToolContext, port: number): Promise<SseServerHandle> {
  const mcpServer = createSynapseServer(ctx);
  const httpServer = createServer();
  const transports = new Map<string, SSEServerTransport>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/sse') {
        const sessionId = url.searchParams.get('sessionId') ?? randomUUID();
        const transport = new SSEServerTransport('/messages', res);
        transports.set(sessionId, transport);
        res.on('close', () => {
          transports.delete(sessionId);
        });
        await mcpServer.connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId !== null ? transports.get(sessionId) : undefined;
        if (transport === undefined) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Unknown session');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  };

  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolvePromise) => httpServer.listen(port, resolvePromise));

  const close = async (): Promise<void> => {
    try {
      await mcpServer.close();
    } catch {
      // server may already be closed
    }
    await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
  };
  return { server: httpServer, close };
}
