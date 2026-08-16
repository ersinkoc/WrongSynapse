/**
 * Signal-path teardown tests for demo mode (Chimera follow-up).
 *
 * Covers the real shutdown() path end-to-end through the entry-point
 * re-import pattern (same as src/index.test.ts): with --demo active,
 * a SIGINT must stop the feeder BEFORE the DB closes BEFORE the process
 * exits, and a second signal arriving mid-teardown must await the SAME
 * memoized teardown instead of racing a parallel close.
 */

import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from './mcp/tools/index.js';

const mocks = vi.hoisted(() => {
  const runStdio = vi.fn(async (_ctx: ToolContext) => {});
  const runSse = vi.fn(async (_ctx: ToolContext, _port: number) => ({
    server: { on: (_e: string, _cb: () => void) => undefined, close: () => undefined },
    close: async () => undefined,
  }));
  const openDatabase = vi.fn(async () => ({
    backend: 'better-sqlite3', path: ':memory:', exec: vi.fn(), prepare: vi.fn(),
    transaction: <T>(fn: () => T): T => fn(), close: vi.fn(),
  }));
  const migrate = vi.fn();
  const assertFts5 = vi.fn();
  const dbStats = vi.fn(() => ({ entities: 0, relations: 0, vectors: 0, candidates: 0, ftsRows: 0 }));
  const getSharedEmbedder = vi.fn(() => ({
    modelId: 'test', dimension: 16, isReady: () => true,
    init: async () => undefined,
    embed: async () => new Float32Array(16),
    embedBatch: async () => [new Float32Array(16)],
  }));
  // DemoFeeder capture with a GATEABLE stop(): tests control when the
  // in-flight tick drain finishes, which is exactly what the re-entry
  // guard and the ordering assertions need to observe.
  let releaseStop: (() => void) | undefined;
  let stopGate: Promise<void> = new Promise(() => undefined);
  const demoStart = vi.fn();
  const demoStop = vi.fn(async () => {
    await stopGate;
  });
  return {
    runStdio, runSse, openDatabase, migrate, assertFts5, dbStats, getSharedEmbedder,
    demoStart, demoStop,
    armStopGate(): Promise<void> {
      stopGate = new Promise((resolve) => {
        releaseStop = resolve;
      });
      return stopGate;
    },
    releaseStopGate(): void {
      releaseStop?.();
    },
  };
});

vi.mock('./db/connection.js', () => ({ openDatabase: mocks.openDatabase }));
vi.mock('./db/schema.js', () => ({ migrate: mocks.migrate, assertFts5: mocks.assertFts5 }));
vi.mock('./db/queries.js', () => ({
  dbStats: mocks.dbStats,
  // Every VALUE the real src/engine/demo.ts imports must exist here — the
  // partial mock of ./engine/demo.js resolves its imports through this mock.
  getEntityByScope: vi.fn(() => undefined),
  insertCandidate: vi.fn(() => 'stub-id'),
  insertEntity: vi.fn(() => true),
  insertRelation: vi.fn(),
  listCandidates: vi.fn(() => []),
  setCandidateStatus: vi.fn(),
  upsertVector: vi.fn(),
}));
vi.mock('./engine/embedding.js', () => ({ getSharedEmbedder: mocks.getSharedEmbedder }));
vi.mock('./engine/demo.js', async (importOriginal) => ({
  // Partial mock: real constants flow through; only the class is replaced.
  ...(await importOriginal<typeof import('./engine/demo.js')>()),
  DemoFeeder: class {
    start(): void {
      mocks.demoStart();
    }
    stop(): Promise<void> {
      return mocks.demoStop();
    }
    ensureScaffold(): void {}
  },
}));
vi.mock('./mcp/server.js', () => ({
  runStdio: mocks.runStdio,
  runSse: mocks.runSse,
  SERVER_NAME: 'wrongsynapse',
  SERVER_VERSION: '0.1.0',
}));
vi.mock('./web/server.js', () => ({
  runWebServer: vi.fn(async () => ({
    port: 0,
    url: 'http://127.0.0.1:0',
    server: { on: (_e: string, _cb: () => void) => undefined, close: () => undefined },
    close: async () => undefined,
  })),
}));

