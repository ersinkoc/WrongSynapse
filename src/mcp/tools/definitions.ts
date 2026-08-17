/**
 * WrongSynapse MCP tool definitions and handlers.
 *
 * Tools:
 *  - synapse_index_workspace     scan + parse + embed + link a git workspace
 *  - synapse_hybrid_query        tri-hybrid RRF retrieval (FTS5 + vector + graph)
 *  - synapse_anchor_memory       store a memory linked to a scope
 *  - synapse_graph_neighbors     relational sub-graph traversal
 *  - synapse_record_observation  write an episodic memory candidate
 *  - synapse_promote_candidate   promote a candidate into a permanent memory
 *  - synapse_list_candidates     list the candidate pool by status
 *  - synapse_discard_candidate   discard a pending candidate (terminal)
 *  - synapse_remember            store a durable memory with auto-deduplication
 *  - synapse_recall              retrieve memories filtered by kind/importance/tags
 *  - synapse_memory_search       BM25 + semantic search over memory entries
 *  - synapse_link_memories       link two memories with a SUPERSEDES relation
 *  - synapse_purge_expired       delete time-expired memory entries
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  getCandidate,
  getEntities,
  getEntity,
  getEntityByScope,
  getGraphPath,
  getNeighbors,
  insertCandidate,
  insertEntity,
  insertRelation,
  listCandidates,
  setCandidateStatus,
  touchMemory,
  upsertVector,
  findMemories,
  deleteExpiredMemories,
  findSimilarMemories,
  mergeMemories,
} from '../../db/queries.js';

import { hybridSearch } from '../../engine/hybrid-search.js';
import { indexWorkspace } from '../../engine/parser.js';
import { parseScope } from '../../utils/scope.js';
import { jsonResult, type ToolArgs, type ToolContext, type ToolDefinition } from './index.js';

// ---------------------------------------------------------------------------
// Arg coercion helpers
// ---------------------------------------------------------------------------

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`'${key}' must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('expected an array of strings');
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Parse a `scopes` argument upfront. An invalid scope would otherwise surface
 * mid-pipeline (scopeMatchesAnyPrefix → parseScope throws deep inside hybrid
 * search / the web handler's 500) instead of as a clean parameter error.
 */
function validatedScopes(value: unknown): string[] {
  const scopes = stringArray(value);
  for (const scope of scopes) parseScope(scope);
  return scopes;
}

function numberArg(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('expected a finite number');
  }
  return Math.min(max, Math.max(min, value));
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(numberArg(value, fallback, min, max));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Embed `text` and upsert the vector, reporting WHY the semantic channel
 * degraded instead of a bare `embedded: false` (embed() awaits init()
 * internally, so no explicit init() here).
 */
