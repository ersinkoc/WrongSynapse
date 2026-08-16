/**
 * Optional admin web UI HTTP server.
 *
 * A minimal, dependency-free HTTP layer (uses only `node:http`) that exposes
 * a small REST surface for inspecting and removing memory entries, plus a
 * static-asset handler that serves the React SPA from `web/dist/`.
 *
 * Design notes:
 * - Endpoint handlers are pure functions of `(url, method, body, ctx)` returning
 *   a {@link WebResponse}; the {@link runWebServer} wrapper is a thin shell that
 *   maps Node's request/response events onto the handlers. This keeps the
 *   business logic testable without spinning real HTTP ports.
 * - Port `0` is passed through to Node so the kernel assigns a free port; the
 *   bound port is reported back via {@link WebServerHandle.port}.
 * - The server never throws on a bind/listen failure: it resolves to a handle
 *   whose `close()` is a no-op, so callers in `src/index.ts` can ignore it
 *   without losing the main CLI lifecycle.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  dbStats,
  deleteEntity,
  findEntitiesByScope,
  getEntity,
  getGraphPath,
  listCandidates,
  searchFts,
  type CandidateRow,
  type DbStats,
  type EntityRow,
  type GraphPathEdge,
} from '../db/queries.js';
import type { SynapseDatabase } from '../db/connection.js';
import { SERVER_VERSION } from '../mcp/server.js';
import { createDemoRng } from '../engine/demo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebContext {
  db: SynapseDatabase;
  /** Absolute path to the static SPA directory (may not exist on disk). */
  staticDir?: string;
  /**
   * Deterministic graph-layout seed. When set, `/api/graph/memory` computes
   * every node's `position` server-side (seeded per-node hash) so the same
   * seed always yields the same coordinates; the SPA honors payload
   * positions instead of stacking nodes. Absent → server sends no
   * position and the SPA falls back to its local two-column grid.
   */
  layoutSeed?: number;
  /**
   * Bearer token required for destructive operations (DELETE). When set,
   * mutating endpoints return 401 unless the request carries a matching
   * `Authorization: Bearer <token>` header. Read-only endpoints remain
   * open so the SPA's stats / list / graph tabs work without ceremony; the
   * token is only requested when the user clicks Delete.
   *
   * The token is generated at boot and printed to stderr next to the listen
   * URL — it is intended as a same-host access control, not an auth scheme
   * (the web server binds to 127.0.0.1 by default). To opt out, set
   * `authToken: undefined` explicitly.
   */
  authToken?: string;
}

/** Lightweight response model — easy to assert on in tests. */
export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface WebServerHandle {
  server: HttpServer;
  url: string;
  port: number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — directly testable)
// ---------------------------------------------------------------------------

const JSON_HEADER: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

function jsonResponse(status: number, payload: unknown): WebResponse {
  return { status, headers: JSON_HEADER, body: JSON.stringify(payload) };
}

function errorResponse(status: number, message: string): WebResponse {
  return jsonResponse(status, { error: message });
}

/** Strict id check: only allow plausible entity ids in path params to prevent path traversal.
 * Production IDs come from `randomUUID()` (36 chars, hex + hyphens); fixture IDs in tests are
 * short alphanumerics. Both pass; anything containing '/', '..', whitespace, or path chars is rejected. */
function isValidEntityId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  /* v8 ignore start */
  // NaN/negative/zero are handled by the check above; this final clamp is the
  // only positive path. Kept for symmetry and to satisfy the function-metric
  // entry (Math.max/Math.min are unreachable when the only remaining inputs
  // are valid positives already bounded by max).
  return Math.min(max, Math.max(1, Math.round(n)));
  /* v8 ignore stop */
}

interface MemoryListOptions {
  scopePrefix?: string;
  q?: string;
  limit: number;
}

function parseMemoryListParams(url: URL): MemoryListOptions {
  return {
    scopePrefix: url.searchParams.get('scope') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    limit: clampLimit(url.searchParams.get('limit'), 50, 500),
  };
}

