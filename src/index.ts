#!/usr/bin/env node
/**
 * WrongSynapse — local-first Cognitive Memory Operating System + MCP server.
 *
 * CLI usage:
 *   wrongsynapse                            # stdio MCP server (default)
 *   wrongsynapse --transport sse --port 8765
 *   wrongsynapse --index <workspace> [--git]
 *   wrongsynapse --db <path>              # override DB location (env: SYNAPSE_DB_PATH)
 *   wrongsynapse --model-dir <dir>        # local model files (env: SYNAPSE_MODEL_DIR)
 *   wrongsynapse --allow-remote-model     # one-time model download (env: SYNAPSE_ALLOW_REMOTE_MODEL=1)
 *   wrongsynapse --no-web                  # disable the optional admin web UI (default: enabled)
 *   wrongsynapse --web-port <n>           # bind the web UI to a specific port (default: kernel-assigned)
 *   wrongsynapse --web-open                # auto-open the web UI in the default browser when it starts
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { openDatabase, type SynapseDatabase } from './db/connection.js';
import { assertFts5, migrate } from './db/schema.js';
import { dbStats } from './db/queries.js';
import { getSharedEmbedder } from './engine/embedding.js';
import { indexWorkspace } from './engine/parser.js';
import { DemoFeeder, DEFAULT_DEMO_INTERVAL_MS, DEFAULT_DEMO_SEED } from './engine/demo.js';
import { runSse, runStdio, SERVER_VERSION } from './mcp/server.js';
import { TOOL_DEFINITIONS } from './mcp/tools/definitions.js';
import { runWebServer, type WebServerHandle } from './web/server.js';

interface CliValues {
  transport?: string;
  port?: string;
  db?: string;
  index?: string;
  'model-dir'?: string;
  'allow-remote-model'?: boolean;
  git?: boolean;
  help?: boolean;
  version?: boolean;
  'no-web'?: boolean;
  'web-port'?: string;
  'web-open'?: boolean;
  demo?: boolean;
  'demo-interval'?: string;
  'demo-seed'?: string;
}

function printHelp(): void {
  console.log(`WrongSynapse v${SERVER_VERSION} — local-first cognitive memory + MCP server

USAGE
  wrongsynapse [options]

OPTIONS
  --transport <stdio|sse>   MCP transport (default: stdio)
  --port <number>           SSE HTTP port (default: 8765)
  --db <path>               SQLite database path (default: ./synapse.db, env SYNAPSE_DB_PATH)
  --model-dir <dir>         Local model files (env SYNAPSE_MODEL_DIR)
  --allow-remote-model      Allow one-time model download (env SYNAPSE_ALLOW_REMOTE_MODEL=1)
  --index <workspace>       One-shot: index a workspace and exit (JSON stats)
  --git                     With --index: also link git commit history
  --no-web                  Disable the optional admin web UI (default: enabled, env SYNAPSE_WEB=0 to disable)
  --web-port <number>       Bind the web UI to a specific port (default: kernel-assigned free port,
                            env SYNAPSE_WEB_PORT). The web UI picks a new free port on every start.
  --web-open                Auto-open the web UI in the default browser (env SYNAPSE_WEB_OPEN=1)
  --demo                    Demo mode: continuously stream synthetic observations into memory
  --demo-interval <ms>      Milliseconds between demo observations (default 1000, env SYNAPSE_DEMO_INTERVAL)
  --demo-seed <n>           PRNG seed for a reproducible demo stream (default 42, env SYNAPSE_DEMO_SEED)
  -h, --help                Show this help
  -v, --version             Show version

ENVIRONMENT
  SYNAPSE_DB_PATH           Database path (default ./synapse.db)
  SYNAPSE_MODEL_DIR         Local model directory (offline inference)
  SYNAPSE_EMBEDDING_MODEL   Override embedding model id (default Xenova/all-MiniLM-L6-v2)
  SYNAPSE_ALLOW_REMOTE_MODEL  Set to 1 to allow a one-time model download (then go offline)
  SYNAPSE_PORT              SSE HTTP port when --port is absent (default 8765)
  SYNAPSE_WEB               Set to 0 to disable the optional admin web UI (default: enabled)
  SYNAPSE_WEB_PORT          Web UI port (default: kernel-assigned free port — different on every start)
  SYNAPSE_WEB_OPEN          Set to 1 to auto-open the web UI when it starts (default: off)
  SYNAPSE_DEMO              Set to 1 to enable demo mode (same as --demo)
  SYNAPSE_DEMO_INTERVAL     Milliseconds between demo observations (default 1000)
  SYNAPSE_DEMO_SEED         PRNG seed for a reproducible demo stream (default 42)

MCP TOOLS
${TOOL_DEFINITIONS.map((t) => `  ${t.name} — ${t.description.split('.')[0]}.`).join('\n')}
`);
}

/**
 * Resolve the path to the optional admin SPA's built static directory.
 *
 * The SPA lives at `<repo-root>/web/dist/` and is shipped separately from the
 * npm-published `dist/` so the published artifact stays lean. When the SPA has
 * not been built (the typical case for npm-installed users who don't run the
 * frontend), the path simply does not exist on disk — `runWebServer` handles
 * that gracefully by returning 404 for non-API requests.
 *
 * Resolving from `distDir` (passed by the caller) keeps the path stable
 * regardless of the process's CWD (the user may launch the CLI from any
 * directory). The `metaUrl` parameter is reserved for future use cases (e.g.
 * computing the path via `import.meta.url` instead of an argument) and is
 * currently accepted-but-unused for API stability.
 */