async function embedOrReport(
  ctx: ToolContext,
  entityId: string,
  text: string,
): Promise<{ embedded: boolean; embedError: string | null }> {
  try {
    upsertVector(ctx.db, entityId, await ctx.embedder.embed(text));
    return { embedded: true, embedError: null };
  } catch (error) {
    return { embedded: false, embedError: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// Anchor targets are the structural entities at a scope (a symbol, file,
// package, dir, project, or commit) — not other memories sharing the scope.
const STRUCTURAL_TARGET_TYPES: readonly string[] = [
  'file',
  'symbol',
  'package',
  'directory',
  'project',
  'commit',
];

const indexWorkspaceTool: ToolDefinition = {
  name: 'synapse_index_workspace',
  description:
    'Scan a workspace directory, parse its structure and AST symbols (TypeScript, JavaScript, Python, Go, Rust), ' +
    'generate vector embeddings, optionally link git commits, and persist the hierarchy into the WrongSynapse graph.',
  inputSchema: z.object({
    workspace_path: z.string().describe('Absolute path of the workspace to index.'),
    options: z
      .object({
        parse_ast: z.boolean().describe('Extract AST symbols with tree-sitter (default true).').optional(),
        include_git_history: z.boolean().describe('Link recent git commits and changed files (default false).').optional(),
        depth: z.number().describe('Maximum directory depth to traverse (default 20).').optional(),
      })
      .describe('Optional tuning switches.')
      .optional(),
  }),
  handler: async (ctx, args) => {
    const workspacePath = requireString(args, 'workspace_path');
    const options = isRecord(args['options']) ? args['options'] : {};
    const result = await indexWorkspace(ctx.db, ctx.embedder, {
      workspacePath,
      parseAst: typeof options['parse_ast'] === 'boolean' ? options['parse_ast'] : undefined,
      includeGitHistory: typeof options['include_git_history'] === 'boolean' ? options['include_git_history'] : undefined,
      depth: intArg(options['depth'], 20, 1, 64),
    });
    return jsonResult(result);
  },
};

const hybridQueryTool: ToolDefinition = {
  name: 'synapse_hybrid_query',
  description:
    'Run tri-hybrid retrieval (FTS5/BM25 + semantic embeddings + knowledge-graph expansion) fused with ' +
    'Reciprocal Rank Fusion. Returns ranked entities with contextual graph paths and relevancy scores.',
  inputSchema: z.object({
    query: z.string().describe('Free-text query.'),
    scopes: z
      .array(z.string())
      .describe('Scope prefixes to restrict results to (e.g. "proj:app/file:src/auth").')
      .optional(),
    types: z
      .array(z.string())
      .describe('Entity types to include (file, symbol, memory_entry, ...).')
      .optional(),
    limit: z.number().describe('Maximum results (default 10).').optional(),
    vector_weight: z.number().describe('Semantic weight in RRF (default 1).').optional(),
    lexical_weight: z.number().describe('Lexical (BM25) weight in RRF (default 1).').optional(),
    graph_weight: z.number().describe('Graph-expansion weight in RRF (default 1).').optional(),
    graph_depth: z.number().describe('Graph traversal depth for expansion, 1..3 (default 1).').optional(),
  }),
  handler: async (ctx, args) => {
    const query = requireString(args, 'query');
    const scopes = validatedScopes(args['scopes']);
    const types = stringArray(args['types']);
    const limit = intArg(args['limit'], 10, 1, 50);
    const vectorWeight = numberArg(args['vector_weight'], 1, 0, 10);
    const lexicalWeight = numberArg(args['lexical_weight'], 1, 0, 10);
    const graphWeight = numberArg(args['graph_weight'], 1, 0, 10);
    const graphDepth = intArg(args['graph_depth'], 1, 1, 3);
    const output = await hybridSearch(ctx.db, ctx.embedder, {
      query,
      scopes,
      types,
      limit,
      vectorWeight,
      lexicalWeight,
      graphWeight,
      graphDepth,
    });
    const compact = output.results.map((result) => ({
      entity_id: result.entity.id,
      type: result.entity.type,
      scope_path: result.entity.scopePath,
      name: result.entity.name,
      content: truncate(result.entity.content, 500),
      confidence: result.entity.confidence,
      score: Math.round(result.score * 1e6) / 1e6,
      ranks: result.ranks,
      matched_scopes: result.matchedScopes,
      graph_paths: result.graphPaths.map((path) => ({
        relation: path.relation,
        source: path.sourceName,
        target: path.targetName,
      })),
    }));
    return jsonResult({
      results: compact,
      vector_retrieval_used: output.vectorRetrievalUsed,
      warnings: output.warnings,
    });
  },
};

const anchorMemoryTool: ToolDefinition = {
  name: 'synapse_anchor_memory',
  description:
    'Store an architectural decision, bug fix, or convention note and link it directly to a symbol, file, ' +
    'package, or project scope. Computes and stores its embedding.',
  inputSchema: z.object({
    content: z.string().describe('The memory content (decision, note, convention).'),
    target_scope: z
      .string()
      .describe('Scope URI the memory is anchored to (e.g. "proj:app/file:src/auth.ts/sym:validateToken").'),
    relation_type: z.string().describe('Relation type, default "ANCHORED_TO".').optional(),
    metadata: z.record(z.string(), z.unknown()).describe('Optional structured metadata.').optional(),
  }),
  handler: async (ctx, args) => {
    const content = requireString(args, 'content');
    const targetScope = requireString(args, 'target_scope');
    parseScope(targetScope); // validate
    const relationType = typeof args['relation_type'] === 'string' && args['relation_type'] !== '' ? args['relation_type'] : 'ANCHORED_TO';
    const metadata = isRecord(args['metadata']) ? args['metadata'] : null;
    const id = randomUUID();
    insertEntity(ctx.db, {
      id,
      type: 'memory_entry',
      scopePath: targetScope,
      name: content.slice(0, 80),
      content,
      // anchored_to LAST: caller metadata must not be able to overwrite the
      // marker that says which scope this memory was anchored to.
      metadata: { ...(metadata ?? {}), anchored_to: targetScope },
    });
    const target = getEntityByScope(ctx.db, targetScope, STRUCTURAL_TARGET_TYPES);
    if (target !== undefined) {
      insertRelation(ctx.db, { sourceId: id, targetId: target.id, relation: relationType });
    }
    const { embedded, embedError } = await embedOrReport(ctx, id, content);
    return jsonResult({
      entity_id: id,
      scope_path: targetScope,
      relation: relationType,
      anchored_to_entity_id: target?.id ?? null,
      embedded,
      embed_error: embedError,
    });
  },
};

const graphNeighborsTool: ToolDefinition = {
  name: 'synapse_graph_neighbors',
  description:
    'Return the relational sub-graph around an entity: what calls it, what it calls, which commit changed it, ' +
    'which memory rules apply to it, and its parent hierarchy.',
  inputSchema: z.object({
    entity_id: z.string().describe('Entity id or its exact scope path (e.g. "proj:app/file:src/auth.ts").'),
    depth: z.number().describe('Traversal depth (default 1, max 5).').optional(),
    direction: z.enum(['in', 'out', 'both']).describe('Edge direction (default both).').optional(),
    relation_filter: z
      .array(z.string())
      .describe('Only traverse edges with these relation types (e.g. ["CALLS", "ANCHORED_TO"]).')
      .optional(),
  }),
  handler: async (ctx, args) => {
    const entityId = requireString(args, 'entity_id');
    const depth = intArg(args['depth'], 1, 1, 5);
    const direction = args['direction'] === 'in' || args['direction'] === 'out' ? args['direction'] : 'both';
    const relationFilter = stringArray(args['relation_filter']);
    // The schema promises "entity id or its exact scope path": ids first,
    // then a typed scope lookup (structural entities win over memory entries
    // anchored at the same scope — getEntityByScope breaks ties on
    // updated_at DESC, which favors recently-written memories), then an
    // untyped fallback for non-structural types.
    const entity =
      getEntity(ctx.db, entityId) ??
      getEntityByScope(ctx.db, entityId, STRUCTURAL_TARGET_TYPES) ??
      getEntityByScope(ctx.db, entityId);
    if (entity === undefined) {
      throw new Error(`entity '${entityId}' not found`);
    }
    // Traverse by the RESOLVED id: when the caller passed a scope path, the
    // raw input is a URI, not a primary key.
    const neighbors = getNeighbors(ctx.db, entity.id, { depth, direction, relationFilter });
    // One chunked fetch for every neighbor instead of a SELECT per row.
    const neighborEntityById = getEntities(ctx.db, neighbors.map((neighbor) => neighbor.entityId));
    const neighborRows = neighbors.map((neighbor) => {
      // Relations are FK-bound to entities (cascade delete), so the neighbor
      // row always resolves; the lookup and its null fallbacks are defensive.
      /* v8 ignore start */
      const neighborEntity = neighborEntityById.get(neighbor.entityId);
      return {
        entity_id: neighbor.entityId,
        name: neighborEntity?.name ?? null,
        type: neighborEntity?.type ?? null,
        /* v8 ignore stop */
        relation: neighbor.relation,
        direction: neighbor.direction,
        depth: neighbor.depth,
      };
    });
    const paths = getGraphPath(ctx.db, entity.id, { relationFilter, limit: 20 });
    return jsonResult({
      entity: { id: entity.id, name: entity.name, type: entity.type, scope_path: entity.scopePath },
      neighbors: neighborRows,
      paths,
    });
  },
};

const recordObservationTool: ToolDefinition = {
  name: 'synapse_record_observation',
  description:
    'Write an uncommitted insight into the episodic memory candidate pool for later consolidation ' +
    '(does not alter the knowledge graph yet).',
  inputSchema: z.object({
    content: z.string().describe('The observation content.'),
    scope_path: z.string().describe('Optional scope URI the observation relates to.').optional(),
    confidence: z.number().describe('Confidence 0..1 (default 0.7).').optional(),
  }),
  handler: async (ctx, args) => {
    const content = requireString(args, 'content');
    const scopePath = typeof args['scope_path'] === 'string' && args['scope_path'] !== '' ? args['scope_path'] : null;
    if (scopePath !== null) parseScope(scopePath);
    const confidence = numberArg(args['confidence'], 0.7, 0, 1);
    const id = insertCandidate(ctx.db, {
      content,
      scopePath,
      extractedFrom: 'mcp:synapse_record_observation',
      confidence,
    });
    return jsonResult({ candidate_id: id, status: 'pending' });
  },
};

const promoteCandidateTool: ToolDefinition = {
  name: 'synapse_promote_candidate',
  description:
    'Promote a pending memory candidate into a permanent memory entity: computes its embedding and links it ' +
    'to the target scope.',
  inputSchema: z.object({
    candidate_id: z.string().describe('Candidate id returned by synapse_record_observation.'),
    target_scope: z.string().describe('Scope URI the promoted memory is anchored to.'),
  }),
  handler: async (ctx, args) => {
    const candidateId = requireString(args, 'candidate_id');
    const targetScope = requireString(args, 'target_scope');
    parseScope(targetScope);
    const candidate = getCandidate(ctx.db, candidateId);
    if (candidate === undefined) {
      throw new Error(`candidate '${candidateId}' not found`);
    }
    if (candidate.status === 'promoted') {
      throw new Error(`candidate '${candidateId}' is already promoted`);
    }
    if (candidate.status === 'discarded') {
      throw new Error(`candidate '${candidateId}' is discarded and cannot be promoted`);
    }
    const id = randomUUID();
    insertEntity(ctx.db, {
      id,
      type: 'memory_entry',
      scopePath: targetScope,
      name: candidate.content.slice(0, 80),
      content: candidate.content,
      metadata: { promoted_from: candidateId, source_confidence: candidate.confidence },
    });
    const target = getEntityByScope(ctx.db, targetScope, STRUCTURAL_TARGET_TYPES);
    if (target !== undefined) {
      insertRelation(ctx.db, { sourceId: id, targetId: target.id, relation: 'ANCHORED_TO' });
    }
    const { embedded, embedError } = await embedOrReport(ctx, id, candidate.content);
    setCandidateStatus(ctx.db, candidateId, 'promoted');
    return jsonResult({
      entity_id: id,
      scope_path: targetScope,
      promoted_candidate: candidateId,
      anchored_to_entity_id: target?.id ?? null,
      embedded,
      embed_error: embedError,
    });
  },
};

const listCandidatesTool: ToolDefinition = {
  name: 'synapse_list_candidates',
  description:
    'List memory candidates from the episodic pool, optionally filtered by status, newest first. ' +
    'Use this to review pending observations before promoting or discarding them.',
  inputSchema: z.object({
    status: z.enum(['pending', 'promoted', 'discarded']).describe('Filter by lifecycle status.').optional(),
    limit: z.number().describe('Maximum candidates to return (default 20, max 100).').optional(),
  }),
  handler: async (ctx, args) => {
    const status =
      args['status'] === 'pending' || args['status'] === 'promoted' || args['status'] === 'discarded'
        ? args['status']
        : undefined;
    const limit = intArg(args['limit'], 20, 1, 100);
    const candidates = listCandidates(ctx.db, { status, limit });
    return jsonResult({
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        content: truncate(candidate.content, 500),
        scope_path: candidate.scopePath,
        extracted_from: candidate.extractedFrom,
        confidence: candidate.confidence,
        status: candidate.status,
        created_at: candidate.createdAt,
      })),
      count: candidates.length,
    });
  },
};