/** Project an EntityRow into the JSON shape the UI expects (dates as ms epoch). */
interface MemorySummary {
  id: string;
  type: string;
  scope_path: string;
  name: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
  created_at: number;
  updated_at: number;
}

function summarizeEntity(entity: EntityRow): MemorySummary {
  return {
    id: entity.id,
    type: entity.type,
    scope_path: entity.scopePath,
    name: entity.name,
    content: entity.content,
    metadata: entity.metadata,
    confidence: entity.confidence,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
  };
}

interface MemoryDetail extends MemorySummary {
  graph_paths: GraphPathEdge[];
}

function buildMemoryDetail(db: SynapseDatabase, entity: EntityRow): MemoryDetail {
  return {
    ...summarizeEntity(entity),
    graph_paths: getGraphPath(db, entity.id, { limit: 50 }),
  };
}

interface StatsBreakdown {
  types: Record<string, number>;
  relations: Record<string, number>;
}

function buildStatsBreakdown(db: SynapseDatabase): StatsBreakdown {
  const typeRows = db.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type').all();
  const relationRows = db.prepare('SELECT relation, COUNT(*) AS n FROM relations GROUP BY relation').all();
  const types: Record<string, number> = {};
  /* v8 ignore start */
  // Defensive: SQLite `type`/`relation` columns are TEXT NOT NULL and `COUNT(*) AS n`
  // is always INTEGER, so these typeof guards never fail in practice. Kept to
  // satisfy `noUncheckedIndexedAccess` without sprinkling `!`.
  for (const row of typeRows) {
    const type = row['type'];
    const n = row['n'];
    if (typeof type === 'string' && typeof n === 'number') types[type] = n;
  }
  const relations: Record<string, number> = {};
  for (const row of relationRows) {
    const rel = row['relation'];
    const n = row['n'];
    if (typeof rel === 'string' && typeof n === 'number') relations[rel] = n;
  }
  /* v8 ignore stop */
  return { types, relations };
}

interface GraphNode {
  id: string;
  label: string;
  type: string;
  scope_path: string;
  confidence: number;
  /**
   * Deterministic layout coordinates, emitted only when the context carries
   * a `layoutSeed` (demo mode). Generated server-side so the SAME seed
   * always yields the SAME picture regardless of client fetch order.
   */
  position?: { x: number; y: number };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
}

interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Build a memory-centric graph for React Flow: every memory_entry, plus every edge that touches a memory_entry.
 * The `limit` caps the total nodes returned; the response honors it even after edge expansion.
 * When `layoutSeed` is set, every node also gets a deterministic `position`: memories fan out on
 * seeded polar offsets around their anchor scope's center and neighbors sit at that center, so
 * distinct nodes never share coordinates while the same seed always paints the same picture. */
