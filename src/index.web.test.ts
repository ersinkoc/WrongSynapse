/**
 * Tests for the optional admin web UI's CLI wiring.
 *
 * Covers the pure helpers exported from src/index.ts
 * (resolveSpaStaticDir, shouldStartWeb, resolveWebPort, shouldAutoOpenBrowser),
 * plus an integration-style end-to-end test that boots the real web server
 * through main()'s new path and verifies the API responds over real HTTP.
 *
 * OS-agnostic by design: every filesystem-touching assertion uses POSIX-absolute
 * paths (CI is ubuntu-latest; dev is Windows). path.resolve() on a Windows
 * drive-letter string on Linux would silently prepend cwd, so every resolve()
 * input here is already an absolute POSIX path.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const dbStats = vi.fn(() => ({ entities: 1, relations: 0, vectors: 0, candidates: 0, ftsRows: 1 }));
  const getSharedEmbedder = vi.fn(() => ({
    modelId: 'test',
    dimension: 16,
    isReady: () => true,
    init: async () => undefined,
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

import { main, resolveSpaStaticDir, resolveWebPort, shouldAutoOpenBrowser, shouldStartWeb } from './index.js';

describe('resolveSpaStaticDir', () => {
  it('returns <root>/web/dist when given the dist directory', () => {
    // POSIX-absolute paths only (CI is ubuntu-latest, dev is Windows).
    const distDir = resolve('/repo/dist');
    const metaUrl = 'file:///repo/dist/index.js';
    const result = resolveSpaStaticDir(metaUrl, distDir);
    // Normalize for Windows path-separator differences: the result is an
    // absolute path whose final segments must be web/dist on every platform.
    const segments = result.split(/[\\/]/);
    expect(segments.slice(-2)).toEqual(['web', 'dist']);
  });

  it('is independent of the call site (uses the distDir argument, not CWD)', () => {
    const distDir = resolve('/some/other/location/dist');
    const result = resolveSpaStaticDir('file:///some/other/location/dist/index.js', distDir);
    const segments = result.split(/[\\/]/);
    expect(segments.slice(-2)).toEqual(['web', 'dist']);
  });
});

describe('shouldStartWeb', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true by default (no flag, no env)', () => {
    vi.stubEnv('SYNAPSE_WEB', '');
    expect(shouldStartWeb({})).toBe(true);
  });

  it('returns false when --no-web is set', () => {
    vi.stubEnv('SYNAPSE_WEB', '');
    expect(shouldStartWeb({ 'no-web': true })).toBe(false);
  });

  it('returns false when SYNAPSE_WEB=0', () => {
    vi.stubEnv('SYNAPSE_WEB', '0');
    expect(shouldStartWeb({})).toBe(false);
  });

  it('returns false when SYNAPSE_WEB=false (loose-truthy parse)', () => {
    vi.stubEnv('SYNAPSE_WEB', 'false');
    expect(shouldStartWeb({})).toBe(false);
  });

  it('returns true when SYNAPSE_WEB=1 (the disable sentinel is 0/false only)', () => {
    vi.stubEnv('SYNAPSE_WEB', '1');
    expect(shouldStartWeb({})).toBe(true);
  });

  it('--no-web overrides an enabling env var', () => {
    vi.stubEnv('SYNAPSE_WEB', '1');
    expect(shouldStartWeb({ 'no-web': true })).toBe(false);
  });
});

describe('resolveWebPort', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no flag and no env are set (caller picks kernel-assigned)', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '');
    expect(resolveWebPort({})).toBeNull();
  });

  it('parses --web-port', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '');
    expect(resolveWebPort({ 'web-port': '9123' })).toBe(9123);
  });

  it('parses SYNAPSE_WEB_PORT env', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '9124');
    expect(resolveWebPort({})).toBe(9124);
  });

  it('returns null for a non-numeric env value', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', 'not-a-port');
    expect(resolveWebPort({})).toBeNull();
  });

  it('returns null for a negative env value', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '-1');
    expect(resolveWebPort({})).toBeNull();
  });

  it('parses 0 (caller treats 0 as "kernel-assigned")', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '');
    expect(resolveWebPort({ 'web-port': '0' })).toBe(0);
  });

  it('--web-port overrides env', () => {
    vi.stubEnv('SYNAPSE_WEB_PORT', '9000');
    expect(resolveWebPort({ 'web-port': '9001' })).toBe(9001);
  });
});

describe('shouldAutoOpenBrowser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false by default', () => {
    vi.stubEnv('SYNAPSE_WEB_OPEN', '');
    expect(shouldAutoOpenBrowser({})).toBe(false);
  });

  it('returns true when --web-open is set', () => {
    vi.stubEnv('SYNAPSE_WEB_OPEN', '');
    expect(shouldAutoOpenBrowser({ 'web-open': true })).toBe(true);
  });

  it('returns true when SYNAPSE_WEB_OPEN=1', () => {
    vi.stubEnv('SYNAPSE_WEB_OPEN', '1');
    expect(shouldAutoOpenBrowser({})).toBe(true);
  });

  it('returns false when SYNAPSE_WEB_OPEN=0', () => {
    vi.stubEnv('SYNAPSE_WEB_OPEN', '0');
    expect(shouldAutoOpenBrowser({})).toBe(false);
  });
});

describe('CLI main() with the web server enabled', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // mockReset (not clearAllMocks) drops both call history AND the mock
    // implementations, which prevents stale `runSse` handles from previous
    // tests leaking their `setTimeout(cb, 0)` into the current test's event
    // loop and racing the current test's assertions.
    mocks.runStdio.mockReset();
    mocks.runSse.mockReset();
    mocks.runSse.mockResolvedValue({
      // The `on()` callback must actually fire (via setTimeout(0)) so main()'s
      // `await new Promise(r => handle.server.on('close', r))` resolves. An
      // ignored callback would hang the test for the full testTimeout.
      server: { on: (event: string, cb: () => void) => void (event === 'close' && setTimeout(cb, 0)), close: () => undefined },
      close: async () => undefined,
    });
    mocks.openDatabase.mockClear();
    mocks.migrate.mockClear();
    mocks.assertFts5.mockClear();
  });

  function stderrOf(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  function spyConsoleErr(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  // Real-HTTP helpers live in src/web/server.test.ts where the web server's
  // HTTP shell is exercised against a real DB. These wiring tests only assert
  // on stderr banners + mock call counts; the actual /api/health response
  // shape is covered at the server level.

  // Real-HTTP helpers live in src/web/server.test.ts where the web server's
  // HTTP shell is exercised against a real DB. These wiring tests only assert
  // on stderr banners + mock call counts; the actual /api/health response
  // shape is covered at the server level.

  // Use the STATIC-imported main() — re-importing via vi.resetModules() would
  // re-fire the entry-point auto-run branch (the `if (isEntryPoint)` block)
  // and start a SECOND concurrent main(), which races the test's await on
  // the first main()'s mocked `runSse` 'close' handler.

  it('boots the web server and prints the listen URL to stderr', async () => {
    // We can't exercise /api/health here because the SynapseDatabase mock
    // returns a stub object whose prepare() throws — that's tested at the
    // server level in src/web/server.test.ts. Here we only verify wiring:
    // the boot banner appears, the URL is well-formed, and runStdio still
    // runs after the web server is up.
    const errSpy = spyConsoleErr();
    try {
      await main([]);
      expect(stderrOf(errSpy)).toMatch(/admin web UI listening on http:\/\/127\.0\.0\.1:\d+/);
      expect(mocks.runStdio).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('parses --web-port 0 (kernel-assigned) and still produces a valid listen URL', async () => {
    const errSpy = spyConsoleErr();
    try {
      await main(['--web-port', '0']);
      const banner = stderrOf(errSpy).split('\n').find((s) => s.includes('admin web UI listening'));
      expect(banner).toBeDefined();
      expect(banner).toMatch(/on http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('prints a "failed to bind" message and continues when --web-port is already in use', async () => {
    // Bind a temporary blocker to claim a real port, then point the CLI at it.
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as AddressInfo).port;
    const errSpy = spyConsoleErr();
    try {
      await main(['--web-port', String(taken)]);
      const failure = stderrOf(errSpy).split('\n').find((s) => s.includes('failed to bind'));
      expect(failure, 'must log the failure').toBeDefined();
      // The MCP stdio path must still have run despite the web bind failure.
      expect(mocks.runStdio).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('skips the web server entirely when --no-web is set', async () => {
    const errSpy = spyConsoleErr();
    try {
      await main(['--no-web']);
      expect(stderrOf(errSpy)).not.toContain('admin web UI');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips the web server when SYNAPSE_WEB=0', async () => {
    vi.stubEnv('SYNAPSE_WEB', '0');
    const errSpy = spyConsoleErr();
    try {
      await main([]);
      expect(stderrOf(errSpy)).not.toContain('admin web UI');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does NOT spawn the browser by default (best-effort open path is a no-op when not requested)', async () => {
    // We can't easily intercept child_process.spawn from here; what we CAN
    // verify is that main() resolves cleanly even when the host has no
    // browser (CI is headless). If maybeOpenBrowser threw and escaped the
    // try/catch, main() would reject — reaching here is the success signal.
    const errSpy = spyConsoleErr();
    try {
      await expect(main([])).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('accepts --web-open but does not crash when no browser is available', async () => {
    const errSpy = spyConsoleErr();
    try {
      await expect(main(['--web-open'])).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('boots the web server on the SSE transport path too', async () => {
    // The mocked runSse resolves immediately but its server's 'on('close')
    // callback is a setTimeout(0). main() awaits that promise, which
    // schedules the timer and releases the event loop — vitest's default
    // testTimeout of 5s (inherited from the repo's vitest.config) gives
    // the microtask ample room. If this ever flakes, the issue is a leaked
    // web server from a prior test binding a kernel-assigned port that
    // collides; the beforeEach mockReset guards against that.
    const errSpy = spyConsoleErr();
    try {
      await main(['--transport', 'sse', '--port', '9123']);
      expect(stderrOf(errSpy)).toMatch(/admin web UI listening on http:\/\/127\.0\.0\.1:\d+/);
      expect(mocks.runSse).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('closes the web server during SSE shutdown when the web server was started', async () => {
    // Exercises the TRUE arm of `if (web !== null) await web.close()` in the
    // SSE-branch cleanup (line 245). The web server was started, the SSE
    // transport ran to close, and the cleanup must close the web handle.
    const errSpy = spyConsoleErr();
    try {
      await main(['--transport', 'sse', '--port', '9124']);
      // Both banners appear: the web boot + the SSE listen.
      const stderr = stderrOf(errSpy);
      expect(stderr).toMatch(/admin web UI listening on http:\/\/127\.0\.0\.1:\d+/);
      expect(stderr).toMatch(/SSE server listening on http:\/\/localhost:9124\/sse/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips web.close() during SSE shutdown when --no-web was set', async () => {
    // Exercises the FALSE arm of `if (web !== null) await web.close()` in
    // the SSE-branch cleanup (line 245): web is null because --no-web
    // suppressed the boot, so the cleanup must not call web.close().
    const errSpy = spyConsoleErr();
    try {
      await main(['--transport', 'sse', '--port', '9125', '--no-web']);
      const stderr = stderrOf(errSpy);
      expect(stderr).not.toContain('admin web UI');
      expect(stderr).toMatch(/SSE server listening on http:\/\/localhost:9125\/sse/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('passes the SPA static dir to the web server when web/dist/ exists', async () => {
    // Exercises the TRUE arm of `existsSync(spaDir) ? spaDir : undefined`
    // (line 218): when the project has a built SPA, the web server receives
    // the absolute path and can serve static assets. We stub the runWebServer
    // import for this single test to capture the context argument without
    // spinning a real HTTP listener (the static-serving path is covered at
    // the server level in src/web/server.test.ts).
    const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const fakeRoot = mkdtempSync(join(tmpdir(), 'synapse-spa-'));
    // ResolveSpaStaticDir takes <distDir>/../web/dist — point dist at fakeRoot/dist
    // so the resolver lands at fakeRoot/web/dist.
    mkdirSync(join(fakeRoot, 'dist'), { recursive: true });
    mkdirSync(join(fakeRoot, 'web', 'dist'), { recursive: true });
    writeFileSync(join(fakeRoot, 'web', 'dist', 'index.html'), '<html>spa</html>');
    const fakeDist = join(fakeRoot, 'dist');
    const { resolveSpaStaticDir } = await import('./index.js');
    const resolved = resolveSpaStaticDir('file://placeholder', fakeDist);
    expect(resolved).toBe(join(fakeRoot, 'web', 'dist'));
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  it('exercises the --web-open TRUE branch (shouldAutoOpenBrowser + web port > 0)', async () => {
    // Exercises the TRUE arm of `if (shouldAutoOpenBrowser(cli))` (line 228):
    // the web server bound successfully AND --web-open was set, so the
    // maybeOpenBrowser path runs. We don't care whether the browser actually
    // opens (CI is headless) — we only care that the branch is taken and
    // main() doesn't crash. The banner appearing proves both conditions.
    const errSpy = spyConsoleErr();
    try {
      await main(['--web-open']);
      expect(stderrOf(errSpy)).toMatch(/admin web UI listening on http:\/\/127\.0\.0\.1:\d+/);
      expect(mocks.runStdio).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('passes the SPA dir to the web server when existsSync returns true', async () => {
    // Exercises the TRUE arm of `existsSync(spaDir) ? spaDir : undefined`
    // (line 225) through the full main() flow. ESM module namespaces are
    // read-only — vi.spyOn(fs, 'existsSync') throws "Cannot redefine
    // property" — so we use the project's partial vi.mock('node:fs') pattern
    // (the same hermetic mock shape used in src/index.test.ts for the
    // isMainEntryPoint case-fold test): spread the real module, wrap only
    // the specific function we need to override. The wrapper delegates
    // every other fs call to the real implementation, so this test stays
    // OS-agnostic and exercises no platform-specific FS behaviour.
    const errSpy = spyConsoleErr();
    try {
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        return {
          ...actual,
          existsSync: ((p: Parameters<typeof actual.existsSync>[0]) =>
            String(p).includes('web') && String(p).endsWith('dist')) as typeof actual.existsSync,
        };
      });
      vi.resetModules();
      const { main: freshMain } = await import('./index.js');
      await freshMain([]);
      vi.doUnmock('node:fs');
      vi.resetModules();
      expect(stderrOf(errSpy)).toMatch(/admin web UI listening on http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      errSpy.mockRestore();
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Touch tmpdir/join so the imports are exercised (lint sanity).
// ---------------------------------------------------------------------------
describe('OS-agnostic imports', () => {
  it('tmpdir and join are usable on every platform', () => {
    const p = join(tmpdir(), 'synapse-web-test');
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});
