/**
 * CLI entry-point tests. main() is exported and takes argv, so the help,
 * version, index, SSE, and stdio branches can be exercised without spawning
 * a process. Heavy dependencies are mocked.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    vi.unstubAllEnvs();
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
    await expect(main(['--transport', 'sse', '--port', 'abc'])).rejects.toThrow(/invalid port 'abc'/);
  });

  it('resolves --db from SYNAPSE_DB_PATH when the flag is absent', async () => {
    vi.stubEnv('SYNAPSE_DB_PATH', '/env/default.db');
    await main(['--index', '/tmp/ws']);
    expect(mocks.openDatabase).toHaveBeenCalledWith('/env/default.db');
  });

  it('resolves the SSE port from SYNAPSE_PORT when the flag is absent', async () => {
    vi.stubEnv('SYNAPSE_PORT', '9123');
    await main(['--transport', 'sse']);
    expect(mocks.runSse).toHaveBeenCalledWith(expect.anything(), 9123);
  });

  it('names SYNAPSE_PORT as the source when the env port is invalid', async () => {
    vi.stubEnv('SYNAPSE_PORT', 'not-a-number');
    await expect(main(['--transport', 'sse'])).rejects.toThrow(/SYNAPSE_PORT/);
  });

  it('uses the default port when neither flag nor env is set', async () => {
    await main(['--transport', 'sse']);
    expect(mocks.runSse).toHaveBeenCalledWith(expect.anything(), 8765);
  });

  it('treats an empty --model-dir as absent', async () => {
    await main(['--index', '/tmp/ws', '--model-dir', '']);
    expect(mocks.getSharedEmbedder).toHaveBeenCalledWith(undefined);
  });

  it('passes model-dir and remote-model options to the embedder', async () => {
    await main(['--index', '/tmp/ws', '--model-dir', '/m', '--allow-remote-model']);
    expect(mocks.getSharedEmbedder).toHaveBeenCalledWith({ localModelDir: '/m', allowRemoteModels: true });
  });

  it('allows the remote model via env alone', async () => {
    vi.stubEnv('SYNAPSE_ALLOW_REMOTE_MODEL', '1');
    await main(['--index', '/tmp/ws']);
    expect(mocks.getSharedEmbedder).toHaveBeenCalledWith({ localModelDir: undefined, allowRemoteModels: true });
  });

  it('closes the database after a one-shot index', async () => {
    const close = vi.fn();
    mocks.openDatabase.mockResolvedValueOnce({
      backend: 'better-sqlite3', path: ':memory:', exec: vi.fn(), prepare: vi.fn(),
      transaction: <T>(fn: () => T): T => fn(), close,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['--index', '/tmp/ws']);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe('entry-point auto-run branch (module re-import)', () => {
  // Snapshot the FULL argv: the re-imported entry branch calls main() with its
  // default argv = process.argv.slice(2), so the vitest runner's own CLI flags
  // (e.g. --coverage, which CI passes) would reach strict parseArgs and abort
  // the worker via the real process.exit(1). Controlling argv[1] alone is not
  // enough; the tail must be empty whenever entry is forced.
  let realArgv: string[];
  const entryPath = fileURLToPath(import.meta.url).replace(/index\.test\.ts$/, 'index.ts');
  let onSpy: ReturnType<typeof vi.spyOn>;
  let sigintHandler: ((...args: unknown[]) => void) | undefined;
  let sigtermHandler: ((...args: unknown[]) => void) | undefined;

  beforeAll(() => {
    realArgv = [...process.argv];
    // Capture signal registrations instead of attaching real listeners to the
    // test-runner process (prevents MaxListeners growth across re-imports).
    onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(
        ((event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'SIGINT') sigintHandler = cb;
          if (event === 'SIGTERM') sigtermHandler = cb;
          return process;
        }) as never,
      );
  });

  afterAll(() => {
    onSpy.mockRestore();
  });

  /** Restore the runner's argv and clear captured handlers. */
  function reset(): void {
    process.argv = [...realArgv];
    sigintHandler = undefined;
    sigtermHandler = undefined;
  }

  /** Force the entry branch: argv[1] = this module, empty flag tail. */
  function forceEntryArgv(): void {
    process.argv = [process.argv[0]!, entryPath];
  }

  /** One macrotask yield: flushes every pending microtask (deterministic). */
  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  afterEach(() => {
    reset();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('runs main() automatically when argv[1] resolves to this module', async () => {
    // Precondition: if realpath matching ever breaks on this platform, the
    // entry branch would silently never fire and every test here would pass
    // by skipping the code under test — fail loudly instead. Compare the
    // ENTRY module's URL form (what index.ts sees as its own import.meta.url)
    // against the argv path we are about to install.
    expect(isMainEntryPoint(pathToFileURL(entryPath).href, entryPath, undefined)).toBe(true);
    forceEntryArgv();
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.runStdio).toHaveBeenCalledTimes(1), { timeout: 1000 });
    } finally {
      reset();
    }
  });

  it('does not run main() when argv[1] is a different program', async () => {
    try {
      vi.resetModules();
      await import('./index.js');
      // main() is invoked synchronously in the entry branch, so if it were
      // going to run, its first await (openDatabase) would have been scheduled
      // already — one macrotask flush settles that deterministically.
      await tick();
      expect(mocks.runStdio).not.toHaveBeenCalled();
    } finally {
      reset();
    }
  });

  it('reports and exits(1) when the auto-run main() rejects', async () => {
    forceEntryArgv();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mocks.runStdio.mockRejectedValueOnce(new Error('boot failure'));
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith('boot failure'), { timeout: 1000 });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
      reset();
    }
  });

  /** Shared signal-shutdown assertions with explicit preconditions. */
  async function expectSignalShutdown(): Promise<void> {
    forceEntryArgv();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.runStdio).toHaveBeenCalledTimes(1), { timeout: 1000 });
      // Preconditions: if these fail, the entry-point branch never re-ran and
      // the order assertion below would compare undefined — fail with cause.
      const handler = sigintHandler;
      expect(handler, 'SIGINT handler must be registered').toBeDefined();

      const firstResult = mocks.openDatabase.mock.results[0];
      expect(firstResult, 'main() must have opened the database').toBeDefined();
      const dbHandle = (await firstResult!.value) as { close: ReturnType<typeof vi.fn> };
      handler!();
      expect(dbHandle.close).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      const closeOrder = dbHandle.close.mock.invocationCallOrder[0];
      const exitOrder = exit.mock.invocationCallOrder[0];
      expect(closeOrder, 'shutdown() must have closed the DB').toBeDefined();
      expect(exitOrder, 'shutdown() must have exited').toBeDefined();
      // The DB must close BEFORE the process exits (graceful shutdown order).
      expect(closeOrder!).toBeLessThan(exitOrder!);
    } finally {
      exit.mockRestore();
      reset();
    }
  }

  it('closes the live DB and exits(0) when SIGINT fires (shutdown lifecycle)', async () => {
    await expectSignalShutdown();
  });

  it('registers both SIGINT and SIGTERM handlers at entry', async () => {
    forceEntryArgv();
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.runStdio).toHaveBeenCalledTimes(1), { timeout: 1000 });
      // Both signals route to the same shutdown(); assert registration rather
      // than re-invoking the identical code path.
      expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(sigintHandler).toBe(sigtermHandler);
    } finally {
      reset();
    }
  });

  it('tolerates a signal before main() populates activeDb (null arm)', async () => {
    forceEntryArgv();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Park main() at its first await forever: activeDb stays deterministically
    // null and no orphan continuation can resolve after the simulated exit.
    mocks.openDatabase.mockReturnValueOnce(new Promise(() => {}));
    try {
      vi.resetModules();
      await import('./index.js');
      expect(sigintHandler).toBeDefined();
      sigintHandler!();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
      reset();
    }
  });

  it('exits cleanly even when db.close() throws (catch arm)', async () => {
    forceEntryArgv();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mocks.openDatabase.mockResolvedValueOnce({
      backend: 'better-sqlite3', path: ':memory:', exec: vi.fn(), prepare: vi.fn(),
      transaction: <T>(fn: () => T): T => fn(), close: vi.fn(() => { throw new Error('already closed'); }),
    });
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mocks.runStdio).toHaveBeenCalledTimes(1), { timeout: 1000 });
      sigintHandler!();
      expect(exit).toHaveBeenCalledWith(0); // best-effort close, still exits
    } finally {
      exit.mockRestore();
      reset();
    }
  });

  it('stringifies non-Error rejections from auto-run main() (catch ternary arm)', async () => {
    forceEntryArgv();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mocks.runStdio.mockRejectedValueOnce('plain string boot failure');
    try {
      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith('plain string boot failure'), { timeout: 1000 });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
      reset();
    }
  });
});