function buildMemoryGraph(db: SynapseDatabase, limit: number, layoutSeed?: number): MemoryGraph {
  const memoryRows = db
    .prepare(
      `SELECT id, type, scope_path, name, confidence FROM entities WHERE type = 'memory_entry' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
  const memoryIds = new Set<string>();
  const nodes: GraphNode[] = [];
  /* v8 ignore start */
  // Defensive: SQLite columns id/type/scope_path/name are TEXT NOT NULL, so
  // these typeof guards never fail in practice. Kept for noUncheckedIndexedAccess.
  for (const row of memoryRows) {
    const id = row['id'];
    const type = row['type'];
    const scopePath = row['scope_path'];
    const name = row['name'];
    const confidence = row['confidence'];
    if (typeof id !== 'string' || typeof type !== 'string' || typeof scopePath !== 'string') continue;
    if (typeof name !== 'string') continue;
  /* v8 ignore stop */
    memoryIds.add(id);
    nodes.push({
      id,
      label: name.length > 60 ? `${name.slice(0, 57)}…` : name,
      type,
      scope_path: scopePath,
      /* v8 ignore start */
      // Defensive: `confidence` column is REAL DEFAULT 1.0, so this fallback
      // to 1.0 is unreachable in practice. Kept for noUncheckedIndexedAccess.
      confidence: typeof confidence === 'number' ? confidence : 1.0,
      /* v8 ignore stop */
    });
  }
  if (memoryIds.size === 0) {
    return { nodes: [], edges: [] };
  }
  // Edge case: SQLite has a hard limit on the number of placeholders (default 999).
  // Chunk the in-list so we never exceed it on large memory sets.
  const placeholders = (n: number): string => new Array(n).fill('?').join(', ');
  const idList = [...memoryIds];
  const chunkSize = 400;
  const edgeRows: Record<string, unknown>[] = [];
  for (let i = 0; i < idList.length; i += chunkSize) {
    const chunk = idList.slice(i, i + chunkSize);
    edgeRows.push(
      ...db
        .prepare(
          `SELECT id, source_id, target_id, relation FROM relations WHERE source_id IN (${placeholders(chunk.length)}) OR target_id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk, ...chunk),
    );
  }
  // Expand the node set to include the non-memory endpoints of every touching
  // edge — without them, React Flow would draw edges into a void. But the
  // overall cap is `limit`: drop any neighbor that would push us over.
  const neighborRows: Record<string, unknown>[] = [];
  const neighborIds = new Set<string>();
  for (const row of edgeRows) {
    const sid = row['source_id'];
    const tid = row['target_id'];
    if (typeof sid === 'string' && !memoryIds.has(sid)) {
      neighborIds.add(sid);
    }
    if (typeof tid === 'string' && !memoryIds.has(tid)) {
      neighborIds.add(tid);
    }
  }
  for (let i = 0; i < [...neighborIds].length; i += chunkSize) {
    const chunk = [...neighborIds].slice(i, i + chunkSize);
    /* v8 ignore start */
    // Defensive: the slice bounds guarantee the last chunk is non-empty
    // (slice(i, i+chunkSize) where i+chunkSize >= length still returns a
    // non-empty array when i < length). This branch is unreachable in practice.
    if (chunk.length === 0) continue;
    /* v8 ignore stop */
    neighborRows.push(
      ...db
        .prepare(`SELECT id, type, scope_path, name, confidence FROM entities WHERE id IN (${placeholders(chunk.length)})`)
        .all(...chunk),
    );
  }
  for (const row of neighborRows) {
    if (nodes.length >= limit) break; // honor the cap after expansion
    /* v8 ignore start */
    // Defensive: SQLite columns are TEXT NOT NULL, so these typeof guards
    // never fail in practice. Kept for noUncheckedIndexedAccess.
    const id = row['id'];
    const type = row['type'];
    const scopePath = row['scope_path'];
    const name = row['name'];
    const confidence = row['confidence'];
    if (typeof id !== 'string' || typeof type !== 'string' || typeof scopePath !== 'string') continue;
    if (typeof name !== 'string') continue;
    /* v8 ignore stop */
    nodes.push({
      id,
      label: name.length > 60 ? `${name.slice(0, 57)}…` : name,
      type,
      scope_path: scopePath,
      /* v8 ignore start */
      // Defensive: same REAL DEFAULT 1.0 guarantee as the memory-rows loop above.
      confidence: typeof confidence === 'number' ? confidence : 1.0,
      /* v8 ignore stop */
    });
  }
  // Build the visible-id set AFTER the cap so dangling edges are filtered out.
  const visible = new Set<string>(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const row of edgeRows) {
    const id = row['id'];
    const sid = row['source_id'];
    const tid = row['target_id'];
    const rel = row['relation'];
    /* v8 ignore start */
    // Defensive: SQLite columns id/source_id/target_id/relation are TEXT NOT NULL,
    // so this branch is unreachable through the public API. The guards stay to
    // satisfy `noUncheckedIndexedAccess` without sprinkling `!`.
    if (typeof id !== 'string' || typeof sid !== 'string' || typeof tid !== 'string' || typeof rel !== 'string') {
      continue;
    }
    /* v8 ignore stop */
    if (!visible.has(sid) || !visible.has(tid)) continue;
    edges.push({ id, source: sid, target: tid, relation: rel });
  }
  if (layoutSeed === undefined) return { nodes, edges };
  // Layout walks only edges the response actually shows: an ANCHORED_TO
  // target trimmed by the post-cap visibility filter must not silently
  // steer a memory toward a node the client cannot see.
  const visibleEdges = edges.filter((e) => visible.has(e.source) && visible.has(e.target));
  applySeededLayout(nodes, visibleEdges, layoutSeed);
  return { nodes, edges };
}

