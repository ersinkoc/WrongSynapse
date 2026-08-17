/**
 * Tri-hybrid retrieval engine: FTS5/BM25 (lexical) + cosine similarity
 * (semantic) + relational graph expansion (structural), fused with Reciprocal
 * Rank Fusion (RRF), k = 60.
 *
 *   RRF(d) = sum_m w_m / (k + rank_m(d))
 *
 * Semantic retrieval degrades gracefully when the embedding model is not
 * available (offline, not yet downloaded): the engine still returns lexical +
 * graph results and reports a warning.
 */

import type { SynapseDatabase, VecCapabilities } from '../db/connection.js';
import {
  getEntity,
  getGraphPath,
  getNeighbors,
  getVectors,
  searchFts,
  type EntityRow,
  type GraphPathEdge,
} from '../db/queries.js';
import { scopeMatchesAnyPrefix } from '../utils/scope.js';
import { cosineSimilarity } from './vector-math.js';
import type { Embedder } from './embedding.js';

// Augment SynapseDatabase with sqlite-vec capabilities when the extension is loaded.
type SynapseDbWithVec = SynapseDatabase & { vec: VecCapabilities };

export interface HybridQueryOptions {
  query: string;
  scopes?: readonly string[];
  types?: readonly string[];
  limit?: number;
  vectorWeight?: number;
  lexicalWeight?: number;
  graphWeight?: number;
  graphDepth?: number;
}

export interface HybridResult {
  entity: EntityRow;
  score: number;
  ranks: { fts: number | null; vector: number | null; graph: number | null };
  matchedScopes: string[];
  graphPaths: GraphPathEdge[];
}

export interface HybridSearchOutput {
  results: HybridResult[];
  warnings: string[];
  vectorRetrievalUsed: boolean;
}

const RRF_K = 60;
const MAX_CANDIDATES = 100;
/**
 * Upper bound on vectors loaded per query for the semantic channel. Loading
 * is a full scan (there is no ANN index), so this caps transient memory
 * (~1.5 KB per 384-dim vector). getVectors orders by entity_id, so a
 * truncated scan is at least a deterministic subset — and the caller is
 * told about the truncation via a warning instead of silently scoring an
 * arbitrary slice.
 */
const VECTOR_SCAN_CAP = 10_000;

/**
 * A memory entry is expired when its `expires_at` is non-null and in the past.
 * The hybrid search filters expired entries at candidate-retrieval time
 * (before RRF truncation) so a TTL-expiring corpus can't silently evict the
 * recall channel's only relevant hits.
 */
function isExpired(entity: { expiresAt: number | null }, now: number): boolean {
  return entity.expiresAt !== null && entity.expiresAt <= now;
}
const SEED_LIMIT = 5;
const NEIGHBOR_CAP = 50;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesFilters(scopePath: string, type: string, scopes: readonly string[], types: readonly string[]): boolean {
  if (!scopeMatchesAnyPrefix(scopePath, scopes)) return false;
  if (types.length > 0 && !types.includes(type)) return false;
  return true;
}