export function resolveSpaStaticDir(_metaUrl: string, distDir: string): string {
  // distDir is .../dist/; web/dist is its sibling.
  const root = dirname(resolve(distDir));
  return resolve(root, 'web', 'dist');
}

/** Decide whether the optional admin web UI should start in this invocation. */
export function shouldStartWeb(cli: CliValues): boolean {
  // Explicit flag wins over env; both default to enabled.
  const envRaw = process.env['SYNAPSE_WEB'];
  const envDisabled = envRaw === '0' || envRaw === 'false';
  if (cli['no-web'] === true) return false;
  if (envDisabled) return false;
  return true;
}

/** Decide the requested web UI port. Returns null when the user did not pick one. */
export function resolveWebPort(cli: CliValues): number | null {
  const raw = cli['web-port'] ?? process.env['SYNAPSE_WEB_PORT'];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** Decide whether to auto-open the browser. */
export function shouldAutoOpenBrowser(cli: CliValues): boolean {
  if (cli['web-open'] === true) return true;
  return process.env['SYNAPSE_WEB_OPEN'] === '1';
}

/** Decide whether demo mode (continuous synthetic ingestion) is enabled. */
export function shouldStartDemo(cli: CliValues): boolean {
  if (cli.demo === true) return true;
  return process.env['SYNAPSE_DEMO'] === '1';
}

/** Resolve the demo tick interval in ms (flag > env > default). Invalid → default. */
export function resolveDemoInterval(cli: CliValues, fallback: number = DEFAULT_DEMO_INTERVAL_MS): number {
  const raw = cli['demo-interval'] ?? process.env['SYNAPSE_DEMO_INTERVAL'];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Resolve the demo PRNG seed (flag > env > default). Invalid → default. */
export function resolveDemoSeed(cli: CliValues, fallback: number = DEFAULT_DEMO_SEED): number {
  const raw = cli['demo-seed'] ?? process.env['SYNAPSE_DEMO_SEED'];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Best-effort auto-open of a URL in the user's default browser. Failures are
 * swallowed — auto-opening is a convenience, not a core feature, and a host
 * without a browser (headless server, CI) must not crash the CLI.
 */
async function maybeOpenBrowser(url: string): Promise<void> {
  try {
    const cp = await import('node:child_process');
    /* v8 ignore start */
    // The win32 + darwin arms are OS-specific and unreachable on linux CI
    // (where the coverage gate runs). The CI host picks the `xdg-open` arm;
    // the macOS `open` and Windows `start` arms are exercised in production
    // but not by CI tests. Marked defensive — no `process.platform` stub
    // gymnastics to cover them.
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    /* v8 ignore stop */
    // `spawn` is asynchronous: the synchronous throw only catches "no such
    // binary at fork time"; the real failure (ENOENT when the host resolves
    // the command later, exec-mismatch, etc.) arrives on the ChildProcess's
    // 'error' event. A no-op listener routes that into the void; `unref()`
    // keeps the (potentially-orphaned) child from blocking event-loop exit.
    const child = cp.spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    /* v8 ignore next -- OS-specific: fires only when the spawned opener dies
       asynchronously (no xdg-open on headless CI); the win32 `start` arm
       exercises it in local runs but not on the linux coverage host. */
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // best-effort: a headless host with no xdg-open / no default browser just logs and moves on.
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      transport: { type: 'string', default: 'stdio' },
      port: { type: 'string' },
      db: { type: 'string' },
      index: { type: 'string' },
      'model-dir': { type: 'string' },
      'allow-remote-model': { type: 'boolean', default: false },
      git: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      'no-web': { type: 'boolean', default: false },
      'web-port': { type: 'string' },
      'web-open': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      'demo-interval': { type: 'string' },
      'demo-seed': { type: 'string' },
    },
    allowPositionals: true,
  });
  const cli = values as unknown as CliValues;

  if (cli.help === true) {
    printHelp();
    return;
  }
  if (cli.version === true) {
    console.log(SERVER_VERSION);
    return;
  }
  // Fail fast on a typo'd transport BEFORE opening a database (otherwise
  // `--transport sse2` would silently start stdio and create a stray synapse.db).
  if (cli.transport !== 'stdio' && cli.transport !== 'sse') {
    throw new Error(`invalid transport '${cli.transport}' (expected 'stdio' or 'sse')`);
  }

  // Flag > env > default resolution keeps every arm observable (parseArgs
  // defaults would collapse the env fallback into an untestable constant).
  // Demo mode isolation: SYNAPSE_DB_PATH is ignored in demo mode so a
  // configured real database never receives synthetic records. An explicit
  // --db ALWAYS wins — including over demo isolation (deliberate escape
  // hatch; there is no confirmation gate, so a stray --db from shell
  // history can point demo writes at a real DB — caveat documented).
  // One-shot --index is an explicit data target (the feeder never boots in
  // that branch), so it keeps the normal DB resolution and --demo is
  // demoted with a warning.
  const demoMode = shouldStartDemo(cli);
  const oneShotIndex = cli.index !== undefined && cli.index !== '';
  const db = await openDatabase(
    cli.db ?? (demoMode && !oneShotIndex ? './synapse-demo.db' : process.env['SYNAPSE_DB_PATH'] ?? './synapse.db'),
  );
  if (demoMode && oneShotIndex) {
    console.error('WrongSynapse demo mode ignored with --index (one-shot index targets the real database).');
  }
  activeDb = db;
  migrate(db);
  assertFts5(db);

  const modelDir = cli['model-dir'] !== undefined && cli['model-dir'] !== '' ? cli['model-dir'] : undefined;
  const allowRemote = cli['allow-remote-model'] === true || process.env['SYNAPSE_ALLOW_REMOTE_MODEL'] === '1';
  const embedder = getSharedEmbedder(
    modelDir !== undefined || allowRemote ? { localModelDir: modelDir, allowRemoteModels: allowRemote } : undefined,
  );
  const ctx = { db, embedder };

  // One-shot workspace index mode
  if (cli.index !== undefined && cli.index !== '') {
    const result = await indexWorkspace(db, embedder, {
      workspacePath: cli.index,
      includeGitHistory: cli.git === true,
    });
    console.log(JSON.stringify({ ...result, db_stats: dbStats(db) }, null, 2));
    db.close();
    return;
  }

  // Boot the optional admin web UI before branching on the MCP transport so
  // it runs in the background whether the user picked stdio OR sse. A bind
  // failure is logged and ignored — the main app must keep working.
  let web: WebServerHandle | null = null;
  if (shouldStartWeb(cli)) {
    const webPort = resolveWebPort(cli) ?? 0;
    const spaDir = resolveSpaStaticDir(import.meta.url, dirname(fileURLToPath(import.meta.url)));
    web = await runWebServer({ db, staticDir: spaDir }, webPort);
    if (web.port > 0) {
      console.error(`WrongSynapse admin web UI listening on ${web.url}`);
      if (shouldAutoOpenBrowser(cli)) {
        void maybeOpenBrowser(web.url);
      }
    } else {
      console.error('WrongSynapse admin web UI failed to bind (port in use or unavailable); MCP server continuing.');
      web = null;
    }
  }
  activeWeb = web;

  // Demo mode: continuously stream synthetic observations into memory.
  // The feeder starts only AFTER the transport is up — an invalid SSE port
  // or a rejected server start must reject main() without leaving the
  // feeder running (its synthetic writes would continue in hosts that
  // catch the rejection). SIGINT/SIGTERM still own teardown via activeDemo.
  const startDemo = (): DemoFeeder | null => {
    if (!shouldStartDemo(cli)) return null;
    const feeder = new DemoFeeder({
      db,
      embedder,
      intervalMs: resolveDemoInterval(cli),
      seed: resolveDemoSeed(cli),
    });
    feeder.start();
    return feeder;
  };

  if (cli.transport === 'sse') {
    const portRaw = cli.port ?? process.env['SYNAPSE_PORT'] ?? '8765';
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`invalid port '${portRaw}' (from ${cli.port !== undefined ? '--port' : 'SYNAPSE_PORT'})`);
    }
    const handle = await runSse(ctx, port);
    console.error(`WrongSynapse SSE server listening on http://localhost:${port}/sse`);
    const demo = startDemo();
    activeDemo = demo;
    await new Promise<void>((resolvePromise) => {
      handle.server.on('close', resolvePromise);
    });
    // The SSE branch genuinely awaits server shutdown (the 'close' event
    // fires only after every connection ended), so closing the DB here is
    // safe. Null the globals first: a later signal would otherwise re-close them.
    await demo?.stop();
    activeDemo = null;
    if (web !== null) await web.close();
    activeWeb = null;
    activeDb = null;
    db.close();
  } else {
    await runStdio(ctx);
    activeDemo = startDemo();
  }
  // NOTE: no in-band db.close() for stdio. runStdio() resolves once the
  // transport is CONNECTED (SDK semantics — start() only attaches listeners),
  // not when the client disconnects, so closing here would pull the DB out
  // from under a live server. The DB lifecycle for server modes is owned by
  // the entry-point signal handlers (SIGINT/SIGTERM → shutdown() → activeDb.close()).
}