const discardCandidateTool: ToolDefinition = {
  name: 'synapse_discard_candidate',
  description:
    'Discard a pending memory candidate (marks it discarded; it stays queryable by status but is no longer promotable). ' +
    'Completes the candidate lifecycle alongside synapse_promote_candidate.',
  inputSchema: z.object({
    candidate_id: z.string().describe('Candidate id returned by synapse_record_observation.'),
  }),
  handler: async (ctx, args) => {
    const candidateId = requireString(args, 'candidate_id');
    const candidate = getCandidate(ctx.db, candidateId);
    if (candidate === undefined) {
      throw new Error(`candidate '${candidateId}' not found`);
    }
    if (candidate.status === 'promoted') {
      throw new Error(`candidate '${candidateId}' is already promoted`);
    }
    if (candidate.status === 'discarded') {
      throw new Error(`candidate '${candidateId}' is already discarded`);
    }
    setCandidateStatus(ctx.db, candidateId, 'discarded');
    return jsonResult({ candidate_id: candidateId, status: 'discarded' });
  },
};

const VALID_MEMORY_KINDS = ['general', 'convention', 'decision', 'warning', 'bug_root_cause', 'fact', 'preference', 'workflow', 'anti_pattern', 'file_note', 'symbol_note', 'command_note'] as const;
type MemoryKind = typeof VALID_MEMORY_KINDS[number];

