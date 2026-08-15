/**
 * CLI entry-point tests. main() is exported and takes argv, so the help,
 * version, index, SSE, and stdio branches can be exercised without spawning
 * a process. Heavy dependencies are mocked.
 */

import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from './mcp/tools/index.js';

const mocks = vi.hoisted(() => {
  const runStdio = vi.fn(async (_ctx: ToolContext) => {});
  const runSse = vi.fn(async (_ctx: ToolContext, _port: number) => ({
    // main() awaits a 'close' event on the handle's server; emit it on the
    // next tick so the CLI branch returns instead of hanging the test.
    server: { on: (event: string, cb: () => void) => void (event === 'close' && setTimeout(cb, 0)), close: () => {} },
    close: async () => {},
  }));
  const openDatabase = vi.fn(async () => ({
    backend: 'better-sqlite3',
    path: ':memory:',
    exec: vi.fn(),
    prepare: vi.fn(),
    transaction: <T>(fn: () => T): T => fn(),
    close: vi.fn(),
  }));
  const migrate = vi.fn();
  const assertFts5 = vi.fn();
  const dbStats = vi.fn(() => ({ entities: 1, relations: 0, vectors: 0, candidates: 0, ftsRows: 1 }));
  const getSharedEmbedder = vi.fn(() => ({
    modelId: 'test',
    dimension: 16,
    isReady: () => true,
    init: async () => {},
    embed: async () => new Float32Array(16),
    embedBatch: async () => [new Float32Array(16)],
  }));
  const indexWorkspace = vi.fn(async () => ({
    projectName: 'demo',
    projectScope: 'proj:demo',
    entitiesCreated: 3,
    entitiesUpdated: 0,
    entitiesDeleted: 0,
    filesScanned: 2,
    filesParsed: 1,
    filesFailed: 0,
    symbolsIndexed: 1,
    relationsIndexed: 1,
    commitsIndexed: 0,
    embeddingsStored: 1,
    warnings: [],
  }));
  return { runStdio, runSse, openDatabase, migrate, assertFts5, dbStats, getSharedEmbedder, indexWorkspace };
});

vi.mock('./db/connection.js', () => ({ openDatabase: mocks.openDatabase }));
vi.mock('./db/schema.js', () => ({ migrate: mocks.migrate, assertFts5: mocks.assertFts5 }));
vi.mock('./db/queries.js', () => ({ dbStats: mocks.dbStats }));
vi.mock('./engine/embedding.js', () => ({ getSharedEmbedder: mocks.getSharedEmbedder }));
vi.mock('./engine/parser.js', () => ({ indexWorkspace: mocks.indexWorkspace }));
vi.mock('./mcp/server.js', () => ({ runStdio: mocks.runStdio, runSse: mocks.runSse, SERVER_NAME: 'wrongsynapse', SERVER_VERSION: '0.1.0' }));

import { main, isMainEntryPoint } from './index.js';

describe('isMainEntryPoint', () => {
  it('matches identical real paths', () => {
    expect(isMainEntryPoint(import.meta.url, fileURLToPath(import.meta.url), undefined)).toBe(true);
  });

  it('matches case-insensitively on win32, sensitively elsewhere', () => {
    const real = fileURLToPath(import.meta.url);
    // win32: realpath resolves case-insensitively, so lower-casing both sides matches
    expect(isMainEntryPoint(import.meta.url, real.toLowerCase(), undefined, 'win32')).toBe(true);
    // posix: exact realpath match required; an unresolvable suffix path -> false
    expect(isMainEntryPoint(import.meta.url, real, undefined, 'linux')).toBe(true);
    expect(isMainEntryPoint(import.meta.url, `${real}.nope`, undefined, 'linux')).toBe(false);
  });

  it('returns false for a different argv1', () => {
    expect(isMainEntryPoint('file:///a/index.ts', '/b/main.js', undefined)).toBe(false);
  });

  it('returns false when argv1 is undefined and metaMain is unset', () => {
    expect(isMainEntryPoint('file:///a/index.ts', undefined, undefined)).toBe(false);
  });

  it('falls back to import.meta.main when argv1 is unresolvable', () => {
    expect(isMainEntryPoint('file:///a/index.ts', '/nonexistent/entry', true)).toBe(true);
    expect(isMainEntryPoint('file:///a/index.ts', undefined, true)).toBe(true);
    expect(isMainEntryPoint('file:///a/index.ts', '/nonexistent/entry', false)).toBe(false);
  });
});

describe('CLI main()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints help for --help without opening a database', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain('USAGE');
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('prints the version for --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--version']);
    expect(log).toHaveBeenCalledWith('0.1.0');
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('runs a one-shot workspace index and prints JSON stats', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--index', '/tmp/ws', '--git']);
    expect(mocks.openDatabase).toHaveBeenCalledWith('./synapse.db');
    expect(mocks.migrate).toHaveBeenCalled();
    expect(mocks.assertFts5).toHaveBeenCalled();
    expect(mocks.indexWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ workspacePath: '/tmp/ws', includeGitHistory: true }),
    );
    expect(mocks.dbStats).toHaveBeenCalled();
    const json = log.mock.calls.find((call) => typeof call[0] === 'string' && call[0].startsWith('{'))?.[0];
    expect(json).toContain('"projectName": "demo"');
    log.mockRestore();
  });

  it('starts the stdio server by default', async () => {
    await main([]);
    expect(mocks.runStdio).toHaveBeenCalledTimes(1);
  });

  it('starts the SSE server with --transport sse and --port', async () => {
    await main(['--transport', 'sse', '--port', '9999']);
    expect(mocks.runSse).toHaveBeenCalledWith(expect.anything(), 9999);
  });

  it('rejects an invalid SSE port', async () => {
    await expect(main(['--transport', 'sse', '--port', 'abc'])).rejects.toThrow();
  });
});
