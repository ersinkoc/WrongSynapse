/**
 * Regression tests for the real MCP server boot path.
 *
 * These cover two bugs that unit tests (which call tool handlers directly)
 * cannot see, and that were caught only by end-to-end smoke tests:
 *
 * 1. `registerTools` must pass Zod schemas to the SDK — plain JSON-Schema
 *    objects made `createSynapseServer` throw
 *    ("inputSchema must be a Zod schema or raw shape").
 * 2. `runSse` must key its transport map on the SDK transport's own
 *    sessionId (advertised in the SSE `endpoint` event), not a
 *    server-generated id — otherwise every POST returns 400 "Unknown session".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { createSynapseServer, runSse, SERVER_NAME, SERVER_VERSION } from './server.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import type { ToolContext } from './tools/index.js';

let db: SynapseDatabase;
let ctx: ToolContext;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  const embedder = new FakeEmbedder();
  await embedder.init();
  ctx = { db, embedder };
});

afterAll(() => {
  db.close();
});

describe('createSynapseServer', () => {
  it('registers every tool without throwing (Zod input schemas)', () => {
    expect(() => createSynapseServer(ctx)).not.toThrow();
  });
});

describe('runSse (end-to-end over HTTP)', () => {
  it('serves initialize + notifications/initialized + tools/list', async () => {
    const handle = await runSse(ctx, 0);
    const port = (handle.server.address() as AddressInfo).port;
    try {
      const pending = new Map<number, (msg: Record<string, unknown>) => void>();

      const endpointPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no endpoint event within 10s')), 10_000);
        let buf = '';
        const req = http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
          if (res.statusCode !== 200) {
            clearTimeout(timer);
            reject(new Error('GET /sse returned ' + res.statusCode));
            return;
          }
          res.on('data', (chunk) => {
            buf += chunk.toString();
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let event = 'message';
              const dataLines: string[] = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
              }
              if (dataLines.length === 0) continue;
              if (event === 'endpoint') {
                clearTimeout(timer);
                resolve(dataLines.join('\n'));
                return;
              }
              if (event === 'message') {
                const msg = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
                const id = msg['id'];
                if (typeof id === 'number') {
                  const cb = pending.get(id);
                  if (cb !== undefined) {
                    pending.delete(id);
                    cb(msg);
                  }
                }
              }
            }
          });
        });
        req.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      const waitFor = (id: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no SSE response for id=${id} within 10s`)), 10_000);
          pending.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        });

      const post = (path: string, body: unknown): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path,
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            },
          );
          req.on('error', reject);
          req.write(JSON.stringify(body));
          req.end();
        });

      // 1. endpoint event
      const endpoint = await endpointPromise;
      expect(endpoint.startsWith('/messages?sessionId=')).toBe(true);

      // 2. initialize
      const initWait = waitFor(1);
      const initStatus = await post(endpoint, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'regression-test', version: '0.0.1' },
        },
      });
      expect(initStatus).toBe(202);
      const initResp = await initWait;
      const serverInfo = (initResp['result'] as { serverInfo?: { name?: string; version?: string } }).serverInfo;
      expect(serverInfo?.name).toBe(SERVER_NAME);
      expect(serverInfo?.version).toBe(SERVER_VERSION);

      // 3. notifications/initialized (no response expected)
      const notifStatus = await post(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(notifStatus).toBe(202);

      // 4. tools/list
      const toolsWait = waitFor(2);
      const toolsStatus = await post(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(toolsStatus).toBe(202);
      const toolsResp = await toolsWait;
      const tools = ((toolsResp['result'] as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
      expect(tools).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
      expect(tools).toHaveLength(6);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
