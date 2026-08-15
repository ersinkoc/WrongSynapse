#!/usr/bin/env node
/**
 * WrongSynapse — local-first Cognitive Memory Operating System + MCP server.
 *
 * CLI usage:
 *   wrongsynapse                          # stdio MCP server (default)
 *   wrongsynapse --transport sse --port 8765
 *   wrongsynapse --index <workspace> [--git]
 *   wrongsynapse --db <path>              # override DB location (env: SYNAPSE_DB_PATH)
 *   wrongsynapse --model-dir <dir>        # local model files (env: SYNAPSE_MODEL_DIR)
 *   wrongsynapse --allow-remote-model     # one-time model download (env: SYNAPSE_ALLOW_REMOTE_MODEL=1)
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { openDatabase, type SynapseDatabase } from './db/connection.js';
import { assertFts5, migrate } from './db/schema.js';
import { dbStats } from './db/queries.js';
import { getSharedEmbedder } from './engine/embedding.js';
import { indexWorkspace } from './engine/parser.js';
import { runSse, runStdio, SERVER_VERSION } from './mcp/server.js';
import { TOOL_DEFINITIONS } from './mcp/tools/definitions.js';

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
}

function printHelp(): void {
  console.log(`WrongSynapse v${SERVER_VERSION} — local-first cognitive memory + MCP server

USAGE
  wrongsynapse [options]

OPTIONS
  --transport <stdio|sse>   MCP transport (default: stdio)
  --port <number>           SSE HTTP port (default: 8765)
  --db <path>               SQLite database path (default: ./synapse.db, env SYNAPSE_DB_PATH)
  --model-dir <dir>         Local embedding model directory (env SYNAPSE_MODEL_DIR)
  --allow-remote-model      Allow one-time model download from the HF Hub (env SYNAPSE_ALLOW_REMOTE_MODEL=1)
  --index <workspace>       One-shot: index a workspace and exit (JSON stats)
  --git                     With --index: also link git commit history
  -h, --help                Show this help
  -v, --version             Show version

ENVIRONMENT
  SYNAPSE_DB_PATH           Database path (default ./synapse.db)
  SYNAPSE_MODEL_DIR         Local model directory (offline inference)
  SYNAPSE_EMBEDDING_MODEL   Override embedding model id (default Xenova/all-MiniLM-L6-v2)
  SYNAPSE_ALLOW_REMOTE_MODEL  Set to 1 to allow a one-time model download (then go offline)

MCP TOOLS
${TOOL_DEFINITIONS.map((t) => `  ${t.name} — ${t.description.split('.')[0]}.`).join('\n')}
`);
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

  // Flag > env > default resolution keeps every arm observable (parseArgs
  // defaults would collapse the env fallback into an untestable constant).
  const db = await openDatabase(cli.db ?? process.env['SYNAPSE_DB_PATH'] ?? './synapse.db');
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

  if (cli.transport === 'sse') {
    const portRaw = cli.port ?? process.env['SYNAPSE_PORT'] ?? '8765';
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`invalid port '${portRaw}' (from ${cli.port !== undefined ? '--port' : 'SYNAPSE_PORT'})`);
    }
    const handle = await runSse(ctx, port);
    console.error(`WrongSynapse SSE server listening on http://localhost:${port}/sse`);
    await new Promise<void>((resolvePromise) => {
      handle.server.on('close', resolvePromise);
    });
  } else {
    await runStdio(ctx);
  }
}

/** The live database for the CLI process (for signal-driven shutdown). */
let activeDb: SynapseDatabase | null = null;

/** Close the live DB and exit (SIGINT/SIGTERM); installed only in the entry-point branch. */
function shutdown(): void {
  try {
    activeDb?.close();
  } catch {
    // best-effort close on exit
  }
  process.exit(0);
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
  // Graceful Ctrl+C / SIGTERM: close the live DB (if any) then exit. These are
  // installed ONLY in the entry-point branch so library imports of main() never
  // register process-level handlers.
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
export { hybridSearch } from './engine/hybrid-search.js';
export type { HybridQueryOptions, HybridResult, HybridSearchOutput } from './engine/hybrid-search.js';
export { indexWorkspace } from './engine/parser.js';
export type { IndexOptions, IndexResult } from './engine/parser.js';
export { GitService } from './engine/git.js';
export { createSynapseServer, runStdio, runSse, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export type { ToolContext, ToolDefinition, ToolResult } from './mcp/tools/index.js';
export { TOOL_DEFINITIONS } from './mcp/tools/definitions.js';
export * from './utils/scope.js';
