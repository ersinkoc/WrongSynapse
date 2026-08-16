# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Optional admin web UI** — a single-page admin panel for inspecting and
  pruning the memory database without going through the MCP tools. Built
  with React 19 + Tailwind CSS v4 + Radix UI Themes 3 + React Flow 12,
  served from the same Node process as the MCP server. Opt-out (boots by
  default; disable with `--no-web` or `SYNAPSE_WEB=0`).

  - Three tabs:
    - **Statistics** — counts (entities, relations, vectors, candidates,
      FTS rows) plus type/relation breakdowns.
    - **Memory** — searchable list of `memory_entry` rows with a detail
      panel; remove action with confirmation dialog.
    - **Graph** — React Flow visualisation of every `memory_entry` plus
      the non-memory endpoints of every relation that touches one (file
      neighbours, project anchors, etc.).
  - Boots by default at `wrongsynapse` startup with no flag required;
    disable with `--no-web` or `SYNAPSE_WEB=0`. The port is
    kernel-assigned on every startup (different port each run); pin it
    with `--web-port <n>` or `SYNAPSE_WEB_PORT=<n>`.
  - Optional browser auto-open (`--web-open` / `SYNAPSE_WEB_OPEN=1`) —
    best-effort, swallowed on hosts without a default browser (CI,
    headless server). Never blocks the main app.
  - Auth token gating for destructive operations (DELETE
    `/api/memory/:id`). The server generates a random token at boot,
    prints it next to the listen URL on stderr, and the SPA sends it
    as `Authorization: Bearer <token>`. Read-only endpoints remain open.
    Opt out by setting `ctx.authToken` to `undefined` (the CLI does not
    currently do this; the token is always enabled).
  - Built statically into `web/dist/` via `npm run web:build`. The
    npm-published tarball contains `dist/` (server) only; the SPA is
    built separately by anyone who wants the admin UI and served
    automatically when `web/dist/` exists next to `dist/`.
  - Main-app invariant preserved: the web server is unref'd and bound
    in the background; a bind failure logs to stderr and does not stop
    the MCP server (stdio or SSE) from running.

## [0.1.1] — 2026-08-16

Patch release: ship the agent skill and the global-install cache fix that
the 0.1.0 tarball lacks.

### Added

- **Agent skill** (`skills/wrongsynapse/SKILL.md`) — a
  [skills.sh](https://www.skills.sh/)-compatible skill that automates the
  memory workflow for coding agents (recall via `synapse_hybrid_query`
  before work, observations with `[domain-term]` tags during work,
  candidate consolidation at task end). Installable with
  `npx skills add ersinkoc/WrongSynapse`; the `skills/` directory now ships
  in the npm package.
- `prepublishOnly` guard in `package.json`: `npm publish` now runs
  typecheck + full test suite + build before packing, so a publish can never
  ship a stale or red `dist/`.
- `npm run release` / `npm run release:check` — interactive release script
  (pre-flight gates → publish with 2FA → registry verify → tag push) for
  maintainers.

### Fixed

- **Global-install model cache**: transformers.js roots its download cache
  (`env.cacheDir`) and local-model read path (`env.localModelPath`) inside
  `node_modules` of the package — for a global `npm i -g wrongsynapse`
  install that is the global install tree, so every reinstall re-downloaded
  the embedding model. Both knobs now default to
  `~/.cache/wrongsynapse` (HOME/USERPROFILE; `./.cache` fallback);
  `SYNAPSE_MODEL_DIR` still overrides both.

### Changed

- **Documentation**: README now leads with the published-package workflow
  (`npm install -g wrongsynapse`, real npm badge, MCP configs using the
  installed CLI, skills.sh install section).

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

[Unreleased]: https://github.com/ersinkoc/WrongSynapse/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ersinkoc/WrongSynapse/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ersinkoc/WrongSynapse/releases/tag/v0.1.0
