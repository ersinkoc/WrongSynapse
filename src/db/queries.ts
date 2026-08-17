/**
 * Data-access layer: entity persistence, graph traversal, FTS5 lexical search,
 * vector store I/O, and memory-candidate operations. All functions are
 * synchronous and operate on a {@link SynapseDatabase}.
 */

import { randomUUID } from 'node:crypto';

import { bufferToEmbedding, cosineSimilarity, embeddingToBuffer, l2Norm } from '../engine/vector-math.js';

import type { SqlValue, SynapseDatabase } from './connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewEntity {
  id: string;
  type: string;
  scopePath: string;
  name: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  confidence?: number;
  memoryKind?: string;
  importance?: number;
  expiresAt?: number | null;
  lastAccessedAt?: number | null;
  tags?: readonly string[];
}

export interface EntityRow {
  id: string;
  type: string;
  scopePath: string;
  name: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  memoryKind: string;
  importance: number;
  expiresAt: number | null;
  lastAccessedAt: number | null;
  tags: string[];
}

export interface NewRelation {
  id?: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
}

export interface FtsHit {
  entityId: string;
  score: number;
}

export interface VectorHit {
  entityId: string;
  scopePath: string;
  type: string;
  embedding: Float32Array;
}

export interface VectorQuery {
  scopePrefixes?: readonly string[];
  types?: readonly string[];
  limit?: number;
}

export type RelationDirection = 'in' | 'out' | 'both';

export interface NeighborQuery {
  depth?: number;
  direction?: RelationDirection;
  relationFilter?: readonly string[];
  maxNodes?: number;
}

export interface NeighborHit {
  entityId: string;
  depth: number;
  relation: string;
  direction: 'in' | 'out';
}

export interface GraphPathEdge {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  relation: string;
  targetId: string;
  targetName: string;
  targetType: string;
  depth: number;
}

export interface NewCandidate {
  id?: string;
  content: string;
  scopePath?: string | null;
  extractedFrom?: string | null;
  confidence?: number;
}

export interface CandidateRow {
  id: string;
  content: string;
  scopePath: string | null;
  extractedFrom: string | null;
  confidence: number;
  status: string;
  createdAt: number;
}

export interface DbStats {
  entities: number;
  relations: number;
  vectors: number;
  candidates: number;
  ftsRows: number;
}

// ---------------------------------------------------------------------------
// Row coercion helpers (SQLite returns typed values; validate defensively)
// ---------------------------------------------------------------------------

function reqStr(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`column '${key}' is not a string`);
  return value;
}

function optStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  // Selected columns always exist in driver rows; null coerces to 0 via
  // Number(null), matching the previous `?? 0` behaviour.
  return typeof value === 'number' ? value : Number(value);
}

