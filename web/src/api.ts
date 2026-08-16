/**
 * Typed fetch client for the WrongSynapse backend.
 *
 * All requests go to the same origin (the Node web server proxies nothing —
 * the SPA is served from web/dist/ and the API from the same port). Errors
 * are normalised into `ApiError` so components can branch on HTTP status
 * without inspecting the raw Response.
 */

const BASE = '';

export interface Stats {
  entities: number;
  relations: number;
  vectors: number;
  candidates: number;
  ftsRows: number;
  breakdown: { types: Record<string, number>; relations: Record<string, number> };
}

export interface MemorySummary {
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

export interface MemoryDetail extends MemorySummary {
  graph_paths: Array<{
    id: string;
    sourceId: string;
    sourceName: string;
    sourceType: string;
    relation: string;
    targetId: string;
    targetName: string;
    targetType: string;
    depth: number;
  }>;
}

export interface CandidateSummary {
  id: string;
  content: string;
  scope_path: string | null;
  extracted_from: string | null;
  confidence: number;
  status: string;
  created_at: number;
}

export interface MemoryGraph {
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    scope_path: string;
    confidence: number;
    position?: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    relation: string;
  }>;
}

/** One tri-hybrid search hit: the fused RRF score plus per-channel ranks. */
export interface SearchResult {
  score: number;
  ranks: { fts: number | null; vector: number | null; graph: number | null };
  matched_scopes: string[];
  entity: MemorySummary;
  graph_paths: Array<{ relation: string; source: string; target: string }>;
}

export interface SearchResponse {
  query: string;
  count: number;
  results: SearchResult[];
  warnings: string[];
  vector_retrieval_used: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // body wasn't JSON — keep the status-line message
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: (): Promise<{ ok: boolean; version: string }> =>
    request('/api/health'),

  stats: (): Promise<Stats> =>
    request('/api/stats'),

  listMemories: (params: { scope?: string; q?: string; limit?: number } = {}): Promise<{ count: number; memories: MemorySummary[] }> => {
    const search = new URLSearchParams();
    if (params.scope !== undefined) search.set('scope', params.scope);
    if (params.q !== undefined) search.set('q', params.q);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request(`/api/memory${qs === '' ? '' : `?${qs}`}`);
  },

  getMemory: (id: string): Promise<MemoryDetail> =>
    request(`/api/memory/${encodeURIComponent(id)}`),

  deleteMemory: (id: string): Promise<{ id: string; deleted: true }> =>
    request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listCandidates: (params: { status?: 'pending' | 'promoted' | 'discarded'; limit?: number } = {}): Promise<{ count: number; candidates: CandidateSummary[] }> => {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request(`/api/candidates${qs === '' ? '' : `?${qs}`}`);
  },

  memoryGraph: (limit = 500): Promise<MemoryGraph> =>
    request(`/api/graph/memory?limit=${String(limit)}`),

  search: (params: {
    q: string;
    scope?: string;
    types?: string[];
    limit?: number;
    vectorWeight?: number;
    lexicalWeight?: number;
    graphWeight?: number;
    graphDepth?: number;
  }): Promise<SearchResponse> => {
    const search = new URLSearchParams();
    search.set('q', params.q);
    if (params.scope !== undefined) search.set('scope', params.scope);
    for (const type of params.types ?? []) search.append('type', type);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.vectorWeight !== undefined) search.set('vector_weight', String(params.vectorWeight));
    if (params.lexicalWeight !== undefined) search.set('lexical_weight', String(params.lexicalWeight));
    if (params.graphWeight !== undefined) search.set('graph_weight', String(params.graphWeight));
    if (params.graphDepth !== undefined) search.set('graph_depth', String(params.graphDepth));
    return request(`/api/search?${search.toString()}`);
  },
};