function memoryKindOf(value: unknown): string {
  const v = String(value ?? 'general');
  return VALID_MEMORY_KINDS.includes(v as MemoryKind) ? v : 'general';
}

/** WISDOM tool: persistent memory write. Stores a fact/convention/decision and anchors it to a scope. */
const rememberTool: ToolDefinition = {
  name: 'synapse_remember',
  description:
    'Store a durable fact, convention, decision, warning, or anti-pattern into long-term memory, ' +
    'linked to a file/symbol/package scope. Computes and stores a semantic embedding. ' +
    'Supports memory_kind (convention/decision/warning/bug_root_cause/fact/preference/workflow/anti_pattern/file_note/symbol_note/command_note), ' +
    'importance (0-1), TTL (seconds, optional), and tags for filtering.',
  inputSchema: z.object({
    text: z.string().describe('The memory content — one self-contained fact, decision, or convention.'),
    target_scope: z.string().describe('Scope URI to anchor this memory to (e.g. "proj:app/file:src/auth.ts/sym:validateToken").'),
    memory_kind: z.enum(VALID_MEMORY_KINDS as unknown as [string, ...string[]]).describe('Kind of memory: general, convention, decision, warning, bug_root_cause, fact, preference, workflow, anti_pattern, file_note, symbol_note, command_note. Default: general.').optional(),
    importance: z.number().min(0).max(1).describe('Importance 0-1 (affects retrieval ranking). Default 0.5.').optional(),
    ttl_seconds: z.number().int().positive().describe('Time-to-live in seconds. Omit for permanent memories.').optional(),
    tags: z.array(z.string()).max(10).describe('Tags for cross-cutting queries (e.g. "auth", "build", "testing"). Max 10.').optional(),
    relation_type: z.string().describe('Relation type, default "ANCHORED_TO".').optional(),
    metadata: z.record(z.string(), z.unknown()).describe('Optional structured metadata.').optional(),
  }),
  handler: async (ctx, args) => {
    const text = requireString(args, 'text');
    const targetScope = requireString(args, 'target_scope');
    parseScope(targetScope); // validate
    const memoryKind = memoryKindOf(args['memory_kind']);
    const importance = numberArg(args['importance'], 0.5, 0, 1);
    const ttlSeconds = intArg(args['ttl_seconds'], 0, 1, 1_000_000_000);
    const tags = stringArray(args['tags']).slice(0, 10);
    const relationType = typeof args['relation_type'] === 'string' && args['relation_type'] !== '' ? args['relation_type'] : 'ANCHORED_TO';
    const extraMetadata = isRecord(args['metadata']) ? args['metadata'] : null;
    const id = randomUUID();
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    insertEntity(ctx.db, {
      id,
      type: 'memory_entry',
      scopePath: targetScope,
      name: text.slice(0, 80),
      content: text,
      memoryKind,
      importance,
      expiresAt,
      tags,
      metadata: { ...(extraMetadata ?? {}), anchored_to: targetScope },
    });
    const target = getEntityByScope(ctx.db, targetScope, STRUCTURAL_TARGET_TYPES);
    if (target !== undefined) {
      insertRelation(ctx.db, { sourceId: id, targetId: target.id, relation: relationType });
    }
    const { embedded, embedError } = await embedOrReport(ctx, id, text);
    // Auto-deduplicate: if a near-identical memory_entry already exists
    // (cosine >= 0.85), merge the new entry into the existing one and discard
    // the new id. Merge keeps the winner's content but absorbs the loser's
    // tags, importance, and metadata. A SUPERSEDES edge records the chain so
    // retrieval can still resolve the old id.
    let mergedInto: string | null = null;
    let mergedSimilarity: number | null = null;
    if (embedError === null) {
      try {
        const winnerEmbedding = await ctx.embedder.embed(text);
        // Exclude the new id from the search — the new memory is guaranteed to
        // have cosine=1 with itself, which would always rank first and starve
        // every other match. The `findSimilarMemories` caller requests a
        // larger candidate set than the caller will accept, so we can filter
        // the self-match out safely without losing the next-best candidate.
        // Scope filter: only merge into a winner that shares the new memory's
        // targetScope prefix. Merging across scopes would archive the loser's
        // ANCHORED_TO edge against a scope the new memory never referenced —
        // callers that stored the original under that scope would lose its
        // anchor. scopeMatchesAnyPrefix is a single-prefix check here.
        const hits = findSimilarMemories(ctx.db, winnerEmbedding, 0.85, memoryKind, 50, [targetScope]);
        // Scope filter: the SQL scan above is already boundary-aware scope
        // filtered (equal scope OR descendant OR ancestor — the same predicate
        // hybrid-search uses), so only self-exclusion remains here. Merging
        // across scopes would archive the loser's ANCHORED_TO edge against a
        // scope the new memory never referenced — callers that stored the
        // original under that scope would lose its anchor.
        const winner = hits.find((hit) => hit.entityId !== id);
        if (winner !== undefined) {
          // mergeMemories returns false only for missing/same ids, which the
          // find above already excluded.
          /* v8 ignore next */
          if (mergeMemories(ctx.db, winner.entityId, id)) {
            mergedInto = winner.entityId;
            mergedSimilarity = winner.similarity;
          }
        }
      } catch {
        // Deduplication is best-effort; never break the remember call.
      }
    }
    return jsonResult({
      entity_id: mergedInto ?? id,
      scope_path: targetScope,
      memory_kind: memoryKind,
      importance,
      expires_at: expiresAt,
      tags,
      anchored_to_entity_id: target?.id ?? null,
      embedded,
      embed_error: embedError,
      merged_into: mergedInto,
      merged_similarity: mergedSimilarity,
    });
  },
};