let realArgv: string[];
let onSpy: ReturnType<typeof vi.spyOn>;
let sigintHandler: ((...args: unknown[]) => void) | undefined;

const entryPath = fileURLToPath(import.meta.url).replace(/index\.signals\.test\.ts$/, 'index.ts');

function forceEntryArgv(tail: string[] = []): void {
  process.argv = [process.argv[0]!, entryPath, ...tail];
}

function reset(): void {
  process.argv = realArgv;
  sigintHandler = undefined;
  mocks.openDatabase.mockClear();
  mocks.runStdio.mockClear();
  mocks.demoStart.mockClear();
  mocks.demoStop.mockClear();
}

describe('signal teardown with demo mode active', () => {
  beforeAll(() => {
    realArgv = [...process.argv];
    // Capture signal registrations instead of attaching real listeners.
    onSpy = vi.spyOn(process, 'on').mockImplementation(
      ((event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'SIGINT') sigintHandler = cb;
        return process;
      }) as never,
    );
  });

  afterAll(() => {
    onSpy.mockRestore();
  });

  afterEach(() => {
    reset();
  });

  it('SIGINT stops the feeder before closing the DB before exiting (feeder → DB → exit)', async () => {
    // An open stop gate parks teardown inside activeDemo.stop() until the
    // test releases it — deterministic observation points.
    const gate = mocks.armStopGate();
    const dbClose = vi.fn();
    mocks.openDatabase.mockResolvedValueOnce({
      backend: 'better-sqlite3', path: ':memory:', exec: vi.fn(), prepare: vi.fn(),
      transaction: <T>(fn: () => T): T => fn(), close: dbClose,
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      forceEntryArgv(['--demo', '--no-web']);
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.runStdio).toHaveBeenCalledTimes(1), { timeout: 1000 });
      await vi.waitFor(() => expect(mocks.demoStart).toHaveBeenCalledTimes(1), { timeout: 1000 });

      const handler = sigintHandler;
      expect(handler, 'SIGINT handler must be registered').toBeDefined();
      const teardown = handler!();
      // While parked inside feeder.stop(): nothing downstream has run.
      await new Promise((r) => setImmediate(r));
      expect(mocks.demoStop).toHaveBeenCalledTimes(1);
      expect(dbClose).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      mocks.releaseStopGate();
      await gate;
      await teardown;

      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      const stopOrder = mocks.demoStop.mock.invocationCallOrder[0];
      const closeOrder = dbClose.mock.invocationCallOrder[0];
      const exitOrder = exit.mock.invocationCallOrder[0];
      expect(stopOrder!).toBeLessThan(closeOrder!);
      expect(closeOrder!).toBeLessThan(exitOrder!);
    } finally {
      exit.mockRestore();
      reset();
    }
  });

  it('a second SIGINT mid-teardown awaits the SAME memoized teardown (re-entry guard)', async () => {
    const gate = mocks.armStopGate();
    const dbClose = vi.fn();
    mocks.openDatabase.mockResolvedValueOnce({
      backend: 'better-sqlite3', path: ':memory:', exec: vi.fn(), prepare: vi.fn(),
      transaction: <T>(fn: () => T): T => fn(), close: dbClose,
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      forceEntryArgv(['--demo', '--no-web']);
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.demoStart).toHaveBeenCalledTimes(1), { timeout: 1000 });

      const handler = sigintHandler!;
      const first = handler!();
      const second = handler!(); // stacked signal: must NOT start a parallel teardown
      await new Promise((r) => setImmediate(r));

      mocks.releaseStopGate();
      await gate;
      await Promise.all([first, second]);

      // One teardown, not two: the guard memoized the promise.
      expect(mocks.demoStop).toHaveBeenCalledTimes(1);
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      reset();
    }
  });
});
