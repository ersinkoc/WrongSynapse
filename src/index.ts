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

import { parseArgs } from 'node:util';

import { openDatabase } from './db/connection.js';
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: 'string', default: 'stdio' },
      port: { type: 'string', default: '8765' },
      db: { type: 'string', default: process.env['SYNAPSE_DB_PATH'] ?? './synapse.db' },
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

  const db = await openDatabase(cli.db ?? './synapse.db');
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

  const shutdown = (): void => {
    try {
      db.close();
    } catch {
      // best-effort close on exit
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (cli.transport === 'sse') {
    const port = Number(cli.port ?? '8765');
    if (!Number.isFinite(port) || port <= 0) throw new Error(`invalid --port '${cli.port}'`);
    const handle = await runSse(ctx, port);
    console.error(`WrongSynapse SSE server listening on http://localhost:${port}/sse`);
    await new Promise<void>((resolvePromise) => {
      handle.server.on('close', resolvePromise);
    });
  } else {
    await runStdio(ctx);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

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