/** The live database for the CLI process (for signal-driven shutdown). */
let activeDb: SynapseDatabase | null = null;

/** The live admin web server for the CLI process (for signal-driven shutdown). */
let activeWeb: WebServerHandle | null = null;

/** The live demo feeder for the CLI process (for signal-driven shutdown). */
let activeDemo: DemoFeeder | null = null;

/** The in-progress teardown, if any (re-entry guard for stacked signals). */
let shutdownPromise: Promise<void> | null = null;

/** Stop the live demo feeder + web server + close the DB and exit (SIGINT/SIGTERM); installed only in the entry-point branch. */
function shutdown(): Promise<void> {
  // Re-entry guard: a second signal arriving while the first teardown is
  // still awaiting the in-flight demo tick must await the SAME teardown —
  // a parallel run would close the DB under the still-running tick.
  shutdownPromise ??= (async () => {
    try {
      await activeDemo?.stop();
    } catch {
      // best-effort stop on exit
    }
    try {
      void activeWeb?.close();
    } catch {
      // best-effort close on exit
    }
    try {
      activeDb?.close();
    } catch {
      // best-effort close on exit
    }
    process.exit(0);
  })();
  return shutdownPromise;
}

/**
 * Decide whether this module was executed as the CLI entry point (vs. imported
 * as a library). Branch order:
 *
 * 1. Real-path comparison of import.meta.url and process.argv[1] — primary.
 *    Handles npm's `.bin` symlink shims (both sides canonicalized), tsx-style
 *    loaders, and case-mismatched argv on Windows (paths are case-insensitive
 *    there but `===` is not).
 * 2. `import.meta.main` — fallback for launchers whose argv[1] is virtual or
 *    unresolvable (single-executable bundles, --import wrappers), where the
 *    realpath comparison throws but the module IS the entry.
 *
 * Side-effect-free by design: argv[1] belongs to the importing process, so a
 * resolution failure must NOT log to stderr (a host importing the library with
 * a virtual argv[1] would see a false CLI error).
 */
