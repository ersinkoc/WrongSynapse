/**
 * Demo-mode CLI wiring tests.
 *
 * Covers the pure helpers exported from src/index.ts (shouldStartDemo,
 * resolveDemoInterval, resolveDemoSeed) with the same flag > env > default
 * semantics as the web helpers, plus an integration-style test that boots
 * main() with --demo and verifies the feeder starts against the isolated
 * synapse-demo.db default and stops on process signals.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from './mcp/tools/index.js';

const mocks = vi.hoisted(() => {
  const runStdio = vi.fn(async (_ctx: ToolContext) => {});
  const runSse = vi.fn(async (_ctx: ToolContext, _port: number) => ({
    server: { on: (_event: string, _cb: () => void) => undefined, close: () => undefined },
    close: async () => undefined,
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
  const getSharedEmbedder = vi.fn(() => ({
    modelId: 'test',
    dimension: 16,
    isReady: () => true,
    init: async () => undefined,
    embed: async () => new Float32Array(16),
    embedBatch: async () => [new Float32Array(16)],
  }));
  // DemoFeeder instance capture: start/stop calls + constructor options.
  const demoStart = vi.fn();
  const demoStop = vi.fn();
  const demoOptions: { intervalMs?: number; seed?: number }[] = [];
  // scheduler: capture ticks without timers.
  const demoTicks: (() => void)[] = [];
  return {
    runStdio,
    runSse,
    openDatabase,
    migrate,
    assertFts5,
    getSharedEmbedder,
    demoStart,
    demoStop,
    demoOptions,
    demoTicks,
  };
});

vi.mock('./db/connection.js', () => ({ openDatabase: mocks.openDatabase }));
vi.mock('./db/schema.js', () => ({ migrate: mocks.migrate, assertFts5: mocks.assertFts5 }));
vi.mock('./db/queries.js', () => ({
  dbStats: vi.fn(() => ({ entities: 0, relations: 0, vectors: 0, candidates: 0, ftsRows: 0 })),
}));
vi.mock('./engine/embedding.js', () => ({ getSharedEmbedder: mocks.getSharedEmbedder }));
vi.mock('./engine/parser.js', () => ({
  indexWorkspace: vi.fn(async () => ({
    projectName: 'demo',
    projectScope: 'proj:demo',
    entitiesCreated: 0,
    entitiesUpdated: 0,
    entitiesDeleted: 0,
    filesScanned: 0,
    filesParsed: 0,
    filesFailed: 0,
    symbolsIndexed: 0,
    relationsIndexed: 0,
    commitsIndexed: 0,
    embeddingsStored: 0,
    warnings: [],
  })),
}));
vi.mock('./engine/demo.js', () => ({
  DEFAULT_DEMO_INTERVAL_MS: 1000,
  DEFAULT_DEMO_SEED: 42,
  DemoFeeder: class {
    constructor(options: { intervalMs?: number; seed?: number }) {
      mocks.demoOptions.push(options);
    }
    start(): void {
      mocks.demoStart();
    }
    stop(): void {
      mocks.demoStop();
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

import { main, resolveDemoInterval, resolveDemoSeed, shouldStartDemo } from './index.js';

describe('shouldStartDemo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off by default', () => {
    expect(shouldStartDemo({})).toBe(false);
  });

  it('turns on via --demo flag', () => {
    expect(shouldStartDemo({ demo: true })).toBe(true);
  });

  it('turns on via SYNAPSE_DEMO=1', () => {
    vi.stubEnv('SYNAPSE_DEMO', '1');
    expect(shouldStartDemo({})).toBe(true);
  });
});

describe('resolveDemoInterval', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 1000ms', () => {
    expect(resolveDemoInterval({})).toBe(1000);
  });

  it('flag wins over env', () => {
    vi.stubEnv('SYNAPSE_DEMO_INTERVAL', '5000');
    expect(resolveDemoInterval({ 'demo-interval': '250' })).toBe(250);
  });

  it('env applies when flag absent', () => {
    vi.stubEnv('SYNAPSE_DEMO_INTERVAL', '2500');
    expect(resolveDemoInterval({})).toBe(2500);
  });

  it('rejects non-numeric, zero, negative, and NaN values back to default', () => {
    expect(resolveDemoInterval({ 'demo-interval': 'fast' })).toBe(1000);
    expect(resolveDemoInterval({ 'demo-interval': '0' })).toBe(1000);
    expect(resolveDemoInterval({ 'demo-interval': '-5' })).toBe(1000);
    expect(resolveDemoInterval({ 'demo-interval': 'NaN' })).toBe(1000);
  });
});

describe('resolveDemoSeed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 42', () => {
    expect(resolveDemoSeed({})).toBe(42);
  });

  it('flag wins over env; env applies alone; invalid falls back', () => {
    vi.stubEnv('SYNAPSE_DEMO_SEED', '900');
    expect(resolveDemoSeed({ 'demo-seed': '7' })).toBe(7);
    expect(resolveDemoSeed({})).toBe(900);
    expect(resolveDemoSeed({ 'demo-seed': 'xyz' })).toBe(42);
  });
});

describe('main() demo boot + shutdown', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.openDatabase.mockClear();
    mocks.demoOptions.length = 0;
    mocks.demoTicks.length = 0;
    mocks.demoStart.mockClear();
    mocks.demoStop.mockClear();
  });

  it('boots the feeder with flag-resolved interval/seed and the isolated demo DB', async () => {
    await main(['--demo', '--demo-interval', '500', '--demo-seed', '9', '--no-web']);
    // The mocked DemoFeeder captures the full options object; assert on the
    // demo-relevant fields only (db/embedder carry live mocks that toEqual
    // cannot deeply compare).
    const opts = mocks.demoOptions[0] as { intervalMs?: number; seed?: number } | undefined;
    expect(opts?.intervalMs).toBe(500);
    expect(opts?.seed).toBe(9);
    expect(mocks.demoStart).toHaveBeenCalledTimes(1);
    // Isolated default DB path for demo mode.
    expect(mocks.openDatabase).toHaveBeenCalledWith('./synapse-demo.db');
  });

  it('does not boot the feeder (and uses the normal DB) without --demo', async () => {
    await main(['--no-web']);
    expect(mocks.demoStart).not.toHaveBeenCalled();
    expect(mocks.openDatabase).toHaveBeenCalledWith('./synapse.db');
  });

  it('demotes --demo under one-shot --index: real DB path, no feeder, warning on stderr', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.openDatabase.mockClear();
    await main(['--demo', '--index', '.']);
    // The one-shot branch keeps the normal DB resolution...
    expect(mocks.openDatabase).toHaveBeenCalledWith('./synapse.db');
    // ...and the feeder never boots.
    expect(mocks.demoStart).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('demo mode ignored with --index'));
    errSpy.mockRestore();
  });
});
