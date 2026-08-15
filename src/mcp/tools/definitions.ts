/**
 * WrongSynapse MCP tool definitions and handlers.
 *
 * Tools:
 *  - synapse_index_workspace     scan + parse + embed + link git
 *  - synapse_hybrid_query        tri-hybrid RRF retrieval
 *  - synapse_anchor_memory       store a memory linked to a scope
 *  - synapse_graph_neighbors     relational sub-graph traversal
 *  - synapse_record_observation  write an episodic memory candidate
 *  - synapse_promote_candidate   promote a candidate into a permanent memory
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  getCandidate,
  getEntity,
  getEntityByScope,
  getGraphPath,
  getNeighbors,
  insertCandidate,
  insertEntity,
  insertRelation,
  setCandidateStatus,
  upsertVector,
} from '../../db/queries.js';
import { hybridSearch } from '../../engine/hybrid-search.js';
import { indexWorkspace } from '../../engine/parser.js';
import { parseScope } from '../../utils/scope.js';
import { jsonResult, type ToolArgs, type ToolDefinition } from './index.js';

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
      depth: typeof options['depth'] === 'number' ? options['depth'] : undefined,
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
  }),
  handler: async (ctx, args) => {
    const query = requireString(args, 'query');
    const scopes = stringArray(args['scopes']);
    const types = stringArray(args['types']);
    const limit = intArg(args['limit'], 10, 1, 50);
    const vectorWeight = numberArg(args['vector_weight'], 1, 0, 10);
    const lexicalWeight = numberArg(args['lexical_weight'], 1, 0, 10);
    const output = await hybridSearch(ctx.db, ctx.embedder, {
      query,
      scopes,
      types,
      limit,
      vectorWeight,
      lexicalWeight,
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
      metadata: { anchored_to: targetScope, ...(metadata ?? {}) },
    });
    const target = getEntityByScope(ctx.db, targetScope, STRUCTURAL_TARGET_TYPES);
    if (target !== undefined) {
      insertRelation(ctx.db, { sourceId: id, targetId: target.id, relation: relationType });
    }
    let embedded = false;
    try {
      await ctx.embedder.init();
      upsertVector(ctx.db, id, await ctx.embedder.embed(content));
      embedded = true;
    } catch {
      embedded = false;
    }
    return jsonResult({
      entity_id: id,
      scope_path: targetScope,
      relation: relationType,
      anchored_to_entity_id: target?.id ?? null,
      embedded,
    });
  },
};

const graphNeighborsTool: ToolDefinition = {
  name: 'synapse_graph_neighbors',
  description:
    'Return the relational sub-graph around an entity: what calls it, what it calls, which commit changed it, ' +
    'which memory rules apply to it, and its parent hierarchy.',
  inputSchema: z.object({
    entity_id: z.string().describe('Entity id (or scope path).'),
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
    const entity = getEntity(ctx.db, entityId);
    if (entity === undefined) {
      throw new Error(`entity '${entityId}' not found`);
    }
    const neighbors = getNeighbors(ctx.db, entityId, { depth, direction, relationFilter });
    const neighborRows = neighbors.map((neighbor) => {
      // Relations are FK-bound to entities (cascade delete), so the neighbor
      // row always resolves; the lookup and its null fallbacks are defensive.
      /* v8 ignore start */
      const neighborEntity = getEntity(ctx.db, neighbor.entityId);
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
    const paths = getGraphPath(ctx.db, entityId, { relationFilter, limit: 20 });
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
    let embedded = false;
    try {
      await ctx.embedder.init();
      upsertVector(ctx.db, id, await ctx.embedder.embed(candidate.content));
      embedded = true;
    } catch {
      embedded = false;
    }
    setCandidateStatus(ctx.db, candidateId, 'promoted');
    return jsonResult({
      entity_id: id,
      scope_path: targetScope,
      promoted_candidate: candidateId,
      anchored_to_entity_id: target?.id ?? null,
      embedded,
    });
  },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  indexWorkspaceTool,
  hybridQueryTool,
  anchorMemoryTool,
  graphNeighborsTool,
  recordObservationTool,
  promoteCandidateTool,
];
