# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `prepublishOnly` guard in `package.json`: `npm publish` now runs
  typecheck + full test suite + build before packing, so a publish can never
  ship a stale or red `dist/`.

### Changed

- **Documentation**: README restructured (requirements, MCP client setup, CLI
  reference, programmatic usage, data model, development guide); CHANGELOG
  added.

## [0.1.0] — 2026-08-15

First public release. Local-first cognitive memory operating system + MCP
server: tri-hybrid retrieval (semantic + lexical + graph) over a unified
SQLite entity graph, fully offline.

[Tag v0.1.0](https://github.com/ersinkoc/WrongSynapse/releases/tag/v0.1.0) ·
[Full commit history](https://github.com/ersinkoc/WrongSynapse/commits/v0.1.0)

### Fixed

- Platform-dependent tests hardened so the suite is green on Linux CI as well
  as Windows dev machines: `SYNAPSE_MODEL_DIR` stubs use POSIX-absolute
  paths, and the CLI entry-point case-fold test is hermetic via a partial
  `realpathSync` mock.

### Added

- **Unified entity graph** (`src/db/`) — one SQLite store (WAL, FTS5,
  FK cascades) for projects, monorepo packages, directories, files, AST
  symbols, git commits, memory entries, and memory candidates, linked by
  `CONTAINS`, `CALLS`, `ANCHORED_TO`, and `INTRODUCED_BY_COMMIT` edges.
  Boundary-aware scope-prefix queries (sargable descendant matching) keep
  sibling scopes (`proj:app` vs `proj:app2`) from leaking into each other.
- **Scope URI grammar** (`src/utils/scope.ts`) — hierarchical addresses
  (`proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken`) with parse,
  build, and prefix-match helpers; scope values may contain `/`, kind/value
  separators are `:`, pair separators are `/`.
- **Workspace indexer** (`src/engine/parser.ts`) — gitignore-aware walker,
  monorepo package discovery, tree-sitter symbol extraction for TypeScript,
  JavaScript, Python, Go, and Rust with line/column metadata, call-graph
  edges, optional git history linking, stale-structure cleanup, and
  graceful embedding degradation.
- **Local embedding engine** (`src/engine/embedding.ts`) —
  `@huggingface/transformers` v4 singleton (`Xenova/all-MiniLM-L6-v2`,
  384-dim, mean-pooled, L2-normalized), remote fetching disabled by default
  (`SYNAPSE_ALLOW_REMOTE_MODEL=1` for a one-time bootstrap download).
- **Tri-hybrid retrieval** (`src/engine/hybrid-search.ts`) — FTS5/BM25
  lexical + cosine-similarity semantic + relational graph expansion, fused
  with Reciprocal Rank Fusion (k = 60), tunable per-channel weights, and a
  graceful fallback to lexical + graph when the model is unavailable.
- **Git integration** (`src/engine/git.ts`) — commit listing, per-commit
  changed files (root commits included via `--root`), and line-level blame
  through `simple-git`.
- **MCP server** (`src/mcp/`) — stdio and SSE transports, 8 tools:
  `synapse_index_workspace`, `synapse_hybrid_query`,
  `synapse_anchor_memory`, `synapse_graph_neighbors`,
  `synapse_record_observation`, `synapse_promote_candidate`,
  `synapse_list_candidates`, `synapse_discard_candidate`. Concurrent SSE
  sessions each get their own `McpServer` instance over one shared
  database.
- **Memory candidate lifecycle** — observations land in an episodic pool
  (`pending`); promote (with embedding + `ANCHORED_TO` scope link) or
  discard (terminal — a discarded candidate can never be promoted).
- **CLI** (`src/index.ts`) — `wrongsynapse` starts the stdio server by
  default; `--transport sse --port`, one-shot `--index <workspace> [--git]`
  printing JSON stats, `--db`/`--model-dir`/`--allow-remote-model` with
  `SYNAPSE_*` env fallbacks, SIGINT/SIGTERM clean shutdown; `--help` and
  `--version`.
- **Dual SQLite driver** — `better-sqlite3` primary with automatic
  `node:sqlite` fallback (Node >= 22.5) behind one synchronous interface.
- **Versioned schema migrations** — `PRAGMA user_version`-stamped, each
  migration transactional, with an FTS5 capability probe.
- **Quality gates** — 215 tests with 100% statement/branch/function/line
  coverage enforced in CI (Node 22 + 24 matrix), typecheck and build gates,
  and an `npm audit` (high/critical) gate.

[Unreleased]: https://github.com/ersinkoc/WrongSynapse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ersinkoc/WrongSynapse/releases/tag/v0.1.0