/** ORIENT tool: retrieve memories filtered by kind, importance, tags, or scope prefix. Touches accessed memories. */
const recallTool: ToolDefinition = {
  name: 'synapse_recall',
  description:
    'Retrieve memories filtered by kind, importance, tags, or scope prefix. ' +
    'Automatically updates last_accessed_at (access tracking). ' +
    'Use after hybrid_search to narrow results by category.',
  inputSchema: z.object({
    scopes: z.array(z.string()).describe('Scope prefixes to restrict results to.').optional(),
    memory_kinds: z.array(z.enum(VALID_MEMORY_KINDS as unknown as [string, ...string[]])).describe('Memory kinds to include.').optional(),
    importance_min: z.number().min(0).max(1).describe('Minimum importance filter (0-1).').optional(),
    tags: z.array(z.string()).describe('Tags — memory must contain all of these.').optional(),
    include_expired: z.boolean().describe('Include expired memories (default false).').optional(),
    limit: z.number().int().positive().describe('Maximum results (default 20, max 200).').optional(),
  }),
  handler: async (ctx, args) => {
    const scopes = validatedScopes(args['scopes']);
    const memoryKinds = (args['memory_kinds'] as unknown as string[] | undefined)?.map(memoryKindOf) ?? [];
    const importanceMin = numberArg(args['importance_min'], 0, 0, 1);
    const tags = stringArray(args['tags']);
    const includeExpired = args['include_expired'] === true;
    const limit = intArg(args['limit'], 20, 1, 200);
    const memories = findMemories(ctx.db, { scopePrefixes: scopes, memoryKinds, importanceMin, tags, includeExpired, limit });
    for (const m of memories) touchMemory(ctx.db, m.id);
    return jsonResult({
      memories: memories.map((m) => ({
        id: m.id,
        type: m.type,
        scope_path: m.scopePath,
        name: m.name,
        content: truncate(m.content, 500),
        memory_kind: m.memoryKind,
        importance: m.importance,
        expires_at: m.expiresAt,
        last_accessed_at: m.lastAccessedAt,
        tags: m.tags,
        confidence: m.confidence,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
      })),
      count: memories.length,
    });
  },
};