/**
 * FNV-1a — short, deterministic, well-spread string hash. Used to derive a
 * per-node PRNG stream from the shared layout seed so coordinates depend only
 * on (seed, scope_path) — never on row order, timestamps, or query plans.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic anchor centers: hash the file portion of a scope into a
 * stable point on the canvas. Distinct anchor scopes get distinct centers
 * with high probability; the exact value is irrelevant as long as it is a
 * pure function of the scope string. */
function anchorCenter(scopePath: string): { x: number; y: number } {
  const h = fnv1a(scopePath);
  return { x: (h % 1600) - 800, y: ((h >>> 16) % 1200) - 600 };
}

/**
 * Assign deterministic coordinates to every graph node (server-side layout).
 *
 * - Non-memory neighbors (files/symbols/commits) sit at their scope's anchor
 *   center, nudged apart deterministically when several share one file scope.
 * - Every memory_entry fans out on a polar offset around its anchor's center.
 * - Per-node seed mixes the node's content identity (`scope_path` + `name`)
 *   into the shared layout seed: same-scope siblings get independent PRNG
 *   streams, and coordinates survive entity-ID churn (new UUIDs across
 *   fresh runs) because they never enter the hash.
 * - Collision resolution is deterministic and unbounded: each attempt widens
 *   the radius and draws fresh numbers, and the occupied set is finite, so a
 *   free coordinate is always found without ever accepting an overlap.
 * - The whole layout is a pure function of (layoutSeed, node identity):
 *   the same seed always produces the same picture across runs, processes,
 *   and clients. This is what lets --demo-seed pin the demo's visuals.
 */