function optNum(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? value : null;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

function entityFromRow(row: Record<string, unknown>): EntityRow {
  return {
    id: reqStr(row, 'id'),
    type: reqStr(row, 'type'),
    scopePath: reqStr(row, 'scope_path'),
    name: reqStr(row, 'name'),
    content: optStr(row, 'content'),
    metadata: parseMetadata(row['metadata']),
    confidence: num(row, 'confidence'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    // Memory enrichment fields (may not exist on pre-v2 dbs; fall back to defaults)
    memoryKind: (row['memory_kind'] as string | null) ?? 'general',
    importance: optNum(row, 'importance') ?? 0.5,
    expiresAt: optNum(row, 'expires_at') ?? null,
    lastAccessedAt: optNum(row, 'last_accessed_at') ?? null,
    tags: parseTags(row['tags']),
  };
}

function parseTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

function candidateFromRow(row: Record<string, unknown>): CandidateRow {
  return {
    id: reqStr(row, 'id'),
    content: reqStr(row, 'content'),
    scopePath: optStr(row, 'scope_path'),
    extractedFrom: optStr(row, 'extracted_from'),
    confidence: num(row, 'confidence'),
    status: reqStr(row, 'status'),
    createdAt: num(row, 'created_at'),
  };
}

const nowMs = (): number => Date.now();

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Insert or update an entity by id. Returns whether the row already existed. */
export function insertEntity(db: SynapseDatabase, entity: NewEntity): boolean {
  const exists = db.prepare('SELECT 1 AS x FROM entities WHERE id = ?').get(entity.id) !== undefined;
  const now = nowMs();
  const tags = entity.tags !== undefined ? JSON.stringify([...entity.tags]) : '[]';
  db.prepare(
    `INSERT INTO entities (id, type, scope_path, name, content, metadata, confidence, created_at, updated_at, memory_kind, importance, expires_at, last_accessed_at, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       scope_path = excluded.scope_path,
       name = excluded.name,
       content = excluded.content,
       metadata = excluded.metadata,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at,
       memory_kind = excluded.memory_kind,
       importance = excluded.importance,
       expires_at = excluded.expires_at,
       last_accessed_at = excluded.last_accessed_at,
       tags = excluded.tags`,
  ).run(
    entity.id,
    entity.type,
    entity.scopePath,
    entity.name,
    entity.content ?? null,
    entity.metadata ? JSON.stringify(entity.metadata) : null,
    entity.confidence ?? 1.0,
    now,
    now,
    entity.memoryKind ?? 'general',
    entity.importance ?? 0.5,
    entity.expiresAt ?? null,
    entity.lastAccessedAt ?? null,
    tags,
  );
  return exists;
}

export function getEntity(db: SynapseDatabase, id: string): EntityRow | undefined {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  return row === undefined ? undefined : entityFromRow(row);
}

/** Batch variant of {@link getEntity}: one chunked IN(...) query per ~100 ids.
 *  Unknown ids are simply absent from the returned map. */
export function getEntities(db: SynapseDatabase, ids: readonly string[]): Map<string, EntityRow> {
  const out = new Map<string, EntityRow>();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    /* v8 ignore next -- slice of a bounded loop index is never empty */
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM entities WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) {
      const entity = entityFromRow(row);
      out.set(entity.id, entity);
    }
  }
  return out;
}

export function getEntityByScope(
  db: SynapseDatabase,
  scopePath: string,
  types?: readonly string[],
): EntityRow | undefined {
  const typeClause = types !== undefined && types.length > 0 ? ` AND type IN (${types.map(() => '?').join(', ')})` : '';
  const params: SqlValue[] = types !== undefined && types.length > 0 ? [scopePath, ...types] : [scopePath];
  const row = db
    .prepare(`SELECT * FROM entities WHERE scope_path = ?${typeClause} ORDER BY updated_at DESC LIMIT 1`)
    .get(...params);
  return row === undefined ? undefined : entityFromRow(row);
}

export function deleteEntity(db: SynapseDatabase, id: string): void {
  // vec_entities is a virtual table without FK support — remove its row
  // explicitly, then the cascade takes care of entity_vectors/relations.
  deleteVector(db, id);
  db.prepare('DELETE FROM entities WHERE id = ?').run(id);
}

export interface EntityQuery {
  scopePrefixes?: readonly string[];
  types?: readonly string[];
  limit?: number;
}

/**
 * Boundary-aware scope-prefix matching, shared by every prefix query.
 *
 * A bare `LIKE 'prefix%'` would also match sibling scopes ('proj:app' would
 * match 'proj:app2/...'). This predicate matches the exact scope or any
 * '/'-rooted descendant, and stays sargable: '/' (0x2F) and '0' (0x30) are
 * adjacent code points, so the range [prefix + '/', prefix + '0') covers
 * exactly the descendants and keeps idx_entities_scope usable.
 */
function pushPrefixClause(
  column: string,
  prefixes: readonly string[],
  clauses: string[],
  params: SqlValue[],
): void {
  const parts: string[] = [];
  for (const prefix of prefixes) {
    parts.push(`(${column} = ? OR (${column} >= ? || '/' AND ${column} < ? || '0'))`);
    params.push(prefix, prefix, prefix);
  }
  if (parts.length > 0) clauses.push(`(${parts.join(' OR ')})`);
}