export function isMainEntryPoint(
  importMetaUrl: string,
  argv1: string | undefined,
  metaMain: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (argv1 !== undefined) {
    try {
      const normalize = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p);
      if (normalize(realpathSync(fileURLToPath(importMetaUrl))) === normalize(realpathSync(argv1))) return true;
    } catch {
      // argv[1] unresolvable — fall through to import.meta.main below.
    }
  }
  return metaMain === true;
}

const isEntryPoint = isMainEntryPoint(import.meta.url, process.argv[1], (import.meta as { main?: boolean }).main);

// Covered in-process by the entry-point lifecycle tests in src/index.test.ts
// (vi.resetModules + a controlled process.argv re-import).
if (isEntryPoint) {
  // Graceful Ctrl+C / SIGTERM: close the live web server + DB (if any) then exit.
  // These are installed ONLY in the entry-point branch so library imports of
  // main() never register process-level handlers.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Public library surface (programmatic use)
// ---------------------------------------------------------------------------

export { openDatabase } from './db/connection.js';
export type { SynapseDatabase, SynapseStatement, SqlValue } from './db/connection.js';
export { migrate, assertFts5, SCHEMA_VERSION } from './db/schema.js';
export * from './db/queries.js';
export { createEmbedder, getSharedEmbedder, DEFAULT_EMBEDDING_MODEL } from './engine/embedding.js';
export type { Embedder, EmbeddingOptions } from './engine/embedding.js';
export { DemoFeeder, createDemoRng, decideConsolidation, DEFAULT_DEMO_INTERVAL_MS, DEMO_PROMOTE_THRESHOLD } from './engine/demo.js';
export type { DemoFeederOptions, DemoScheduler } from './engine/demo.js';
export { hybridSearch } from './engine/hybrid-search.js';
export type { HybridQueryOptions, HybridResult, HybridSearchOutput } from './engine/hybrid-search.js';
export { indexWorkspace } from './engine/parser.js';
export type { IndexOptions, IndexResult } from './engine/parser.js';
export { GitService } from './engine/git.js';
export { createSynapseServer, runStdio, runSse, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export type { ToolContext, ToolDefinition, ToolResult } from './mcp/tools/index.js';
export { TOOL_DEFINITIONS } from './mcp/tools/definitions.js';
export { runWebServer, route as routeWeb } from './web/server.js';
export type { WebContext, WebResponse, WebServerHandle } from './web/server.js';
export * from './utils/scope.js';
