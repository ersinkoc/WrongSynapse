# WrongSynapse

**Local-first Cognitive Memory Operating System + Model Context Protocol (MCP) server** for autonomous AI coding agents.

[![CI](https://github.com/ersinkoc/WrongSynapse/actions/workflows/ci.yml/badge.svg)](https://github.com/ersinkoc/WrongSynapse/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wrongsynapse)](https://www.npmjs.com/package/wrongsynapse)
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

## Optional admin web UI

When `wrongsynapse` starts, it also boots a single-page admin panel on a
kernel-assigned local port (different on every startup). The UI is built
with React 19 + Tailwind CSS v4 + Radix UI Themes 3 + React Flow 12,
uses a dark-pro design palette, and lives entirely in the same Node
process as the MCP server — no second port, no second process.

Three tabs cover the surface the MCP tools expose:

| Tab | What it shows |
|---|---|
| **Statistics** | Entity / relation / vector / candidate / FTS-row counts, plus a per-type breakdown of entities and relations |
| **Memory** | Searchable list of every `memory_entry` (filter by scope or free-text); click a row for the full detail panel (scope, name, content, metadata, anchored-to graph paths, confidence, updated timestamp); remove with a confirmation dialog |
| **Graph** | React Flow visualisation: every `memory_entry` plus the non-memory endpoints of every relation that touches one. Pan, zoom, fit-to-view. |

The UI is opt-out, not opt-in — it boots by default. Disable it with
`--no-web` or `SYNAPSE_WEB=0`. Bind to a specific port with
`--web-port <n>` or `SYNAPSE_WEB_PORT=<n>` (default: kernel-assigned free
port, so every startup uses a different port). Auto-open the browser
with `--web-open` or `SYNAPSE_WEB_OPEN=1` (best-effort; silently no-ops
on hosts without a default browser).

```bash
# Default behaviour — MCP + admin UI
wrongsynapse
# WrongSynapse admin web UI listening on http://127.0.0.1:50935

# Disable the web UI
wrongsynapse --no-web

# Pin the web UI to a specific port
wrongsynapse --web-port 9090
# WrongSynapse admin web UI listening on http://127.0.0.1:9090
```

The web server binds to `127.0.0.1` only and **never governs process
lifetime** (`httpServer.unref()`); a web-bind failure logs a warning and
the MCP server continues unaffected. Destructive operations (DELETE
`/api/memory/:id`) require an `Authorization: Bearer <token>` header
where the token is a random hex string printed next to the listen URL at
boot — read-only endpoints (stats, list, graph) are open.

The SPA is built separately from the Node bundle so the published npm
package stays lean. From a checkout:

```bash
npm run web:build      # one-shot: install web deps, typecheck, vite build → web/dist/
npm run web:dev        # dev server on :5173 with /api proxying to localhost:8765
npm run web:typecheck  # tsc -b --noEmit on the SPA only
```

`npm run web:install` runs `npm --prefix web install` for CI to pre-populate
`web/node_modules/` before the build step. The build artifact (`web/dist/`)
is git-ignored; the npm-published tarball contains only `dist/` (the Node
server bundle).

The web server's REST surface (used by the SPA and by anyone scripting
against the admin panel):

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/health` | `{ ok, version }` |
| `GET` | `/api/stats` | counts + type/relation breakdowns |
| `GET` | `/api/memory?scope=…&q=…&limit=…` | `{ count, memories[] }` |
| `GET` | `/api/memory/:id` | one memory + its anchored graph paths |
| `DELETE` | `/api/memory/:id` | `{ id, deleted: true }` (Bearer auth required) |
| `GET` | `/api/candidates?status=…&limit=…` | `{ count, candidates[] }` |
| `GET` | `/api/graph/memory?limit=…` | `{ nodes[], edges[] }` (React Flow shape) |

---

## Quickstart

```bash
# install the published package
npm install -g wrongsynapse

# one-time model download (after this everything runs offline),
# then index your workspace to populate ./synapse.db

# PowerShell
$env:SYNAPSE_ALLOW_REMOTE_MODEL = "1"
wrongsynapse --index .
Remove-Item Env:SYNAPSE_ALLOW_REMOTE_MODEL

# bash / zsh
SYNAPSE_ALLOW_REMOTE_MODEL=1 wrongsynapse --index .
unset SYNAPSE_ALLOW_REMOTE_MODEL

# start the MCP server (stdio by default)
wrongsynapse
```

Prefer not to install globally? `npx wrongsynapse --index .` works the same (the one-time model download is cached per machine), or build from source:

```bash
git clone https://github.com/ersinkoc/WrongSynapse.git
cd WrongSynapse && npm install && npm run build
node dist/index.js --index .   # same CLI, from the repo
```

The `--index .` run prints JSON stats (files scanned/parsed, symbols, relations, embeddings) and creates `./synapse.db`.

### Connecting an MCP client

WrongSynapse speaks the Model Context Protocol over stdio or SSE. Point any MCP client at the installed CLI:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wrongsynapse": {
      "command": "wrongsynapse",
      "env": { "SYNAPSE_DB_PATH": "D:/path/to/synapse.db" }
    }
  }
}
```

**Cursor / any stdio MCP client** — command `wrongsynapse` (installed globally or via `npx wrongsynapse`), then the eight `synapse_*` tools appear.

**SSE (remote / concurrent clients)**:

```bash
wrongsynapse --transport sse --port 8765
# endpoint: http://localhost:8765/sse
```

Each SSE connection gets its own MCP session — multiple agents can query one shared database concurrently.

### Install as an agent skill (skills.sh)

WrongSynapse ships a [skills.sh](https://www.skills.sh/)-compatible agent skill that automates the memory workflow (recall before work → observe during work → consolidate after). With any supported agent (Claude Code, Cursor, Codex, Copilot, and 20+ more):

```bash
npx skills add ersinkoc/WrongSynapse
```

This drops `skills/wrongsynapse/SKILL.md` into your agent's skill directory. The skill instructs the agent to use the eight `synapse_*` MCP tools — configure the MCP server as shown above (`command: wrongsynapse`) so both halves are connected. To use the skill straight from a checkout instead, copy `skills/wrongsynapse/SKILL.md` into your agent's skills folder.

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

## Demo mode

`--demo` (or `npm run demo`) continuously streams synthetic observations into memory and periodically consolidates them — promoting high-confidence keepers into permanent `memory_entry` entities (with embeddings and `ANCHORED_TO` graph edges) and discarding noise. It is the fastest way to watch the full memory lifecycle live in the admin web UI: candidates pile up in the pool, keepers get promoted, and the Graph tab grows real anchor edges.

```bash
npm run demo                              # 1 observation/second, seeded 42
npx wrongsynapse --demo --demo-interval 250 --demo-seed 7
SYNAPSE_DEMO=1 SYNAPSE_DEMO_INTERVAL=5000 wrongsynapse
```

- **Isolated by default** — demo mode writes to `./synapse-demo.db`, never your real `synapse.db` (pass `--db` to override deliberately).
- **Reproducible** — content, scope rotation, and confidence all derive from the seeded PRNG (`--demo-seed`); the same seed replays the same stream.
- **Namespaced** — every demo entity lives under `proj:demo/...`, so demo data can be swept with one scope-prefix delete and can never interleave with real project scopes.
- **Observes the MCP semantics** — the feeder mirrors `synapse_record_observation` → `synapse_promote_candidate` / `synapse_discard_candidate`, including graceful degradation when the embedding model is unavailable (promoted without a vector).

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
  DemoFeeder,                     // continuous synthetic ingestion (demo mode)
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

// DemoFeeder drives the same lifecycle programmatically (returns a Promise —
// await feeder.stop() before closing the DB; it waits out any in-flight tick).
const feeder = new DemoFeeder({ db, embedder, intervalMs: 1000, seed: 42 });
feeder.start();
// ... later:
await feeder.stop();
db.close();
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