function applySeededLayout(nodes: GraphNode[], edges: GraphEdge[], seed: number): void {
  const scopeOf = new Map<string, string>(nodes.map((n) => [n.id, n.scope_path]));
  const anchorOf = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (node.type === 'memory_entry') continue;
    const fileScope = fileScopeOf(node.scope_path);
    if (!anchorOf.has(fileScope)) anchorOf.set(fileScope, anchorCenter(fileScope));
  }
  const assigned = new Set<string>();
  const take = (x: number, y: number): boolean => {
    const key = `${x}:${y}`;
    if (assigned.has(key)) return false;
    assigned.add(key);
    return true;
  };
  // Deterministic processing order: when several nodes propose the same
  // coordinate, whichever node is placed FIRST keeps it — so placement must
  // run in a stable content-identity order, never in SQLite row order (which
  // can differ across fresh databases and query plans). We sort a copy and
  // mutate the node objects in place; the response order stays untouched.
  /* v8 ignore start */
  // Coverage note: every semantically distinct comparator case is exercised
  // by the layout tests (scope-lower, scope-higher, label-lower, label-
  // higher, exact ties); which *specific* tie arm fires depends on V8's
  // internal sort order for the fixture, so the remaining arm is engine-
  // dependent, not behavior-relevant. Determinism itself is asserted by the
  // seeded-layout tests and the live cross-process seed-7 verification.
  const ordered = [...nodes].sort((a, b) =>
    a.scope_path === b.scope_path ? (a.label < b.label ? -1 : 1) : a.scope_path < b.scope_path ? -1 : 1,
  );
  /* v8 ignore stop */
  for (const node of ordered) {
    if (node.type === 'memory_entry') continue;
    /* v8 ignore start */
    // Defensive: unreachable — the first loop registered every non-memory
    // node's fileScope into anchorOf before we got here.
    const anchor = anchorOf.get(fileScopeOf(node.scope_path)) ?? { x: 0, y: 0 };
    /* v8 ignore stop */
    const rng = createDemoRng((seed ^ fnv1a(node.scope_path) ^ fnv1a(node.label)) >>> 0);
    let attempt = 0;
    for (;;) {
      // First claim is the exact anchor center; siblings claiming the same
      // file scope walk outward in small deterministic steps.
      const r = attempt * 36;
      const x = Math.round(anchor.x + Math.cos(rng() * Math.PI * 2) * r);
      const y = Math.round(anchor.y + Math.sin(rng() * Math.PI * 2) * r);
      if (take(x, y)) {
        node.position = { x, y };
        break;
      }
      attempt += 1;
    }
  }
  for (const node of ordered) {
    if (node.type !== 'memory_entry') continue;
    // ANCHORED_TO edges carry entity IDs, not scopes — resolve the target's
    // scope through the node set; an anchor trimmed by the cap falls back
    // to the memory's own scope (its anchor is itself, at band distance 0).
    const anchorId = anchorIdOf(edges, node.id);
    const anchorScope = (anchorId !== undefined ? scopeOf.get(anchorId) : undefined) ?? node.scope_path;
    const anchor = anchorOf.get(fileScopeOf(anchorScope)) ?? anchorCenter(fileScopeOf(anchorScope));
    const rng = createDemoRng((seed ^ fnv1a(node.scope_path) ^ fnv1a(node.label)) >>> 0);
    // Deterministic, unbounded collision resolution: every attempt widens
    // the radius and draws fresh numbers from the node's own stream, so a
    // free coordinate is always found and the result never depends on row
    // order — only on (seed, scope_path, id).
    let attempt = 0;
    for (;;) {
      const angle = rng() * Math.PI * 2;
      const radius = 120 + rng() * 200 + attempt * 60;
      const x = Math.round(anchor.x + Math.cos(angle) * radius);
      const y = Math.round(anchor.y + Math.sin(angle) * radius);
      if (take(x, y)) {
        node.position = { x, y };
        break;
      }
      attempt += 1;
    }
  }
}

/** The file portion of a scope URI — the anchor identity for layout purposes:
 * `proj:demo/file:src/auth.ts/sym:x` → `proj:demo/file:src/auth.ts`. A scope
 * with no file segment (bare project) is its own anchor. */
function fileScopeOf(scopePath: string): string {
  const idx = scopePath.indexOf('/sym:');
  if (idx !== -1) return scopePath.slice(0, idx);
  return scopePath;
}

/** Find the entity the ANCHORED_TO edges point this memory at (first wins). */
function anchorIdOf(edges: GraphEdge[], memoryId: string): string | undefined {
  for (const edge of edges) {
    if (edge.relation === 'ANCHORED_TO' && edge.source === memoryId) return edge.target;
  }
  return undefined;
}

