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

import type { SynapseDatabase } from '../db/connection.js';
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
  const typesFilter = types.length > 0 ? [...types] : [];

  // ---- 1. Lexical (FTS5 / BM25) -------------------------------------------
  const ftsRanked: string[] = [];
  for (const hit of searchFts(db, query, MAX_CANDIDATES)) {
    const entity = getEntity(db, hit.entityId);
    if (entity === undefined) continue;
    if (!matchesFilters(entity.scopePath, entity.type, scopes, typesFilter)) continue;
    if (!ftsRanked.includes(hit.entityId)) ftsRanked.push(hit.entityId);
  }

  // ---- 2. Semantic (cosine over stored vectors) ----------------------------
  const vecRanked: string[] = [];
  let vectorRetrievalUsed = false;
  if (vectorWeight > 0) {
    try {
      await embedder.init();
      const queryVec = await embedder.embed(query);
      const candidates = getVectors(db, {
        scopePrefixes: scopes.length > 0 ? [...scopes] : undefined,
        types: typesFilter,
        limit: MAX_CANDIDATES,
      });
      const scored: { id: string; score: number }[] = [];
      for (const candidate of candidates) {
        if (!matchesFilters(candidate.scopePath, candidate.type, scopes, typesFilter)) continue;
        if (candidate.embedding.length !== queryVec.length) continue; // dimension mismatch: skip
        scored.push({ id: candidate.entityId, score: cosineSimilarity(queryVec, candidate.embedding) });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const entry of scored.slice(0, MAX_CANDIDATES)) vecRanked.push(entry.id);
      vectorRetrievalUsed = true;
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
    const entity = getEntity(db, entry.id);
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
