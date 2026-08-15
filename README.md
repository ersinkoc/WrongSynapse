# WrongSynapse

**Local-first Cognitive Memory Operating System + Model Context Protocol (MCP) server** for autonomous AI coding agents.

[![CI](https://github.com/ersinkoc/WrongSynapse/actions/workflows/ci.yml/badge.svg)](https://github.com/ersinkoc/WrongSynapse/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.1.0-007EC6)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-007EC6)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](package.json)

WrongSynapse is a zero-cloud memory layer that replaces a plain vector database with **tri-hybrid retrieval**:

1. **Semantic** — local ONNX embeddings (`@huggingface/transformers` v4, `Xenova/all-MiniLM-L6-v2`, 384-dim, mean-pooled, L2-normalized).
2. **Lexical** — SQLite FTS5 full-text index with BM25 ranking.
3. **Structural** — a hierarchical knowledge graph linking projects, monorepo packages, directories, files, AST symbols, git commits, and memories.

The three channels are fused with **Reciprocal Rank Fusion (RRF, k = 60)** into high-precision agent context. Everything runs 100% locally. No cloud APIs, no telemetry.

---

## Requirements

| | |
|---|---|
| **Node.js** | ≥ 22 (22 and 24 tested in CI; `node:sqlite` fallback needs ≥ 22.5) |
| **OS** | Windows, Linux, macOS (CI: `ubuntu-latest`; dev-verified on Windows) |
| **Disk** | ≈ 25 MB for the embedding model (q8 ONNX, one-time download), then offline |
| **git** | optional — only for `--git` history linking |

## Quickstart

```bash
git clone https://github.com/ersinkoc/WrongSynapse.git
cd WrongSynapse
npm install
npm run build

# one-time model download (after this everything runs offline)
# then index this repo to populate ./synapse.db

# PowerShell
$env:SYNAPSE_ALLOW_REMOTE_MODEL = "1"
node dist/index.js --index .
Remove-Item Env:SYNAPSE_ALLOW_REMOTE_MODEL

# bash / zsh
SYNAPSE_ALLOW_REMOTE_MODEL=1 node dist/index.js --index .
unset SYNAPSE_ALLOW_REMOTE_MODEL

# start the MCP server (stdio by default)
node dist/index.js
```

The `--index .` run prints JSON stats (files scanned/parsed, symbols, relations, embeddings) and creates `./synapse.db`.

### Connecting an MCP client

WrongSynapse speaks the Model Context Protocol over stdio or SSE. Point any MCP client at the built entry point:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wrongsynapse": {
      "command": "node",
      "args": ["D:/path/to/WrongSynapse/dist/index.js"],
      "env": { "SYNAPSE_DB_PATH": "D:/path/to/synapse.db" }
    }
  }
}
```

**Cursor / any stdio MCP client** — command `node dist/index.js` in the repo (or a global install), then the eight `synapse_*` tools appear.

**SSE (remote / concurrent clients)**:

```bash
node dist/index.js --transport sse --port 8765
# endpoint: http://localhost:8765/sse
```

Each SSE connection gets its own MCP session — multiple agents can query one shared database concurrently.

---

## The eight MCP tools

| Tool | Purpose |
|---|---|
| `synapse_index_workspace` | Scan a workspace; parse structure + AST symbols (TS/JS/Py/Go/Rust via tree-sitter); embed; optionally link git commits; persist the hierarchy. |
| `synapse_hybrid_query` | Tri-hybrid RRF retrieval with scope/type filters, per-channel weight tuning (`vector`/`lexical`/`graph`, `graph_depth`), and contextual graph paths. |
| `synapse_anchor_memory` | Store a decision/convention note anchored to a symbol, file, package, or project scope (with embedding + `ANCHORED_TO` edge). |
| `synapse_graph_neighbors` | Traverse the relational sub-graph (callers/callees, anchored memories, hierarchy, commits); accepts an entity id **or** an exact scope path. |
| `synapse_record_observation` | Write an uncommitted insight into the episodic candidate pool (does not touch the graph yet). |
| `synapse_promote_candidate` | Promote a pending candidate into a permanent memory entity: embedding computed, `ANCHORED_TO` link created. |
| `synapse_list_candidates` | List the candidate pool, filterable by lifecycle status (`pending` / `promoted` / `discarded`). |
| `synapse_discard_candidate` | Discard a pending candidate — **terminal**: a discarded candidate can never be promoted. |

### Memory lifecycle

```
        synapse_record_observation
                   │
                   ▼
             [ pending ] ──── synapse_discard_candidate ──▶ [ discarded ]  (terminal)
                   │
     synapse_promote_candidate
                   │
                   ▼
            [ memory_entry ]  (embedded + anchored to a scope)
```

The candidate pool is the write buffer for episodic memory: observations accumulate cheaply, then an agent (or human) promotes the keepers and discards noise.

---

## CLI reference

```
wrongsynapse [options]

  --transport <stdio|sse>   MCP transport (default: stdio)
  --port <number>           SSE HTTP port (default: 8765, env SYNAPSE_PORT)
  --db <path>               SQLite database path (default ./synapse.db, env SYNAPSE_DB_PATH)
  --model-dir <dir>         Local embedding model directory (env SYNAPSE_MODEL_DIR)
  --allow-remote-model      Allow one-time model download from the HF Hub (env SYNAPSE_ALLOW_REMOTE_MODEL=1)
  --index <workspace>       One-shot: index a workspace and exit (prints JSON stats)
  --git                     With --index: also link git commit history
  -h, --help                Show help
  -v, --version             Show version