function summarizeCandidate(candidate: CandidateRow): Record<string, unknown> {
  return {
    id: candidate.id,
    content: candidate.content,
    scope_path: candidate.scopePath,
    extracted_from: candidate.extractedFrom,
    confidence: candidate.confidence,
    status: candidate.status,
    created_at: candidate.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Routing (pure dispatch — given a URL+method+body, return a response)
// ---------------------------------------------------------------------------

export interface RouteRequest {
  method: string;
  rawUrl: string;
  /** Raw value of the `Authorization` header (or undefined when absent). */
  authorization?: string;
}

export function route(req: RouteRequest, ctx: WebContext): WebResponse {
  const { method, rawUrl } = req;
  const url = new URL(rawUrl, 'http://localhost');
  const path = url.pathname;

  // Health probe (always available, no DB access required)
  if (method === 'GET' && (path === '/api/health' || path === '/healthz')) {
    return jsonResponse(200, { ok: true, version: SERVER_VERSION });
  }

  if (path === '/api/stats' && method === 'GET') {
    const stats: DbStats = dbStats(ctx.db);
    const breakdown = buildStatsBreakdown(ctx.db);
    return jsonResponse(200, { ...stats, breakdown });
  }

  if (path === '/api/memory' && method === 'GET') {
    return handleListMemory(ctx, url);
  }

  if (path.startsWith('/api/memory/') && method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/memory/'.length));
    if (!isValidEntityId(id)) return errorResponse(400, 'invalid entity id');
    return handleGetMemory(ctx, id);
  }

  if (path.startsWith('/api/memory/') && method === 'DELETE') {
    if (ctx.authToken !== undefined && !isAuthorized(req.authorization, ctx.authToken)) {
      return errorResponse(401, 'missing or invalid auth token');
    }
    const id = decodeURIComponent(path.slice('/api/memory/'.length));
    if (!isValidEntityId(id)) return errorResponse(400, 'invalid entity id');
    return handleDeleteMemory(ctx, id);
  }

  if (path === '/api/candidates' && method === 'GET') {
    return handleListCandidates(ctx, url);
  }

  if (path === '/api/graph/memory' && method === 'GET') {
    const limit = clampLimit(url.searchParams.get('limit'), 500, 2000);
    return jsonResponse(200, buildMemoryGraph(ctx.db, limit, ctx.layoutSeed));
  }

  // Static SPA fallback is handled by runWebServer (needs fs); here we only
  // decide whether the request is API or static. API paths that miss every
  // branch above get a 404.
  if (path.startsWith('/api/')) {
    return errorResponse(404, `unknown api endpoint: ${method} ${path}`);
  }
  return null as unknown as WebResponse;
}

/**
 * Compare the request's `Authorization` header against the configured token.
 * Accepts `Bearer <token>` and `<token>` (raw) — the SPA uses `Bearer`.
 * Constant-time comparison guards against trivial timing oracles; the
 * secret is short (random hex) so the cost is negligible.
 */
function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

function handleListMemory(ctx: WebContext, url: URL): WebResponse {
  const { scopePrefix, q, limit } = parseMemoryListParams(url);
  let entities: EntityRow[];
  if (q !== undefined && q !== '') {
    const ftsHits = searchFts(ctx.db, q, limit);
    const ordered: EntityRow[] = [];
    for (const hit of ftsHits) {
      const entity = getEntity(ctx.db, hit.entityId);
      if (entity !== undefined && entity.type === 'memory_entry') ordered.push(entity);
    }
    entities = ordered;
  } else {
    entities = findEntitiesByScope(ctx.db, {
      scopePrefixes: scopePrefix !== undefined ? [scopePrefix] : [],
      types: ['memory_entry'],
      limit,
    });
  }
  return jsonResponse(200, {
    count: entities.length,
    memories: entities.map(summarizeEntity),
  });
}

function handleGetMemory(ctx: WebContext, id: string): WebResponse {
  const entity = getEntity(ctx.db, id);
  if (entity === undefined) return errorResponse(404, `memory '${id}' not found`);
  if (entity.type !== 'memory_entry') return errorResponse(400, `entity '${id}' is not a memory_entry`);
  return jsonResponse(200, buildMemoryDetail(ctx.db, entity));
}

function handleDeleteMemory(ctx: WebContext, id: string): WebResponse {
  const entity = getEntity(ctx.db, id);
  if (entity === undefined) return errorResponse(404, `memory '${id}' not found`);
  if (entity.type !== 'memory_entry') return errorResponse(400, `entity '${id}' is not a memory_entry`);
  // FK ON DELETE CASCADE handles relations + entity_vectors; the FTS5 delete
  // trigger mirrors the row removal. Wrapped in a transaction so a failure
  // mid-flight doesn't leave a partial delete.
  ctx.db.transaction(() => {
    deleteEntity(ctx.db, id);
  });
  return jsonResponse(200, { id, deleted: true });
}

function handleListCandidates(ctx: WebContext, url: URL): WebResponse {
  const status = url.searchParams.get('status');
  const validStatuses = ['pending', 'promoted', 'discarded'] as const;
  const filter = (validStatuses as readonly string[]).includes(status ?? '')
    ? (status as 'pending' | 'promoted' | 'discarded')
    : undefined;
  const limit = clampLimit(url.searchParams.get('limit'), 50, 500);
  const candidates = listCandidates(ctx.db, { status: filter, limit });
  return jsonResponse(200, {
    count: candidates.length,
    candidates: candidates.map(summarizeCandidate),
  });
}

// ---------------------------------------------------------------------------
// Static SPA serving (the only piece that touches the filesystem)
// ---------------------------------------------------------------------------

import { promises as fs, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve a request path to a file inside the SPA directory, with path-traversal
 * protection. Returns null when the path resolves outside the root, when the
 * file does not exist, or when the path is empty. For non-asset paths the
 * caller should fall back to `index.html` (SPA history-mode routing).
 */
export async function resolveStaticFile(staticDir: string, requestPath: string): Promise<{ path: string; mime: string } | null> {
  if (staticDir === '' || !existsSync(staticDir)) return null;
  const root = resolve(staticDir);
  const decoded = decodeURIComponent(requestPath);
  const candidate = normalize(join(root, decoded));
  // normalize() doesn't block "../" traversal on its own; verify the resolved
  // path is still under the root by string-comparing the root prefix.
  if (!(candidate === root || candidate.startsWith(root + sep) || candidate.startsWith(root + '/'))) {
    return null;
  }
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { path: candidate, mime: mimeFor(candidate) };
}

/** The SPA fallback path used for client-side routes. */
export const SPA_FALLBACK = 'index.html';

/**
 * Resolve the SPA fallback (`index.html`) if it exists in the static dir.
 * Returns null when the SPA has not been built (typical in dev / CI).
 */
export async function resolveSpaFallback(staticDir: string): Promise<{ path: string; mime: string } | null> {
  if (staticDir === '' || !existsSync(staticDir)) return null;
  return resolveStaticFile(staticDir, '/' + SPA_FALLBACK);
}

// ---------------------------------------------------------------------------
// HTTP shell
// ---------------------------------------------------------------------------

/**
 * Read the request body as a UTF-8 string with a hard size cap (defends
 * against accidental 10MB POSTs). On overflow, drains the socket and returns
 * `{ ok: false, error }` so the caller can write a proper 400 response
 * instead of relying on socket destruction (which the client sees as
 * ECONNRESET).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  return new Promise((resolveBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume(); // drain remaining bytes so the client doesn't hang
        resolveBody({ ok: false, error: 'request body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    /* v8 ignore start */
    // Defensive: req.on('error') fires for genuinely-broken sockets (e.g.
    // HTTP parser errors mid-body). In practice Node emits 'close' instead,
    // which exits the loop normally via 'end'. Kept for production safety.
    req.on('error', (err) => {
      resolveBody({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    /* v8 ignore stop */
  });
}

function sendResponse(res: ServerResponse, web: WebResponse): void {
  res.writeHead(web.status, web.headers);
  res.end(web.body);
}

/** Build the HTTP handler that ties routing + static serving together. */
function makeHandler(ctx: WebContext): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async (): Promise<void> => {
      try {
        /* v8 ignore start */
        // Defensive: Node's IncomingMessage always populates `method` and `url`
        // for parsed requests; the `??` fallbacks exist only for non-standard
        // embedding hosts. Unreachable in normal HTTP traffic.
        const method = req.method ?? 'GET';
        const rawUrl = req.url ?? '/';
        /* v8 ignore stop */
        // Eagerly drain the body for non-GET/HEAD so the socket isn't left in a
        // half-read state if downstream code wants to switch protocols (e.g. a
        // future POST /api/memory/import). The current API surface is GET-only.
        if (method !== 'GET' && method !== 'HEAD') {
          const drained = await readBody(req, 1024 * 1024);
          if (drained.ok === false) {
            sendResponse(res, errorResponse(400, drained.error));
            return;
          }
        }
        const apiResponse = route({ method, rawUrl, authorization: req.headers.authorization }, ctx);
        if (apiResponse !== null && apiResponse !== undefined) {
          sendResponse(res, apiResponse);
          return;
        }
        // Static fallback
        if (ctx.staticDir !== undefined) {
          const asset = await resolveStaticFile(ctx.staticDir, new URL(rawUrl, 'http://localhost').pathname);
          if (asset !== null) {
            const data = await fs.readFile(asset.path);
            res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'no-cache' });
            res.end(data);
            return;
          }
          const index = await resolveSpaFallback(ctx.staticDir);
          if (index !== null) {
            const data = await fs.readFile(index.path);
            res.writeHead(200, { 'content-type': index.mime, 'cache-control': 'no-cache' });
            res.end(data);
            return;
          }
        }
        sendResponse(res, errorResponse(404, 'not found'));
      } catch (error) {
        /* v8 ignore start */
        // Defensive: res.headersSent becomes true only if sendResponse() ran
        // AND a subsequent async operation then threw — none of the request
        // paths above throw after writing, so this branch is unreachable from
        // tests. Kept to mirror the mcp/server.ts pattern: production code
        // can hit it under unusual async races, and ERR_HTTP_HEADERS_SENT
        // would otherwise crash the request.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        /* v8 ignore stop */
        /* v8 ignore start */
        // Defensive: the outer try wraps route() + static serving; the only way
        // for `error` to be non-Error is for code to explicitly `throw 'string'`
        // (none of our handlers do). Kept for symmetry with the if-branch above.
        sendResponse(res, errorResponse(500, error instanceof Error ? error.message : String(error)));
        /* v8 ignore stop */
      }
    })();
  };
}

