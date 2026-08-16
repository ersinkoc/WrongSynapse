/**
 * Data-access layer: entity persistence, graph traversal, FTS5 lexical search,
 * vector store I/O, and memory-candidate operations. All functions are
 * synchronous and operate on a {@link SynapseDatabase}.
 */

import { randomUUID } from 'node:crypto';

import { embeddingToBuffer } from '../engine/vector-math.js';

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
  };
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
  db.prepare(
    `INSERT INTO entities (id, type, scope_path, name, content, metadata, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       scope_path = excluded.scope_path,
       name = excluded.name,
       content = excluded.content,
       metadata = excluded.metadata,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at`,
  ).run(
    entity.id,
    entity.type,
    entity.scopePath,
    entity.name,
    entity.content ?? null,
    entity.metadata ? JSON.stringify(entity.metadata) : null,
    entity.confidence ?? 1.0,
    nowMs(),
    nowMs(),
  );
  return exists;
}

export function getEntity(db: SynapseDatabase, id: string): EntityRow | undefined {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  return row === undefined ? undefined : entityFromRow(row);
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
  for (const id of stale) {
    db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  }
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

/** Store a Float32Array embedding as a raw BLOB (little-endian float32s). */
export function upsertVector(db: SynapseDatabase, entityId: string, embedding: Float32Array): void {
  db.prepare(
    `INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET embedding = excluded.embedding`,
  ).run(entityId, embeddingToBuffer(embedding));
}

export function deleteVector(db: SynapseDatabase, entityId: string): void {
  db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run(entityId);
}

function decodeEmbedding(value: unknown): Float32Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('embedding column is not a BLOB');
  const bytes = value.byteLength - (value.byteLength % 4);
  return new Float32Array(value.buffer, value.byteOffset, bytes / 4);
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
  const rows = db
    .prepare(
      `SELECT v.entity_id, e.scope_path, e.type, v.embedding
       FROM entity_vectors v
       JOIN entities e ON e.id = v.entity_id
       ${where}
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