export async function hybridSearch(
  db: SynapseDatabase,
  embedder: Embedder,
  options: HybridQueryOptions,
): Promise<HybridSearchOutput> {
  const {
    query,
    scopes = [],
    types = [],
    limit = 10,
    vectorWeight = 1,
    lexicalWeight = 1,
    graphWeight = 1,
    graphDepth = 1,
  } = options;
  const warnings: string[] = [];
  const typesFilter = [...types];

  // ---- 1. Lexical (FTS5 / BM25) -------------------------------------------
  const ftsRanked: string[] = [];
  const expiryNow = Date.now();
  for (const hit of searchFts(db, query, MAX_CANDIDATES)) {
    // FK cascades delete FTS rows with their entities, so a missing entity
    // here is not producible through the public API.
    const entity = getEntity(db, hit.entityId);
    /* v8 ignore next */
    if (entity === undefined) continue;
    if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
    // Expire expired memory entries at the candidate level so RRF truncation
    // cannot silently evict the recall channel's only relevant hits.
    if (isExpired(entity, expiryNow)) continue;
    // entities_fts is content-linked to entities (1:1 on rowid), so the JOIN
    // cannot yield the same entity twice.
    /* v8 ignore next */
    if (!ftsRanked.includes(hit.entityId)) ftsRanked.push(hit.entityId);
  }

  // ---- 2. Semantic (HNSW ANN via sqlite-vec or full-table cosine fallback) ---
  const vecRanked: string[] = [];
  let vectorRetrievalUsed = false;
  if (vectorWeight > 0) {
    try {
      await embedder.init();
      const queryVec = await embedder.embed(query);
      const dbVec = (db as SynapseDbWithVec).vec;

      if (dbVec?.hnswEnabled && dbVec.hnswBuildComplete) {
        // --- HNSW ANN search via sqlite-vec ---
        // sqlite-vec requires embedding as a literal JSON array and k as a literal integer.
        // queryVec values are trusted floats from the embedder (not user input), so building
        // the JSON inline is safe here. k is a positive integer constant.
        const embedJson = JSON.stringify([...queryVec]);
        // Fetch a large batch to reduce the "global ANN neighbors are out-of-scope" gap.
        // sqlite-vec does not support OFFSET; the cosine fallback covers remaining cases.
        const topK = MAX_CANDIDATES * 20;
        const rows = db.prepare(
          `SELECT entity_id, distance
           FROM vec_entities
           WHERE embedding match '${embedJson}'
           AND k = ${topK}`
        ).all() as { entity_id: string; distance: number }[];
        const seen = new Set<string>();
        for (const row of rows) {
          const entity = getEntity(db, row.entity_id);
          if (!entity) continue;
          if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
          if (isExpired(entity, expiryNow)) continue;
          if (seen.has(row.entity_id)) continue;
          seen.add(row.entity_id);
          if (vecRanked.length < MAX_CANDIDATES) vecRanked.push(row.entity_id);
        }
        // If the large ANN batch yielded few/none in-filter results, fall back to
        // exact cosine scan over BLOB vectors. This guards against a sparse HNSW
        // index (e.g. new DB, few indexed entries) or extreme scope mismatch.
        if (vecRanked.length < MAX_CANDIDATES) {
          const candidates = getVectors(db, {
            scopePrefixes: scopes.length > 0 ? [...scopes] : undefined,
            types: typesFilter,
            limit: VECTOR_SCAN_CAP,
          });
          const scored: { id: string; score: number }[] = [];
          for (const candidate of candidates) {
            if (candidate.embedding.length !== queryVec.length) continue;
            scored.push({ id: candidate.entityId, score: cosineSimilarity(queryVec, candidate.embedding) });
          }
          scored.sort((a, b) => b.score - a.score);
          for (const entry of scored.slice(0, MAX_CANDIDATES - vecRanked.length)) {
            if (!seen.has(entry.id)) vecRanked.push(entry.id);
          }
          if (vecRanked.length > 0) {
            warnings.push('ANN batch yielded fewer results than expected; cosine scan filled remaining slots.');
          }
        }
        vectorRetrievalUsed = vecRanked.length > 0;
      } else {
        // --- Full-table cosine scan (legacy fallback) ---
        const candidates = getVectors(db, {
          scopePrefixes: scopes.length > 0 ? [...scopes] : undefined,
          types: typesFilter,
          limit: VECTOR_SCAN_CAP,
        });
        if (candidates.length >= VECTOR_SCAN_CAP) {
          warnings.push(`semantic scan truncated at ${VECTOR_SCAN_CAP} vectors (deterministic subset by entity id)`);
        }
        const scored: { id: string; score: number }[] = [];
        for (const candidate of candidates) {
          if (!matchesFilters(candidate.scopePath, candidate.type, scopes, typesFilter)) continue;
          // Expiry check: getVectors' SQL already filters expired vectors out
          // (WHERE expires_at IS NULL OR expires_at > ? in src/db/queries.ts),
          // so every candidate here is fresh. The `isExpired` call would be
          // dead code AND a typecheck error since VectorHit doesn't expose
          // expiresAt (the column isn't projected). Documented to keep the
          // invariant visible — do not re-add the call here without also
          // projecting e.expires_at in the getVectors SQL.
          if (candidate.embedding.length !== queryVec.length) continue; // dimension mismatch: skip
          scored.push({ id: candidate.entityId, score: cosineSimilarity(queryVec, candidate.embedding) });
        }
        scored.sort((a, b) => b.score - a.score);
        for (const entry of scored.slice(0, MAX_CANDIDATES)) vecRanked.push(entry.id);
        vectorRetrievalUsed = true;
      }
    } catch (error) {
      warnings.push(`semantic retrieval skipped: ${describeError(error)}`);
    }
  }

  // ---- 3. Graph expansion over seed entities -------------------------------
  const graphRanked: string[] = [];
  if (graphWeight > 0) {
    const seeds = [...ftsRanked.slice(0, SEED_LIMIT), ...vecRanked.slice(0, SEED_LIMIT)];
    const graphScores = new Map<string, number>();
    for (const seed of seeds) {
      for (const neighbor of getNeighbors(db, seed, { depth: graphDepth, direction: 'both', maxNodes: NEIGHBOR_CAP })) {
        const entity = getEntity(db, neighbor.entityId);
        if (entity !== undefined && isExpired(entity, expiryNow)) continue;
        // FK cascades delete relations with their entities, so a missing
        // neighbor is not producible through the public API.
        /* v8 ignore next */
        if (entity === undefined) continue;
        if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
        graphScores.set(neighbor.entityId, (graphScores.get(neighbor.entityId) ?? 0) + 1 / (neighbor.depth + 1));
      }
    }
    const sorted = [...graphScores.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id] of sorted) graphRanked.push(id);
  }

  // ---- 4. Reciprocal Rank Fusion -------------------------------------------
  const fused = new Map<string, { fts: number | null; vector: number | null; graph: number | null }>();
  const addRanked = (ranked: readonly string[], weight: number, key: 'fts' | 'vector' | 'graph'): void => {
    if (weight <= 0) return;
    ranked.forEach((id, index) => {
      const entry = fused.get(id) ?? { fts: null, vector: null, graph: null };
      entry[key] = index + 1; // 1-based rank
      fused.set(id, entry);
    });
  };
  addRanked(ftsRanked, lexicalWeight, 'fts');
  addRanked(vecRanked, vectorWeight, 'vector');
  addRanked(graphRanked, graphWeight, 'graph');

  const scored: { id: string; score: number; ranks: { fts: number | null; vector: number | null; graph: number | null } }[] = [];
  for (const [id, ranks] of fused) {
    let score = 0;
    if (ranks.fts !== null) score += lexicalWeight / (RRF_K + ranks.fts);
    if (ranks.vector !== null) score += vectorWeight / (RRF_K + ranks.vector);
    if (ranks.graph !== null) score += graphWeight / (RRF_K + ranks.graph);
    scored.push({ id, score, ranks });
  }
  scored.sort((a, b) => b.score - a.score);

  // ---- 5. Assemble results with contextual graph paths ---------------------
  const results: HybridResult[] = [];
  for (const entry of scored.slice(0, limit)) {
    // Entities in `scored` were joined from live rows; a missing row here
    // requires a concurrent delete between ranking and assembly.
    const entity = getEntity(db, entry.id);
    /* v8 ignore next */
    if (entity === undefined) continue;
    results.push({
      entity,
      score: entry.score,
      ranks: entry.ranks,
      matchedScopes: scopes.filter((prefix) => scopeMatchesAnyPrefix(entity.scopePath, [prefix])),
      graphPaths: getGraphPath(db, entry.id, { limit: 8 }),
    });
  }

  return { results, warnings, vectorRetrievalUsed };
}