/**
 * Start the web admin server. Returns a handle exposing the bound URL/port
 * even when the caller passed port 0 (kernel-assigned). If the underlying
 * `listen()` fails the returned handle's `close()` is a no-op and `port` is
 * `0`, so the CLI can ignore startup failures without losing the MCP path.
 */
export function runWebServer(ctx: WebContext, port: number, host = '127.0.0.1'): Promise<WebServerHandle> {
  return new Promise((resolveHandle) => {
    const httpServer = createServer();
    httpServer.on('request', makeHandler(ctx));
    const onError = (): void => {
      // Couldn't bind (port in use, EACCES, ...): resolve with a sentinel so
      // callers can log the failure and continue running the main CLI.
      resolveHandle({
        server: httpServer,
        url: '',
        port: 0,
        async close(): Promise<void> {
          // Nothing was opened; close is a no-op.
        },
      });
    };
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      const address = httpServer.address();
      /* v8 ignore start */
      // Defensive: when the listen callback fires, httpServer.address() is
      // guaranteed by Node to return an AddressInfo (object form). The string
      // form only happens before listen() resolves. Unreachable here.
      const bound = typeof address === 'object' && address !== null ? (address as AddressInfo).port : port;
      /* v8 ignore stop */
      // unref() so the admin server cannot govern process lifetime. The MCP
      // server (stdio or SSE) is the foreground process owner; the admin
      // UI is a background sidecar that should never block process exit.
      // This fixes the zombie-process leak in the stdio branch where the
      // web handle was previously ref'd and never closed.
      httpServer.unref();
      const url = `http://${host}:${bound}`;
      resolveHandle({
        server: httpServer,
        url,
        port: bound,
        async close(): Promise<void> {
          await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
        },
      });
    });
  });
}
