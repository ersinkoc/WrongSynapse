/**
 * MCP server bootstrap: stdio (default) and optional SSE transports.
 *
 * The SSE transport is provided for environments that cannot speak stdio
 * (e.g. remote agents). It is intentionally minimal: one SSE stream per
 * session on GET /sse, JSON-RPC messages via POST /messages?sessionId=...
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { registerTools, type ToolContext } from './tools/index.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';

// Single source of truth for the version: package.json. Deriving
// SERVER_VERSION via createRequire means `wrongsynapse --version` and the
// MCP handshake can never drift from the published package version again
// (they drifted in 0.1.0–0.1.2: the literal said 0.1.0 after the bump).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { version: PACKAGE_VERSION } = require(join(packageDir, 'package.json')) as { version: string };

export const SERVER_NAME = 'wrongsynapse';
export const SERVER_VERSION = PACKAGE_VERSION;

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

/** Run the MCP server over SSE; returns once listening.
 *
 *  `host` defaults to loopback: the SSE surface exposes every MCP tool —
 *  including `synapse_index_workspace`, which reads local files — with no
 *  authentication, so binding 0.0.0.0 must stay an explicit operator choice
 *  (`--sse-host`). */
export async function runSse(ctx: ToolContext, port: number, host = '127.0.0.1'): Promise<SseServerHandle> {
  const httpServer = createServer();
  // One McpServer per SSE session: the SDK's Protocol accepts a single
  // transport per server instance, so sharing one server across connections
  // made every client after the first fail with "Already connected" (500).
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Node always populates req.url for parsed requests; the fallback guards
      // only against non-standard embedding hosts. Parsing INSIDE the try so a
      // malformed request line surfaces as HTTP 500, not an unhandled throw.
      /* v8 ignore next */
      const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/sse') {
        const server = createSynapseServer(ctx);
        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, { transport, server });
        res.on('close', () => {
          sessions.delete(transport.sessionId);
        });
        await server.connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const session = sessionId !== null ? sessions.get(sessionId) : undefined;
        if (session === undefined) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Unknown session');
          return;
        }
        await session.transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (error) {
      // Defensive: the SDK transports report protocol errors in-band, and
      // Node's HTTP parser rejects malformed request lines before this
      // handler runs. But SSEServerTransport.handlePostMessage can THROW
      // after already writing a response (e.g. "SSE connection not
      // established": writeHead(500).end() then throw) — calling writeHead
      // again would raise ERR_HTTP_HEADERS_SENT and crash the request, so
      // destroy the socket instead. Not reachable through the SDK's normal
      // error paths; annotated per the codebase's defensive-arm convention.
      /* v8 ignore start */
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : String(error));
      }
      /* v8 ignore stop */
    }
  };

  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  // A listen failure (port in use, EACCES, bad host) must reject the boot
  // promise so main()'s catch can fail loudly — without this listener the
  // 'error' event would surface as an uncaught exception from the event loop.
  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.on('error', (error: Error) => rejectPromise(error));
    httpServer.listen(port, host, () => resolvePromise());
  });

  const close = async (): Promise<void> => {
    // Close every live session's server (ends its SSE response, which fires
    // the 'close' cleanup above), then the HTTP listener.
    for (const { server } of sessions.values()) {
      try {
        await server.close();
      } catch {
        // server may already be closed
      }
    }
    await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
  };
  return { server: httpServer, close };
}