export function findEntitiesByScope(
  db: SynapseDatabase,
  { scopePrefixes = [], types = [], limit = 100 }: EntityQuery = {},
): EntityRow[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  pushPrefixClause('scope_path', scopePrefixes, clauses, params);
  if (types.length > 0) {
    clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
    for (const type of types) params.push(type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = db
    .prepare(`SELECT * FROM entities ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params);
  return rows.map(entityFromRow);
}

/**
 * Delete entities that were created by the workspace indexer (identified by
 * the `synapse_indexed` metadata marker) under a scope prefix, excluding a set
 * of ids that were re-touched during the current index run.
 */
export function deleteStaleIndexedEntities(
  db: SynapseDatabase,
  scopePrefix: string,
  types: readonly string[],
  keepIds: ReadonlySet<string>,
): number {
  // Shares the boundary-aware prefix predicate with findEntitiesByScope /
  // getVectors: a bare LIKE '${scopePrefix}%' would also match sibling
  // scopes like 'proj:app2/...' and delete entities outside the indexed tree.
  const clauses: string[] = [`type IN (${types.map(() => '?').join(', ')})`, `json_extract(metadata, '$.synapse_indexed') = 1`];
  const params: SqlValue[] = [...types];
  pushPrefixClause('scope_path', [scopePrefix], clauses, params);
  const rows = db
    .prepare(`SELECT id FROM entities WHERE ${clauses.join(' AND ')}`)
    .all(...params);
  const stale = rows
    .map((row) => reqStr(row, 'id'))
    .filter((id) => !keepIds.has(id));
  // One transaction for the whole sweep: a crash mid-loop would otherwise
  // leave a partially-deleted index (some stale rows gone, others revived).
  db.transaction(() => {
    for (const id of stale) {
      db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    }
  });
  return stale.length;
}

// ---------------------------------------------------------------------------
// Lexical search (FTS5 / BM25)
// ---------------------------------------------------------------------------
/**
 * Escape a free-text query into a safe FTS5 MATCH expression: lowercase,
 * split into alphanumeric tokens, each double-quoted (AND semantics).
 * Returns null when the query contains no usable tokens.
 */
export function escapeFtsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

/** BM25 ranking over FTS5 (name weighted highest). */
export function searchFts(db: SynapseDatabase, text: string, limit: number): FtsHit[] {
  const match = escapeFtsQuery(text);
  if (match === null) return [];
  const rows = db
    .prepare(
      `SELECT e.id AS entity_id, bm25(entities_fts, 5.0, 1.0, 1.0) AS score
       FROM entities_fts
       JOIN entities e ON e.rowid = entities_fts.rowid
       WHERE entities_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(match, limit);
  return rows.map((row) => ({ entityId: reqStr(row, 'entity_id'), score: num(row, 'score') }));
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

/**
 * Mirror a BLOB-vector write into the vec_entities KNN table. The BLOB table
 * stays the source of truth; vec_entities is a derived index that must not
 * drift. An embedding whose dimension disagrees with the index (user switched
 * SYNAPSE_EMBEDDING_MODEL mid-database) cannot be stored in the fixed-width
 * vec0 column — the index disables itself for the rest of the process and the
 * exact BLOB cosine scan takes over, which skips dimension-mismatched rows.
 */
function syncVecIndexUpsert(db: SynapseDatabase, entityId: string, embedding: Float32Array): void {
  const vec = db.vec;
  if (vec === undefined || !vec.indexReady) return;
  if (vec.indexDimension !== null && embedding.length !== vec.indexDimension) {
    vec.indexReady = false;
    console.error(
      `vec_entities index disabled: new embedding has dimension ${embedding.length} but the index was built for ${vec.indexDimension} ` +
        '(SYNAPSE_EMBEDDING_MODEL changed? rebuild the database or re-index). Falling back to exact cosine scan.',
    );
    return;
  }
  const buffer = embeddingToBuffer(embedding);
  const updated = db
    .prepare('UPDATE vec_entities SET embedding = ? WHERE entity_id = ?')
    .run(buffer, entityId);
  if (Number(updated.changes) === 0) {
    db.prepare('INSERT INTO vec_entities(embedding, entity_id) VALUES (?, ?)').run(buffer, entityId);
  }
}

/** Store a Float32Array embedding as a raw BLOB (little-endian float32s) and
 *  keep the vec_entities KNN index in sync when it is active. */
export function upsertVector(db: SynapseDatabase, entityId: string, embedding: Float32Array): void {
  db.prepare(
    `INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET embedding = excluded.embedding`,
  ).run(entityId, embeddingToBuffer(embedding));
  syncVecIndexUpsert(db, entityId, embedding);
}

export function deleteVector(db: SynapseDatabase, entityId: string): void {
  db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run(entityId);
  if (db.vec?.indexReady === true) {
    db.prepare('DELETE FROM vec_entities WHERE entity_id = ?').run(entityId);
  }
}

/** Total number of stored BLOB vectors (used to pick exact-scan vs ANN). */
export function countVectors(db: SynapseDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM entity_vectors').get();
  /* v8 ignore next -- COUNT(*) always returns exactly one row */
  return row === undefined ? 0 : num(row, 'n');
}

function decodeEmbedding(value: unknown): Float32Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('embedding column is not a BLOB');
  return bufferToEmbedding(value);
}

/** Fetch embeddings joined with their entities, optionally scope/type filtered. */
export function getVectors(db: SynapseDatabase, options: VectorQuery = {}): VectorHit[] {
  const { scopePrefixes = [], types = [], limit = 1000 } = options;
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  pushPrefixClause('e.scope_path', scopePrefixes, clauses, params);
  if (types.length > 0) {
    clauses.push(`e.type IN (${types.map(() => '?').join(', ')})`);
    for (const type of types) params.push(type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  // ORDER BY entity_id makes the LIMIT subset deterministic: without it,
  // SQLite returns an arbitrary page and the semantic channel of hybrid
  // search would silently score a different slice on every query.
  const rows = db
    .prepare(
      `SELECT v.entity_id, e.scope_path, e.type, v.embedding
       FROM entity_vectors v
       JOIN entities e ON e.id = v.entity_id
       ${where}
       ORDER BY v.entity_id
       LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => ({
    entityId: reqStr(row, 'entity_id'),
    scopePath: reqStr(row, 'scope_path'),
    type: reqStr(row, 'type'),
    embedding: decodeEmbedding(row['embedding']),
  }));
}

// ---------------------------------------------------------------------------
// Memory deduplication
// ---------------------------------------------------------------------------

export interface SimilarMemoryHit {
  entityId: string;
  similarity: number;
  memoryKind: string;
  importance: number;
  scopePath: string;
  content: string | null;
  updatedAt: number;
}

/**
 * Find memory entries whose stored embedding is at least `threshold` similar
 * (cosine, 0..1) to the given query embedding. Restricted to rows of type
 * `memory_entry` so it doesn't scan code/file/symbol entities. The output is
 * ordered by similarity descending and capped at `limit`.
 *
 * `scopePrefixes` (optional) restricts the scan SQL-side with the shared
 * boundary-aware prefix predicate, so the limit is spent on in-scope
 * candidates only — a post-hoc filter would let 50 higher-similarity
 * out-of-scope rows starve the actual winner.
 *
 * Rows whose stored dimension disagrees with the query (e.g. the embedding
 * model changed after older memories were written) are skipped rather than
 * crashing the whole scan: a dimension-mismatched pair has no meaningful
 * cosine similarity anyway.
 */
export function findSimilarMemories(
  db: SynapseDatabase,
  embedding: Float32Array,
  threshold: number,
  memoryKind: string | null,
  limit: number,
  scopePrefixes?: readonly string[],
): SimilarMemoryHit[] {
  if (embedding.length === 0) return [];
  const norm = l2Norm(embedding);
  if (norm === 0) return [];
  const clauses: string[] = [`e.type = 'memory_entry'`];
  const params: SqlValue[] = [];
  if (memoryKind !== null) {
    clauses.push('e.memory_kind = ?');
    params.push(memoryKind);
  }
  if (scopePrefixes !== undefined && scopePrefixes.length > 0) {
    pushPrefixClause('e.scope_path', scopePrefixes, clauses, params);
  }
  clauses.push('(e.expires_at IS NULL OR e.expires_at > ?)');
  params.push(Date.now());
  // No pre-score LIMIT: every eligible memory_entry vector must be scored
  // before we sort and truncate. A LIMIT applied here would silently miss
  // matching memories outside the arbitrary entity-ID-ordered subset.
  const rows = db
    .prepare(
      `SELECT e.id, e.memory_kind, e.importance, e.scope_path, e.content, e.updated_at, v.embedding
       FROM entity_vectors v
       JOIN entities e ON e.id = v.entity_id
       WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params);
  const hits: SimilarMemoryHit[] = [];
  for (const row of rows) {
    const other = decodeEmbedding(row['embedding']);
    if (other.length !== embedding.length) continue; // dimension mismatch: skip
    const sim = cosineSimilarity(embedding, other);
    if (sim >= threshold) {
      hits.push({
        entityId: reqStr(row, 'id'),
        similarity: sim,
        memoryKind: String(row['memory_kind'] ?? 'general'),
        importance: num(row, 'importance'),
        scopePath: reqStr(row, 'scope_path'),
        content: optStr(row, 'content'),
        updatedAt: num(row, 'updated_at'),
      });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

/**
 * Merge two memory entries: the `loserId` is archived (its row is kept but
 * `expires_at` is set to the epoch so retrieval filters it out), the `winnerId`
 * keeps its content but absorbs the loser's metadata, tags, and importance. A
 * SUPERSEDES relation is created (winner → loser) so retrieval chains can
 * still resolve the old id. All in one transaction so a crash mid-merge
 * cannot leave the graph in a half-merged state.
 *
 * The loser is archived rather than hard-deleted because `relations.target_id`
 * uses `ON DELETE CASCADE` — a hard delete would immediately remove the
 * SUPERSEDES history edge we just inserted. Archive keeps the FK target valid
 * while making the row invisible to retrieval (the `expires_at IS NULL OR
 * expires_at > ?` predicate excludes it).
 *
 * Returns true on success, or false if the loser is already gone (idempotent).
 */
export function mergeMemories(
  db: SynapseDatabase,
  winnerId: string,
  loserId: string,
): boolean {
  if (winnerId === loserId) return false;
  return db.transaction(() => {
    const winner = getEntity(db, winnerId);
    const loser = getEntity(db, loserId);
    if (winner === undefined || loser === undefined) return false;
    const mergedTags = Array.from(new Set([...winner.tags, ...loser.tags])).slice(0, 10);
    const mergedImportance = Math.max(winner.importance, loser.importance);
    const mergedScope = winner.scopePath;
    insertEntity(db, {
      id: winner.id,
      type: winner.type,
      scopePath: mergedScope,
      name: winner.name,
      content: winner.content,
      metadata: { ...(winner.metadata ?? {}), ...(loser.metadata ?? {}) },
      confidence: Math.max(winner.confidence, loser.confidence),
      memoryKind: winner.memoryKind,
      importance: mergedImportance,
      expiresAt: winner.expiresAt,
      lastAccessedAt: winner.lastAccessedAt,
      tags: mergedTags,
    });
    insertRelation(db, {
      sourceId: winnerId,
      targetId: loserId,
      relation: 'SUPERSEDES',
      weight: 1.0,
    });
    // Archive the loser: keep the row, but set expires_at to 0 so the
    // `expires_at > ?` filter excludes it from retrieval. The SUPERSEDES
    // edge survives because the FK target is still present.
    db.prepare('UPDATE entities SET expires_at = 0 WHERE id = ?').run(loserId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Relations / knowledge graph
// ---------------------------------------------------------------------------

/** Insert a relation edge, ignoring duplicates (unique on source/target/relation). */
export function insertRelation(db: SynapseDatabase, relation: NewRelation): void {
  db.prepare(
    `INSERT OR IGNORE INTO relations (id, source_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    relation.id ?? randomUUID(),
    relation.sourceId,
    relation.targetId,
    relation.relation,
    relation.weight ?? 1.0,
    nowMs(),
  );
}

interface EdgeRow {
  id: string; // neighbor entity id
  relation: string;
}

function edgeFromRow(row: Record<string, unknown>): EdgeRow {
  return { id: reqStr(row, 'neighbor_id'), relation: reqStr(row, 'relation') };
}

/**
 * Breadth-first traversal of the relational graph from `entityId`, following
 * edges in the requested direction(s) up to `depth` hops. Returns the
 * neighboring *entity* ids (not relation ids), one hit per (neighbor, relation,
 * direction) triple.
 */
export function getNeighbors(
  db: SynapseDatabase,
  entityId: string,
  options: NeighborQuery = {},
): NeighborHit[] {
  const { depth = 1, direction = 'both', relationFilter = [], maxNodes = 500 } = options;
  const relClause = relationFilter.length > 0 ? ` AND relation IN (${relationFilter.map(() => '?').join(', ')})` : '';
  const outStmt = db.prepare(`SELECT target_id AS neighbor_id, relation FROM relations WHERE source_id = ?${relClause}`);
  const inStmt = db.prepare(`SELECT source_id AS neighbor_id, relation FROM relations WHERE target_id = ?${relClause}`);

  const visited = new Set<string>([entityId]);
  const seenEdge = new Set<string>();
  const results: NeighborHit[] = [];
  let frontier: string[] = [entityId];

  for (let d = 1; d <= depth && frontier.length > 0 && results.length < maxNodes; d++) {
    const next: string[] = [];
    for (const current of frontier) {
      const scan = (dir: 'in' | 'out', rows: EdgeRow[]): void => {
        for (const edge of rows) {
          if (results.length >= maxNodes) return;
          const key = `${edge.id}|${edge.relation}|${dir}`;
          if (seenEdge.has(key)) continue;
          seenEdge.add(key);
          results.push({ entityId: edge.id, depth: d, relation: edge.relation, direction: dir });
          if (!visited.has(edge.id)) {
            visited.add(edge.id);
            next.push(edge.id);
          }
        }
      };
      if (direction === 'out' || direction === 'both') {
        scan('out', outStmt.all(current, ...relationFilter).map(edgeFromRow));
      }
      if (direction === 'in' || direction === 'both') {
        scan('in', inStmt.all(current, ...relationFilter).map(edgeFromRow));
      }
    }
    frontier = next;
  }
  return results;
}

/**
 * One-hop relational context around an entity: edges touching it, joined with
 * neighbor names/types for readable output.
 */
export function getGraphPath(
  db: SynapseDatabase,
  entityId: string,
  options: { relationFilter?: readonly string[]; limit?: number } = {},
): GraphPathEdge[] {
  const { relationFilter = [], limit = 8 } = options;
  const relClause = relationFilter.length > 0 ? ` AND r.relation IN (${relationFilter.map(() => '?').join(', ')})` : '';
  const rows = db
    .prepare(
      `SELECT r.id, r.source_id, s.name AS source_name, s.type AS source_type, r.relation,
              r.target_id, t.name AS target_name, t.type AS target_type
       FROM relations r
       JOIN entities s ON s.id = r.source_id
       JOIN entities t ON t.id = r.target_id
       WHERE (r.source_id = ? OR r.target_id = ?)${relClause}
       LIMIT ?`,
    )
    .all(entityId, entityId, ...relationFilter, limit);
  return rows.map((row) => ({
    id: reqStr(row, 'id'),
    sourceId: reqStr(row, 'source_id'),
    sourceName: reqStr(row, 'source_name'),
    sourceType: reqStr(row, 'source_type'),
    relation: reqStr(row, 'relation'),
    targetId: reqStr(row, 'target_id'),
    targetName: reqStr(row, 'target_name'),
    targetType: reqStr(row, 'target_type'),
    depth: 1,
  }));
}

// ---------------------------------------------------------------------------
// Memory entry enrichment helpers
// ---------------------------------------------------------------------------

export interface MemoryQuery {
  scopePrefixes?: readonly string[];
  types?: readonly string[];
  memoryKinds?: readonly string[];
  importanceMin?: number;
  tags?: readonly string[];
  includeExpired?: boolean;
  limit?: number;
}

/**
 * Find memory entities with optional filters for kind, importance, scope, and tags.
 * Filters out expired entries by default unless includeExpired is true.
 */
export function findMemories(
  db: SynapseDatabase,
  options: MemoryQuery = {},
): EntityRow[] {
  const {
    scopePrefixes = [],
    types = [],
    memoryKinds = [],
    importanceMin,
    tags = [],
    includeExpired = false,
    limit = 100,
  } = options;

  const clauses: string[] = [];
  const params: SqlValue[] = [];

  // Type filter defaults to memory_entry
  const effectiveTypes = types.length > 0 ? types : ['memory_entry'];
  clauses.push(`type IN (${effectiveTypes.map(() => '?').join(', ')})`);
  for (const t of effectiveTypes) params.push(t);

  // Scope prefix filtering
  if (scopePrefixes.length > 0) {
    pushPrefixClause('scope_path', scopePrefixes, clauses, params);
  }

  // Memory kind filter
  if (memoryKinds.length > 0) {
    clauses.push(`memory_kind IN (${memoryKinds.map(() => '?').join(', ')})`);
    for (const k of memoryKinds) params.push(k);
  }

  // Importance minimum filter
  if (importanceMin !== undefined) {
    clauses.push('importance >= ?');
    params.push(importanceMin);
  }

  // Tag filter (JSON array column)
  if (tags.length > 0) {
    for (const tag of tags) {
      clauses.push(`tags LIKE ?`);
      params.push(`%"${tag.replace(/"/g, '""')}"%`);
    }
  }

  // Expiration filter
  if (!includeExpired) {
    const now = nowMs();
    clauses.push(`(expires_at IS NULL OR expires_at > ?)`);
    params.push(now);
  }

  /* v8 ignore next -- the type clause is pushed unconditionally above, so the empty arm is structurally dead */
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = db
    .prepare(`SELECT * FROM entities ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
    .all(...params);
  return rows.map(entityFromRow);
}

/** Update last_accessed_at timestamp to now. */
export function touchMemory(db: SynapseDatabase, id: string): void {
  db.prepare('UPDATE entities SET last_accessed_at = ? WHERE id = ?').run(nowMs(), id);
}

/** Find memory entries past their expiration time. */
export function findExpiredMemories(db: SynapseDatabase): EntityRow[] {
  const now = nowMs();
  const rows = db
    .prepare(
      `SELECT * FROM entities
       WHERE type = 'memory_entry'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC`,
    )
    .all(now);
  return rows.map(entityFromRow);
}

/** Delete all expired memory entries. Returns count of deleted rows. */
export function deleteExpiredMemories(db: SynapseDatabase): number {
  const expired = findExpiredMemories(db);
  db.transaction(() => {
    for (const entity of expired) {
      deleteEntity(db, entity.id);
    }
  });
  return expired.length;
}

// ---------------------------------------------------------------------------
// Memory candidates (SAGE-compatible episodic memory)
// ---------------------------------------------------------------------------

export function insertCandidate(db: SynapseDatabase, candidate: NewCandidate): string {
  const id = candidate.id ?? randomUUID();
  db.prepare(
    `INSERT INTO memory_candidates (id, content, scope_path, extracted_from, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    candidate.content,
    candidate.scopePath ?? null,
    candidate.extractedFrom ?? null,
    candidate.confidence ?? 0.7,
    nowMs(),
  );
  return id;
}

export function getCandidate(db: SynapseDatabase, id: string): CandidateRow | undefined {
  const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id);
  return row === undefined ? undefined : candidateFromRow(row);
}

export function setCandidateStatus(db: SynapseDatabase, id: string, status: 'pending' | 'promoted' | 'discarded'): void {
  db.prepare('UPDATE memory_candidates SET status = ? WHERE id = ?').run(status, id);
}

export function listCandidates(
  db: SynapseDatabase,
  options: { status?: string; limit?: number; extractedFrom?: string } = {},
): CandidateRow[] {
  const { status, limit = 50, extractedFrom } = options;
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (status !== undefined) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (extractedFrom !== undefined) {
    // Ownership filter: a synthetic writer (e.g. DemoFeeder) must only
    // sweep candidates it created, never foreign rows sharing the pool.
    clauses.push('extracted_from = ?');
    params.push(extractedFrom);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM memory_candidates${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
  return rows.map(candidateFromRow);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function dbStats(db: SynapseDatabase): DbStats {
  const count = (table: string): number => {
    // COUNT(*) always returns exactly one row on both drivers.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!;
    return num(row, 'n');
  };
  return {
    entities: count('entities'),
    relations: count('relations'),
    vectors: count('entity_vectors'),
    candidates: count('memory_candidates'),
    ftsRows: count('entities_fts'),
  };
}

/** Convenience: opt-out nullish-coalesced number accessor used by consumers. */
export function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  return optNum(row, key);
}
