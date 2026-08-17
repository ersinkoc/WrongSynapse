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
  countVectors,
  getEntities,
  getGraphPath,
  getNeighbors,
  getVectors,
  searchFts,
  type EntityRow,
  type GraphPathEdge,
} from '../db/queries.js';
import { scopeMatchesAnyPrefix } from '../utils/scope.js';
import { cosineSimilarity, embeddingToBuffer } from './vector-math.js';
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
  const ftsHits = searchFts(db, query, MAX_CANDIDATES);
  // One chunked IN(...) fetch for every FTS hit instead of a SELECT per row.
  const ftsEntityById = getEntities(db, ftsHits.map((hit) => hit.entityId));
  for (const hit of ftsHits) {
    // FK cascades delete FTS rows with their entities, so a missing entity
    // here is not producible through the public API.
    const entity = ftsEntityById.get(hit.entityId);
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

  // ---- 2. Semantic (exact cosine scan, or sqlite-vec KNN on large corpora) --
  const vecRanked: string[] = [];
  let vectorRetrievalUsed = false;
  if (vectorWeight > 0) {
    try {
      await embedder.init();
      const queryVec = await embedder.embed(query);
      const dbVec = (db as SynapseDbWithVec).vec;

      // Exact scan: one pass over the BLOB vectors, scope/type filtered in
      // SQL. For corpora up to VECTOR_SCAN_CAP this is both complete and
      // cheaper than consulting a vec0 index, so KNN is only engaged past
      // that size.
      const exactCosineScan = (): string[] => {
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
          // so every candidate here is fresh.
          if (candidate.embedding.length !== queryVec.length) continue; // dimension mismatch: skip
          scored.push({ id: candidate.entityId, score: cosineSimilarity(queryVec, candidate.embedding) });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_CANDIDATES).map((entry) => entry.id);
      };

      const totalVectors = countVectors(db);
      // KNN only pays off past the exact-scan cap; below it the scan is
      // complete AND scope-filtered in SQL, so it is at least as accurate.
      const useAnn = dbVec?.indexReady === true && totalVectors > VECTOR_SCAN_CAP;
      if (useAnn) {
        // --- sqlite-vec vec0 KNN (brute-force in C over the packed index) ---
        try {
          // vec0 accepts the query vector as a packed float32 BLOB parameter
          // and k as a bound integer. Fetch a large batch to reduce the
          // "global neighbors are out-of-scope" gap; sqlite-vec has no OFFSET.
          const topK = MAX_CANDIDATES * 20;
          const rows = db
            .prepare('SELECT entity_id FROM vec_entities WHERE embedding match ? AND k = ?')
            .all(embeddingToBuffer(queryVec), topK) as { entity_id: string }[];
          const entityById = getEntities(db, rows.map((row) => row.entity_id));
          const seen = new Set<string>();
          for (const row of rows) {
            /* v8 ignore next -- vec0 KNN never returns an id twice; dedupe guard */
            if (seen.has(row.entity_id)) continue;
            seen.add(row.entity_id);
            const entity = entityById.get(row.entity_id);
            if (entity === undefined) continue; // vec row outlived its entity mid-query
            if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
            if (isExpired(entity, expiryNow)) continue;
            if (vecRanked.length < MAX_CANDIDATES) vecRanked.push(row.entity_id);
          }
        } catch (error) {
          // A missing/stale vec_entities must not kill the semantic channel —
          // degrade to the exact scan instead of returning lexical+graph only.
          warnings.push(`KNN query failed, falling back to exact cosine scan: ${describeError(error)}`);
        }
      }
      // Exact scan: small/medium corpora (primary path), and the safety net
      // when KNN is unavailable, failed, or its global neighbors were all
      // filtered out (extreme scope mismatch).
      if (!useAnn || vecRanked.length === 0) {
        vecRanked.push(...exactCosineScan());
      }
      vectorRetrievalUsed = true;
    } catch (error) {
      warnings.push(`semantic retrieval skipped: ${describeError(error)}`);
    }
  }

  // ---- 3. Graph expansion over seed entities -------------------------------
  const graphRanked: string[] = [];
  if (graphWeight > 0) {
    const seeds = [...ftsRanked.slice(0, SEED_LIMIT), ...vecRanked.slice(0, SEED_LIMIT)];
    if (seeds.length > 0) {
      const perSeed = seeds.map((seed) =>
        getNeighbors(db, seed, { depth: graphDepth, direction: 'both', maxNodes: NEIGHBOR_CAP }),
      );
      // One chunked entity fetch for every neighbor across all seeds instead
      // of a SELECT per (seed, neighbor) pair.
      const neighborIds: string[] = [];
      const seenIds = new Set<string>();
      for (const list of perSeed) {
        for (const neighbor of list) {
          if (seenIds.has(neighbor.entityId)) continue;
          seenIds.add(neighbor.entityId);
          neighborIds.push(neighbor.entityId);
        }
      }
      const entityById = getEntities(db, neighborIds);
      const graphScores = new Map<string, number>();
      for (const list of perSeed) {
        for (const neighbor of list) {
          const entity = entityById.get(neighbor.entityId);
          // FK cascades delete relations with their entities, so a missing
          // neighbor is not producible through the public API.
          /* v8 ignore next */
          if (entity === undefined) continue;
          if (isExpired(entity, expiryNow)) continue;
          if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
          graphScores.set(neighbor.entityId, (graphScores.get(neighbor.entityId) ?? 0) + 1 / (neighbor.depth + 1));
        }
      }
      const sorted = [...graphScores.entries()].sort((a, b) => b[1] - a[1]);
      for (const [id] of sorted) graphRanked.push(id);
    }
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
  const top = scored.slice(0, limit);
  const topEntityById = getEntities(db, top.map((entry) => entry.id));
  for (const entry of top) {
    // Entities in `scored` were joined from live rows; a missing row here
    // requires a concurrent delete between ranking and assembly.
    const entity = topEntityById.get(entry.id);
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