/** SEARCH tool: full-text + semantic + graph hybrid search over all entities, with memory_kind/type filters. */
const searchTool: ToolDefinition = {
  name: 'synapse_memory_search',
  description:
    'Full tri-hybrid search (FTS5/BM25 + semantic embeddings + knowledge-graph expansion) over all entities, ' +
    'filtered by memory_kind or entity type. ' +
    'Returns ranked results with per-channel ranks and graph paths.',
  inputSchema: z.object({
    query: z.string().describe('Free-text query.'),
    scopes: z.array(z.string()).describe('Scope prefixes to restrict results to.').optional(),
    memory_kinds: z.array(z.enum(VALID_MEMORY_KINDS as unknown as [string, ...string[]])).describe('Memory kinds to include.').optional(),
    types: z.array(z.string()).describe('Entity types to include (file, symbol, memory_entry, ...).').optional(),
    limit: z.number().int().positive().describe('Maximum results (default 10, max 50).').optional(),
    vector_weight: z.number().describe('Semantic weight in RRF (default 1).').optional(),
    lexical_weight: z.number().describe('Lexical (BM25) weight in RRF (default 1).').optional(),
    graph_weight: z.number().describe('Graph-expansion weight in RRF (default 1).').optional(),
    graph_depth: z.number().int().min(1).max(3).describe('Graph traversal depth (default 1).').optional(),
  }),
  handler: async (ctx, args) => {
    const query = requireString(args, 'query');
    const scopes = validatedScopes(args['scopes']);
    const memoryKinds = (args['memory_kinds'] as unknown as string[] | undefined)?.map(memoryKindOf) ?? [];
    const types = stringArray(args['types']);
    const limit = intArg(args['limit'], 10, 1, 50);
    const vectorWeight = numberArg(args['vector_weight'], 1, 0, 10);
    const lexicalWeight = numberArg(args['lexical_weight'], 1, 0, 10);
    const graphWeight = numberArg(args['graph_weight'], 1, 0, 10);
    const graphDepth = intArg(args['graph_depth'], 1, 1, 3);

    // Filter by memory_kind via post-hoc filter on hybrid results.
    // We over-fetch from hybridSearch by the number of requested kinds so the
    // post-filter never shrinks the result set below the requested `limit`
    // when only a subset of kinds match. The fetch cap stays bounded at
    // MAX_CANDIDATES (100) per channel; the over-fetch multiplier is the
    // ratio of requested-to-valid kinds (12 total). For a single-kind query
    // the multiplier is small; for an empty query it is 1.
    const memoryKindsForFetch =
      memoryKinds.length === 0 ? 1 : Math.min(12, Math.max(1, 12 / memoryKinds.length));
    const fetchLimit = Math.min(50 * memoryKindsForFetch, 200);
    const output = await hybridSearch(ctx.db, ctx.embedder, {
      query,
      scopes,
      types: types.length > 0 ? types : undefined,
      limit: fetchLimit,
      vectorWeight,
      lexicalWeight,
      graphWeight,
      graphDepth,
    });

    let results = output.results.map((result) => ({
      entity_id: result.entity.id,
      type: result.entity.type,
      scope_path: result.entity.scopePath,
      name: result.entity.name,
      content: truncate(result.entity.content, 500),
      memory_kind: result.entity.memoryKind,
      importance: result.entity.importance,
      tags: result.entity.tags,
      confidence: result.entity.confidence,
      score: Math.round(result.score * 1e6) / 1e6,
      ranks: result.ranks,
      matched_scopes: result.matchedScopes,
      graph_paths: result.graphPaths.map((path) => ({
        relation: path.relation,
        source: path.sourceName,
        target: path.targetName,
      })),
    }));

    // Apply memory_kind filter post-hoc (memoryKinds not in hybridSearch types)
    if (memoryKinds.length > 0) {
      results = results.filter((r) => memoryKinds.includes(r.memory_kind));
    }

    // Touch accessed memories
    for (const r of results.slice(0, limit)) touchMemory(ctx.db, r.entity_id);

    return jsonResult({
      query,
      count: results.length,
      results: results.slice(0, limit),
      warnings: output.warnings,
      vector_retrieval_used: output.vectorRetrievalUsed,
    });
  },
};

