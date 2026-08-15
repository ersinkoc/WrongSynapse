# WrongSynapse

**Local-first Cognitive Memory Operating System + Model Context Protocol (MCP) server** for autonomous AI coding agents.

WrongSynapse is a zero-cloud memory layer that replaces a plain vector database with a **tri-hybrid** retrieval architecture:

1. **Semantic search** — local ONNX embeddings (`@huggingface/transformers` v4, model `Xenova/all-MiniLM-L6-v2`, 384-dim, mean-pooled, L2-normalized).
2. **Deterministic lexical search** — SQLite FTS5 full-text index with BM25 ranking.
3. **Hierarchical knowledge graph** — relational scopes linking projects, monorepo packages, directories, files, AST symbols, git commits, CLI tasks, and decisions.

The three retrieval paths are fused with **Reciprocal Rank Fusion (RRF, k=60)** into token-frugal, high-precision agent context.

Everything runs 100% locally on CPU (or local hardware acceleration). No cloud APIs, no telemetry.

---

## Features

- **Six MCP tools** over stdio (default) or SSE (`--transport sse`):
  | Tool | Purpose |
  |---|---|
  | `synapse_index_workspace` | Scan a workspace; parse structure + AST symbols (TS/JS/Py/Go/Rust via tree-sitter); embed; link git commits; persist. |
  | `synapse_hybrid_query` | Tri-hybrid RRF retrieval with scope/type filters and contextual graph paths. |
  | `synapse_anchor_memory` | Store a decision/note anchored to a symbol, file, package, or project scope (with embedding). |
  | `synapse_graph_neighbors` | Traverse the relational sub-graph (callers, commits, anchored memories, hierarchy). |
  | `synapse_record_observation` | Write an uncommitted insight into the episodic memory candidate pool. |
  | `synapse_promote_candidate` | Promote a candidate into a permanent memory entity with embedding + scope link. |
- **SQLite WAL** with `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, FTS5 auto-sync triggers.
- **Dual SQLite driver**: `better-sqlite3` primary, automatic `node:sqlite` fallback.
- **Strict TypeScript, ESM, zero `any`** (target ES2022, `strict` + `noUncheckedIndexedAccess`).
- **Zero cloud**: remote model fetching disabled by default; one-time bootstrap downloads the model into the local cache.

---

## Quickstart

```bash
# install
npm install
npm run build

# one-time model download (then everything runs offline)
$env:SYNAPSE_ALLOW_REMOTE_MODEL = "1"   # PowerShell
node dist/index.js --index .            # downloads the model, indexes this repo
Remove-Item Env:SYNAPSE_ALLOW_REMOTE_MODEL

# run as an MCP server over stdio
node dist/index.js

# or over SSE
node dist/index.js --transport sse --port 8765

# one-shot workspace index (no server)
node dist/index.js --index /path/to/workspace --git

# run the test suite
npm test
```

Point any MCP client (Claude Desktop, Cursor, custom agent) at the stdio command to expose the six `synapse_*` tools.

---

## Architecture

```
src/
├── index.ts                # CLI entry point & MCP server bootstrap (+ library exports)
├── db/
│   ├── connection.ts       # SQLite driver abstraction (better-sqlite3 → node:sqlite fallback), WAL pragmas
│   ├── schema.ts           # Versioned migrations (PRAGMA user_version), FTS5 probe
│   └── queries.ts          # Entities, graph traversal (BFS), FTS5/BM25, vector I/O, candidates
├── engine/
│   ├── embedding.ts        # transformers.js v4 singleton (all-MiniLM-L6-v2), offline env config
│   ├── vector-math.ts      # Cosine similarity, L2 normalization, mean pooling, BLOB (de)serialization
│   ├── parser.ts           # Tree-sitter workspace indexer: gitignore-aware walker, symbol extractor,
│   │                       #   package discovery, CONTAINS/CALLS/INTRODUCED_BY_COMMIT edges, embeddings
│   ├── git.ts              # simple-git wrapper: commits, per-commit diffs, blame
│   └── hybrid-search.ts    # Tri-hybrid retrieval + Reciprocal Rank Fusion (k=60)
├── mcp/
│   ├── server.ts           # McpServer bootstrap: stdio + SSE transports
│   └── tools/              # 6 MCP tool definitions + registration
└── utils/
    └── scope.ts            # Scope URI grammar: parse, build, prefix matching
```

### Scope URIs

Entities are addressed by hierarchical scope URIs:

```
proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken
proj:backend/file:src/auth/Token.ts          # prefix form (directory semantics)
proj:app/commit:9f2a3b1c…                     # git commits
```

`scope_path` prefixes filter retrieval (`proj:app/file:src/auth` matches everything under `src/auth`).

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SYNAPSE_DB_PATH` | SQLite database path | `./synapse.db` |
| `SYNAPSE_MODEL_DIR` | Directory with local model files (offline) | transformers cache |
| `SYNAPSE_EMBEDDING_MODEL` | Embedding model id | `Xenova/all-MiniLM-L6-v2` |
| `SYNAPSE_ALLOW_REMOTE_MODEL` | `1` to allow a **one-time** model download from the HF Hub | unset (offline) |

---

## Zero-cloud guarantee

- Model weights live in the local transformers cache (`node_modules/@huggingface/transformers/.cache` or `SYNAPSE_MODEL_DIR`).
- With `SYNAPSE_ALLOW_REMOTE_MODEL` unset, `env.allowRemoteModels=false` — the embedding engine refuses to fetch anything.
- If the model is missing, indexing/querying **degrades gracefully**: the structural + lexical index still works; semantic retrieval is skipped with a warning.

## Security notes

- `npm audit` is clean. `package.json` carries `overrides` (`protobufjs`, `sharp`, `adm-zip`) to patch transitive advisories from the ONNX runtime stack (`onnxruntime-web`/`onnxruntime-node`), which are required by `@huggingface/transformers` for local inference.

---

## License

MIT