```

The database is closed cleanly on SIGINT/SIGTERM (server modes) and immediately after a one-shot `--index`.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SYNAPSE_DB_PATH` | SQLite database path | `./synapse.db` |
| `SYNAPSE_MODEL_DIR` | Directory with local model files (offline inference) | transformers cache |
| `SYNAPSE_EMBEDDING_MODEL` | Embedding model id | `Xenova/all-MiniLM-L6-v2` |
| `SYNAPSE_ALLOW_REMOTE_MODEL` | `1` to allow a **one-time** model download from the HF Hub | unset (offline) |
| `SYNAPSE_PORT` | SSE HTTP port when `--port` is absent | `8765` |

---

## Scope URIs

Every entity is addressed by a hierarchical scope URI:

```
proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken
proj:backend/file:src/auth/Token.ts           # file values may contain '/'
proj:app/commit:9f2a3b1c…                      # git commits
```

- Pair separator is `/`; kind/value separator is `:`.
- Prefixes filter retrieval: `scopes: ["proj:app/file:src/auth"]` matches that file and everything below it.
- Prefix matching is **boundary-aware**: `proj:app` matches `proj:app/…` but never the sibling `proj:app2/…` (enforced in SQL, index-friendly).

## Data model

| Table | Holds |
|---|---|
| `entities` | The unified node store: `project`, `package`, `directory`, `file`, `symbol`, `commit`, `memory_entry` (+ candidates in their own table). Scope path, name, content, JSON metadata, confidence. |
| `relations` | Graph edges: `CONTAINS`, `CALLS`, `ANCHORED_TO`, `INTRODUCED_BY_COMMIT` (unique per source/target/relation, FK-cascaded). |
| `entities_fts` | FTS5 external-content index over name/content/scope_path, auto-synced by triggers. |
| `entity_vectors` | One Float32 embedding BLOB per entity (384-dim), FK-cascaded. |
| `memory_candidates` | The episodic pool: content, scope, source, confidence, lifecycle status. |

Schema migrations are versioned (`PRAGMA user_version`) and transactional; an FTS5 capability probe runs at boot.

## Programmatic usage

The package doubles as a library (ESM, full type declarations):

```ts
import {
  openDatabase, migrate,          // SQLite bootstrap (better-sqlite3 → node:sqlite fallback)
  insertEntity, insertRelation,   // graph writes
  insertCandidate, listCandidates, // episodic pool
  createEmbedder,                 // local embedding engine
  hybridSearch,                   // tri-hybrid RRF retrieval
  parseScope, scopeMatchesAnyPrefix, // scope URI helpers
  dbStats,
} from 'wrongsynapse';

const db = await openDatabase('./synapse.db');
migrate(db);
const embedder = createEmbedder(); // loads the model lazily on first use

const candidateId = insertCandidate(db, {
  content: 'AuthService caches tokens for 5 minutes',
  scopePath: 'proj:app/file:src/auth.ts',
  confidence: 0.85,
});

const { results } = await hybridSearch(db, embedder, {
  query: 'token caching',
  scopes: ['proj:app/file:src'],
  limit: 5,
});
```

## Development

```bash
npm run typecheck     # strict tsc, zero errors
npm test              # 215 tests
npm run test:coverage # 100% statement/branch/function/line gate (enforced in CI)
npm run build         # tsc -> dist/ (ESM + .d.ts)
npm publish --dry-run # prepublishOnly guard runs typecheck + test + build first
```

CI (`.github/workflows/ci.yml`) runs the full matrix on push/PR: Node 22 + 24, typecheck, tests with the 100% coverage gate, build, and `npm audit` (fails on high/critical).

### Project layout

```
src/
├── index.ts                # CLI entry point & MCP server bootstrap (+ library exports)
├── db/
│   ├── connection.ts       # SQLite driver abstraction (better-sqlite3 → node:sqlite), WAL pragmas
│   ├── schema.ts           # Versioned migrations (PRAGMA user_version), FTS5 probe
│   └── queries.ts          # Entities, graph traversal (BFS), FTS5/BM25, vector I/O, candidates
├── engine/
│   ├── embedding.ts        # transformers.js v4 singleton (all-MiniLM-L6-v2), offline env config
│   ├── vector-math.ts      # Cosine similarity, L2 normalization, mean pooling, BLOB (de)serialization
│   ├── parser.ts           # Tree-sitter workspace indexer: gitignore-aware walker, symbols, edges, embeddings
│   ├── git.ts              # simple-git wrapper: commits, per-commit diffs, blame
│   └── hybrid-search.ts    # Tri-hybrid retrieval + Reciprocal Rank Fusion (k = 60)
├── mcp/
│   ├── server.ts           # McpServer bootstrap: stdio + SSE transports (concurrent SSE sessions)
│   └── tools/              # 8 MCP tool definitions + registration
└── utils/
    └── scope.ts            # Scope URI grammar: parse, build, boundary-aware prefix matching
```

## Zero-cloud guarantee

- Model weights live in the local transformers cache or `SYNAPSE_MODEL_DIR`.
- With `SYNAPSE_ALLOW_REMOTE_MODEL` unset, remote fetching is refused at the transformers.js env level.
- If the model is missing, indexing and querying **degrade gracefully**: structural + lexical retrieval keep working; semantic retrieval is skipped with a warning.

## Security notes

- `npm audit` is clean at the high/critical level (CI-enforced).
- `package.json` carries `overrides` (`protobufjs`, `sharp`, `adm-zip`) pinning patched versions of transitive dependencies from the ONNX runtime stack required by `@huggingface/transformers`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Ersin KOÇ