/** Memory linking: link a newer memory as superseding an older one (version chain). */
const linkMemoriesTool: ToolDefinition = {
  name: 'synapse_link_memories',
  description:
    'Link two memory entries with a SUPERSEDES relation — declares that the target memory is newer/better ' +
    'and the source should be considered archived. Useful for version chains, corrections, and updates.',
  inputSchema: z.object({
    source_id: z.string().describe('Memory entity id that is being superseded (the old one).'),
    target_id: z.string().describe('Memory entity id that supersedes the source (the new one).'),
    bidirectional: z.boolean().describe('Also link target back to source with SUPERSEDED_BY (default false).').optional(),
  }),
  handler: async (ctx, args) => {
    const sourceId = requireString(args, 'source_id');
    const targetId = requireString(args, 'target_id');
    if (sourceId === targetId) throw new Error('source_id and target_id must differ');
    const source = getEntity(ctx.db, sourceId);
    if (source === undefined) throw new Error(`memory '${sourceId}' not found`);
    const target = getEntity(ctx.db, targetId);
    if (target === undefined) throw new Error(`memory '${targetId}' not found`);
    if (source.type !== 'memory_entry') throw new Error(`entity '${sourceId}' is not a memory_entry`);
    if (target.type !== 'memory_entry') throw new Error(`entity '${targetId}' is not a memory_entry`);
    // Schema convention: source_id is the OLD memory being archived, target_id is
    // the NEWER replacement. The SUPERSEDES edge flows from the new (winner) to
    // the old (loser) so retrieval chains can be walked from any current memory
    // back through its superseded ancestors. The handler argument names are
    // preserved (sourceId/targetId mean "old/new"); the relation direction
    // inserts from targetId → sourceId.
    insertRelation(ctx.db, { sourceId: targetId, targetId: sourceId, relation: 'SUPERSEDES', weight: 1.0 });
    if (args['bidirectional'] === true) {
      // Inverse of SUPERSEDES: sourceId (the old memory) → targetId (the new one),
      // so callers can walk the chain forward from any archived entry to its
      // replacement. The previous implementation used targetId → sourceId,
      // which duplicated SUPERSEDES and never produced the promised inverse.
      insertRelation(ctx.db, { sourceId: sourceId, targetId: targetId, relation: 'SUPERSEDED_BY', weight: 1.0 });
    }
    return jsonResult({
      relation: 'SUPERSEDES',
      source_id: sourceId,
      target_id: targetId,
      bidirectional: args['bidirectional'] === true,
    });
  },
};

/** Cleanup: delete all expired memory entries. */
const purgeExpiredTool: ToolDefinition = {
  name: 'synapse_purge_expired',
  description:
    'Delete all expired memory entries (those whose expires_at timestamp has passed). ' +
    'Returns the count of deleted entries. Safe to call periodically.',
  inputSchema: z.object({}),
  handler: async (ctx, _args) => {
    const deleted = deleteExpiredMemories(ctx.db);
    return jsonResult({ deleted, message: `${deleted} expired memory entry(ies) removed.` });
  },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  indexWorkspaceTool,
  hybridQueryTool,
  anchorMemoryTool,
  graphNeighborsTool,
  recordObservationTool,
  promoteCandidateTool,
  listCandidatesTool,
  discardCandidateTool,
  rememberTool,
  recallTool,
  searchTool,
  linkMemoriesTool,
  purgeExpiredTool,
];
