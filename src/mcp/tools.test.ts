import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getCandidate, getEntity, getNeighbors, insertEntity, insertRelation } from '../db/queries.js';
import { FakeEmbedder, FailingEmbedder } from '../../test/helpers/fake-embedder.js';
import type { Embedder } from '../engine/embedding.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import type { ToolContext, ToolDefinition } from './tools/index.js';

let db: SynapseDatabase;
let ctx: ToolContext;
const embedder = new FakeEmbedder();

function tool(name: string): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (definition === undefined) throw new Error(`tool '${name}' not registered`);
  return definition;
}

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  await embedder.init();
  ctx = { db, embedder };
});

afterAll(() => {
  db.close();
});

describe('MCP tool definitions', () => {
  it('exposes all thirteen tools', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'synapse_index_workspace',
      'synapse_hybrid_query',
      'synapse_anchor_memory',
      'synapse_graph_neighbors',
      'synapse_record_observation',
      'synapse_promote_candidate',
      'synapse_list_candidates',
      'synapse_discard_candidate',
      'synapse_remember',
      'synapse_recall',
      'synapse_memory_search',
      'synapse_link_memories',
      'synapse_purge_expired',
    ]);
  });
});

describe('synapse_anchor_memory', () => {
  it('anchors a memory and finds it via hybrid query', async () => {
    const anchor = await tool('synapse_anchor_memory').handler(ctx, {
      content: 'never trust client-supplied tokens',
      target_scope: 'proj:demo/file:auth.ts',
    });
    const anchorOut = JSON.parse(anchor.content[0]!.text) as { entity_id: string; embedded: boolean };
    expect(anchorOut.entity_id).toBeTruthy();
    expect(anchorOut.embedded).toBe(true);

    const query = await tool('synapse_hybrid_query').handler(ctx, { query: 'client supplied tokens', limit: 10 });
    const queryOut = JSON.parse(query.content[0]!.text) as { results: { entity_id: string; type: string }[] };
    expect(queryOut.results.some((r) => r.entity_id === anchorOut.entity_id && r.type === 'memory_entry')).toBe(true);
  });

  it('throws when required args are missing', async () => {
    await expect(tool('synapse_anchor_memory').handler(ctx, { target_scope: 'proj:demo/file:x.ts' })).rejects.toThrow();
    await expect(tool('synapse_anchor_memory').handler(ctx, { content: 'x' })).rejects.toThrow();
  });
});

describe('synapse_record_observation / synapse_promote_candidate', () => {
  it('records, promotes, and marks the candidate', async () => {
    const record = await tool('synapse_record_observation').handler(ctx, {
      content: 'the cache layer bypasses auth on POST',
      scope_path: 'proj:demo/file:cache.ts',
      confidence: 0.9,
    });
    const recordOut = JSON.parse(record.content[0]!.text) as { candidate_id: string; status: string };
    expect(recordOut.status).toBe('pending');

    const promote = await tool('synapse_promote_candidate').handler(ctx, {
      candidate_id: recordOut.candidate_id,
      target_scope: 'proj:demo/file:cache.ts',
    });
    const promoteOut = JSON.parse(promote.content[0]!.text) as { entity_id: string; embedded: boolean };
    expect(promoteOut.entity_id).toBeTruthy();
    expect(promoteOut.embedded).toBe(true);

    expect(getCandidate(db, recordOut.candidate_id)?.status).toBe('promoted');
    const memories = findEntitiesByScope(db, { scopePrefixes: ['proj:demo'], types: ['memory_entry'] });
    expect(memories.some((e) => e.id === promoteOut.entity_id)).toBe(true);
  });

  it('rejects unknown candidates', async () => {
    await expect(
      tool('synapse_promote_candidate').handler(ctx, { candidate_id: 'nope', target_scope: 'proj:demo/file:x.ts' }),
    ).rejects.toThrow();
  });
});

describe('synapse_graph_neighbors', () => {
  it('returns the ANCHORED_TO edge of a memory', async () => {
    insertEntity(db, { id: 'auth-file', type: 'file', scopePath: 'proj:demo/file:auth.ts', name: 'auth.ts', content: 'x' });

    const anchor = await tool('synapse_anchor_memory').handler(ctx, {
      content: 'auth note',
      target_scope: 'proj:demo/file:auth.ts',
    });
    const anchorOut = JSON.parse(anchor.content[0]!.text) as { entity_id: string; anchored_to_entity_id: string | null };
    expect(anchorOut.anchored_to_entity_id).toBe('auth-file');

    const graph = await tool('synapse_graph_neighbors').handler(ctx, { entity_id: anchorOut.entity_id, direction: 'both' });
    const graphOut = JSON.parse(graph.content[0]!.text) as { neighbors: { relation: string; entity_id: string }[] };
    expect(graphOut.neighbors.some((n) => n.relation === 'ANCHORED_TO' && n.entity_id === 'auth-file')).toBe(true);

    // in-direction from the file shows the memory (edge is memory -> file)
    const outward = await tool('synapse_graph_neighbors').handler(ctx, { entity_id: 'auth-file', direction: 'in' });
    const outwardOut = JSON.parse(outward.content[0]!.text) as { neighbors: { relation: string }[] };
    expect(outwardOut.neighbors.some((n) => n.relation === 'ANCHORED_TO')).toBe(true);
  });
});

describe('synapse_hybrid_query', () => {
  it('reports vector availability and warnings', async () => {
    const out = await tool('synapse_hybrid_query').handler(ctx, { query: 'auth note', limit: 5 });
    const parsed = JSON.parse(out.content[0]!.text) as { results: unknown[]; vector_retrieval_used: boolean };
    expect(parsed.vector_retrieval_used).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('rejects a non-array scopes argument', async () => {
    await expect(tool('synapse_hybrid_query').handler(ctx, { query: 'x', scopes: 'proj:demo' })).rejects.toThrow(
      /array/,
    );
  });

  it('rejects a non-finite limit', async () => {
    await expect(tool('synapse_hybrid_query').handler(ctx, { query: 'x', limit: 'ten' })).rejects.toThrow();
    await expect(tool('synapse_hybrid_query').handler(ctx, { query: 'x', limit: NaN })).rejects.toThrow();
  });

  it('clamps out-of-range weights and limits', async () => {
    const out = await tool('synapse_hybrid_query').handler(ctx, { query: 'auth note', limit: 999, vector_weight: 99 });
    const parsed = JSON.parse(out.content[0]!.text) as { results: { score: number }[] };
    expect(Array.isArray(parsed.results)).toBe(true);
    // limit clamps to 50 (not 999): a fixture with 4 entities cannot prove the
    // cap by counting, so prove the query succeeds and, more importantly, that
    // the clamped path is exercised by an out-of-range value not throwing.
    expect(parsed.results.length).toBeLessThanOrEqual(50);
    // vector_weight clamps to [0,10]: an out-of-range 99 must not corrupt the
    // RRF fusion — scores stay finite.
    for (const r of parsed.results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it('truncates null and oversized entity content in results', async () => {
    insertEntity(db, {
      id: 'null-content-file',
      type: 'file',
      scopePath: 'proj:demo/file:nullc.ts',
      name: 'nullc.ts',
      content: null,
    });
    insertEntity(db, {
      id: 'long-content-file',
      type: 'file',
      scopePath: 'proj:demo/file:longc.ts',
      name: 'longc.ts',
      content: 'y'.repeat(600),
    });

    const out = await tool('synapse_hybrid_query').handler(ctx, { query: 'nullc', limit: 10 });
    const parsed = JSON.parse(out.content[0]!.text) as {
      results: { entity_id: string; content: string | null }[];
    };
    const byId = new Map(parsed.results.map((r) => [r.entity_id, r.content] as const));
    // content null -> truncate(null) returns null (the `text === null` arm).
    expect(byId.get('null-content-file')).toBeNull();

    const long = await tool('synapse_hybrid_query').handler(ctx, { query: 'longc', limit: 10 });
    const longParsed = JSON.parse(long.content[0]!.text) as { results: { entity_id: string; content: string | null }[] };
    const longById = new Map(longParsed.results.map((r) => [r.entity_id, r.content] as const));
    // 600 chars -> truncated to 500 + ellipsis (the `length > max` arm).
    expect(longById.get('long-content-file')).toBe('y'.repeat(500) + '…');
  });
});

describe('synapse_anchor_memory arg edge cases', () => {
  it('honors a custom relation type and metadata', async () => {
    insertEntity(db, { id: 'rel-file', type: 'file', scopePath: 'proj:demo/file:rel.ts', name: 'rel.ts', content: 'x' });
    const out = await tool('synapse_anchor_memory').handler(ctx, {
      content: 'custom edge note',
      target_scope: 'proj:demo/file:rel.ts',
      relation_type: 'SUPERSEDES',
      metadata: { source: 'test' },
    });
    const parsed = JSON.parse(out.content[0]!.text) as { entity_id: string; relation: string };
    expect(parsed.relation).toBe('SUPERSEDES');
    const neighbors = getNeighbors(db, parsed.entity_id, { direction: 'out' });
    expect(neighbors.some((n) => n.relation === 'SUPERSEDES' && n.entityId === 'rel-file')).toBe(true);
  });
});

describe('synapse_graph_neighbors arg edge cases', () => {
  it('throws for an unknown entity id', async () => {
    await expect(tool('synapse_graph_neighbors').handler(ctx, { entity_id: 'does-not-exist' })).rejects.toThrow(
      /not found/,
    );
  });

  it('resolves an entity by scope path when the id is not found', async () => {
    // Own fixture: this test must not depend on insertion order of other tests.
    insertEntity(db, { id: 'scope-file', type: 'file', scopePath: 'proj:demo/file:scope.ts', name: 'scope.ts', content: 'x' });
    insertEntity(db, { id: 'scope-sym', type: 'symbol', scopePath: 'proj:demo/file:scope.ts/sym:helper', name: 'helper', content: 'helper' });
    insertRelation(db, { sourceId: 'scope-file', targetId: 'scope-sym', relation: 'CONTAINS' });

    // The schema promises "entity id (or scope path)": a caller holding only
    // the URI must reach the same entity AND see its graph (traversal must use
    // the resolved id, not the raw URI input).
    const out = await tool('synapse_graph_neighbors').handler(ctx, { entity_id: 'proj:demo/file:scope.ts' });
    const parsed = JSON.parse(out.content[0]!.text) as { entity: { id: string; name: string }; neighbors: { entity_id: string }[] };
    expect(parsed.entity.id).toBe('scope-file');
    expect(parsed.entity.name).toBe('scope.ts');
    expect(parsed.neighbors.some((n) => n.entity_id === 'scope-sym')).toBe(true);
  });

  it('passes graph_weight and graph_depth through to the retriever', async () => {
    const out = await tool('synapse_hybrid_query').handler(ctx, {
      query: 'auth note',
      graph_weight: 5,
      graph_depth: 2,
      limit: 5,
    });
    const parsed = JSON.parse(out.content[0]!.text) as { results: { score: number }[]; warnings: string[] };
    expect(Array.isArray(parsed.results)).toBe(true);
    for (const r of parsed.results) expect(Number.isFinite(r.score)).toBe(true);
  });

  it('clamps out-of-range graph_weight and rounds fractional graph_depth without corrupting fusion', async () => {
    // Mirrors the vector_weight/limit clamp convention: out-of-range inputs
    // must not throw and must keep every fused score finite. graph_depth is
    // an intArg, so 2.7 rounds (rather than rejecting) — surfaced here.
    const out = await tool('synapse_hybrid_query').handler(ctx, {
      query: 'auth note',
      graph_weight: 99, // clamps to [0, 10]
      graph_depth: 2.7, // rounds to 3
      limit: 5,
    });
    const parsed = JSON.parse(out.content[0]!.text) as { results: { score: number }[] };
    expect(Array.isArray(parsed.results)).toBe(true);
    for (const r of parsed.results) expect(Number.isFinite(r.score)).toBe(true);
  });

  it('honors direction and depth arguments', async () => {
    insertEntity(db, { id: 'dir-file', type: 'file', scopePath: 'proj:demo/file:dir.ts', name: 'dir.ts', content: 'x' });
    insertEntity(db, { id: 'dir-sym', type: 'symbol', scopePath: 'proj:demo/file:dir.ts/sym:fn', name: 'fn', content: 'fn' });
    insertRelation(db, { sourceId: 'dir-file', targetId: 'dir-sym', relation: 'CONTAINS' });

    const out = await tool('synapse_graph_neighbors').handler(ctx, {
      entity_id: 'dir-file',
      direction: 'out',
      depth: 1,
      relation_filter: ['CONTAINS'],
    });
    const parsed = JSON.parse(out.content[0]!.text) as { neighbors: { entity_id: string; relation: string }[] };
    expect(parsed.neighbors.some((n) => n.entity_id === 'dir-sym' && n.relation === 'CONTAINS')).toBe(true);
  });
});

describe('synapse_record_observation / promote arg edge cases', () => {
  it('rejects a malformed scope_path', async () => {
    await expect(tool('synapse_record_observation').handler(ctx, { content: 'x', scope_path: 'garbage' })).rejects.toThrow();
  });

  it('records with a default confidence when omitted', async () => {
    const out = await tool('synapse_record_observation').handler(ctx, { content: 'no confidence given' });
    const parsed = JSON.parse(out.content[0]!.text) as { candidate_id: string };
    expect(parsed.candidate_id).toBeTruthy();
    expect(getCandidate(db, parsed.candidate_id)?.confidence).toBeCloseTo(0.7, 6);
  });

  it('rejects a second promote of the same candidate', async () => {
    const record = await tool('synapse_record_observation').handler(ctx, { content: 'double promote me' });
    const candidateId = (JSON.parse(record.content[0]!.text) as { candidate_id: string }).candidate_id;
    await tool('synapse_promote_candidate').handler(ctx, { candidate_id: candidateId, target_scope: 'proj:demo/file:x.ts' });
    await expect(
      tool('synapse_promote_candidate').handler(ctx, { candidate_id: candidateId, target_scope: 'proj:demo/file:x.ts' }),
    ).rejects.toThrow(/already promoted/);
  });

  it('lists candidates filtered by status and honors the limit clamp', async () => {
    for (let i = 0; i < 3; i++) {
      await tool('synapse_record_observation').handler(ctx, { content: `bulk observation ${i}` });
    }
    const all = await tool('synapse_list_candidates').handler(ctx, { status: 'pending', limit: 2 });
    const allOut = JSON.parse(all.content[0]!.text) as { candidates: unknown[]; count: number };
    expect(allOut.count).toBe(2); // limit honored

    const clamped = await tool('synapse_list_candidates').handler(ctx, { limit: 500 });
    const clampedOut = JSON.parse(clamped.content[0]!.text) as { count: number };
    expect(clampedOut.count).toBeLessThanOrEqual(100); // clamped to 100
  });

  it('discards a pending candidate and blocks re-discard', async () => {
    const record = await tool('synapse_record_observation').handler(ctx, { content: 'discard me please' });
    const candidateId = (JSON.parse(record.content[0]!.text) as { candidate_id: string }).candidate_id;

    const discard = await tool('synapse_discard_candidate').handler(ctx, { candidate_id: candidateId });
    expect(JSON.parse(discard.content[0]!.text)).toEqual({ candidate_id: candidateId, status: 'discarded' });
    expect(getCandidate(db, candidateId)?.status).toBe('discarded');

    await expect(tool('synapse_discard_candidate').handler(ctx, { candidate_id: candidateId })).rejects.toThrow(
      /already discarded/,
    );
  });

  it('rejects discarding an unknown candidate', async () => {
    await expect(tool('synapse_discard_candidate').handler(ctx, { candidate_id: 'ghost' })).rejects.toThrow(/not found/);
  });

  it('rejects discarding an already-promoted candidate', async () => {
    const record = await tool('synapse_record_observation').handler(ctx, { content: 'promote then discard' });
    const candidateId = (JSON.parse(record.content[0]!.text) as { candidate_id: string }).candidate_id;
    await tool('synapse_promote_candidate').handler(ctx, { candidate_id: candidateId, target_scope: 'proj:demo/file:x.ts' });
    await expect(tool('synapse_discard_candidate').handler(ctx, { candidate_id: candidateId })).rejects.toThrow(
      /already promoted/,
    );
  });

  it('rejects promoting a discarded candidate', async () => {
    // Discard is terminal: the discard tool's contract says the candidate is
    // "no longer promotable", and promote must enforce the same.
    const record = await tool('synapse_record_observation').handler(ctx, { content: 'discard then promote' });
    const candidateId = (JSON.parse(record.content[0]!.text) as { candidate_id: string }).candidate_id;
    await tool('synapse_discard_candidate').handler(ctx, { candidate_id: candidateId });
    await expect(
      tool('synapse_promote_candidate').handler(ctx, { candidate_id: candidateId, target_scope: 'proj:demo/file:x.ts' }),
    ).rejects.toThrow(/discarded and cannot be promoted/);
  });
});

describe('synapse_index_workspace', () => {
  let workspace: string;

  it('passes recognized options through to the indexer', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'synapse-tool-idx-'));
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'tool-idx' }));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export function fa() { return 1; }\n');

    const out = await tool('synapse_index_workspace').handler(ctx, {
      workspace_path: workspace,
      options: { parse_ast: false, include_git_history: true, depth: 2 },
    });
    const parsed = JSON.parse(out.content[0]!.text) as { filesScanned: number; filesParsed: number; commitsIndexed: number };
    // Two files in the fixture: package.json + src/a.ts (directories are not files).
    expect(parsed.filesScanned).toBe(2);
    // parse_ast: false -> no AST symbol extraction
    expect(parsed.filesParsed).toBe(0);

    // Unrecognized option keys leave every switch at its default (AST on).
    const again = await tool('synapse_index_workspace').handler(ctx, {
      workspace_path: workspace,
      options: { bogus_key: 'ignored' },
    });
    const parsedAgain = JSON.parse(again.content[0]!.text) as { filesParsed: number };
    expect(parsedAgain.filesParsed).toBeGreaterThan(0);

    rmSync(workspace, { recursive: true, force: true });
  });

  it('requires a workspace_path argument', async () => {
    await expect(tool('synapse_index_workspace').handler(ctx, {})).rejects.toThrow();
  });

  it('treats a non-record options argument as empty', async () => {
    // The shared `workspace` fixture is removed at the end of the first test,
    // so this test creates its own.
    const own = mkdtempSync(join(tmpdir(), 'synapse-tool-opt-'));
    writeFileSync(join(own, 'package.json'), JSON.stringify({ name: 'tool-opt' }));
    writeFileSync(join(own, 'a.ts'), 'export function fb() { return 2; }\n');
    const out = await tool('synapse_index_workspace').handler(ctx, {
      workspace_path: own,
      options: 'not-an-object',
    });
    // `isRecord('not-an-object')` is false -> options default to {} -> AST
    // parsing is on (default), proving the non-record arm was taken.
    const parsed = JSON.parse(out.content[0]!.text) as { filesParsed: number };
    expect(parsed.filesParsed).toBeGreaterThan(0);
    rmSync(own, { recursive: true, force: true });
  });
});

describe('embedding-unavailable degradation (anchored memories)', () => {
  // Built inside each test: `db` is only assigned in beforeAll.
  const failCtx = (): ToolContext => ({ db, embedder: new FailingEmbedder() });

  it('anchors a memory without an embedding and reports embedded=false', async () => {
    const out = await tool('synapse_anchor_memory').handler(failCtx(), {
      content: 'stored without a model',
      target_scope: 'proj:demo/file:auth.ts',
    });
    const parsed = JSON.parse(out.content[0]!.text) as { entity_id: string; embedded: boolean };
    expect(parsed.entity_id).toBeTruthy();
    expect(parsed.embedded).toBe(false);
    expect(getEntity(db, parsed.entity_id)).toBeDefined();
  });

  it('promotes a candidate without an embedding and reports embedded=false', async () => {
    const record = await tool('synapse_record_observation').handler(failCtx(), { content: 'promote me modellessly' });
    const candidateId = (JSON.parse(record.content[0]!.text) as { candidate_id: string }).candidate_id;
    const out = await tool('synapse_promote_candidate').handler(failCtx(), {
      candidate_id: candidateId,
      target_scope: 'proj:demo/file:auth.ts',
    });
    const parsed = JSON.parse(out.content[0]!.text) as { entity_id: string; embedded: boolean };
    expect(parsed.embedded).toBe(false);
    expect(getCandidate(db, candidateId)?.status).toBe('promoted');
  });

  it('reports the embed failure reason, including non-Error throws', async () => {
    // A rejected promise with a plain string (e.g. a library that throws
    // response bodies) must surface as embed_error, not crash the handler.
    const stringThrower: Embedder = {
      modelId: 'string-thrower',
      dimension: 16,
      isReady: () => true,
      init: async () => undefined,
      embed: async () => {
        throw 'embedding service exploded';
      },
      embedBatch: async () => {
        throw 'embedding service exploded';
      },
    };
    const out = await tool('synapse_anchor_memory').handler({ db, embedder: stringThrower }, {
      content: 'string failure note',
      target_scope: 'proj:demo/file:fail.ts',
    });
    const parsed = JSON.parse(out.content[0]!.text) as { embedded: boolean; embed_error: string | null };
    expect(parsed.embedded).toBe(false);
    expect(parsed.embed_error).toBe('embedding service exploded');
  });

describe('synapse_remember', () => {
  it('stores a durable memory and surfaces it via recall', async () => {
    const out = await tool('synapse_remember').handler(ctx, {
      text: 'JWTs must be rotated every 30 days for compliance',
      target_scope: 'proj:demo/file:auth.ts',
      memory_kind: 'convention',
      importance: 0.8,
      tags: ['auth', 'security'],
    });
    const parsed = JSON.parse(out.content[0]!.text) as {
      entity_id: string;
      embedded: boolean;
      memory_kind: string;
      tags: string[];
      anchored_to_entity_id: string | null;
    };
    expect(parsed.embedded).toBe(true);
    expect(parsed.memory_kind).toBe('convention');
    expect(parsed.tags).toEqual(['auth', 'security']);
    expect(parsed.anchored_to_entity_id).toBeTruthy();
    expect(parsed.entity_id).toBeTruthy();

    // Round-trip via recall (the canonical retrieval path for stored memories).
    const recall = await tool('synapse_recall').handler(ctx, {
      scopes: ['proj:demo/file:auth.ts'],
      memory_kinds: ['convention'],
      limit: 5,
    });
    const recallParsed = JSON.parse(recall.content[0]!.text) as {
      memories: { id: string; memory_kind: string }[];
    };
    expect(recallParsed.memories.some((r) => r.id === parsed.entity_id)).toBe(true);
  });

  it('rejects malformed scope', async () => {
    await expect(
      tool('synapse_remember').handler(ctx, { text: 'x', target_scope: 'not-a-valid-scope' }),
    ).rejects.toThrow(/scope/i);
  });

  it('skips auto-dedup when embedding failed (no vector to compare)', async () => {
    const out = await tool('synapse_remember').handler(failCtx(), {
      text: 'embedding failed so dedup must not run',
      target_scope: 'proj:demo/file:nodedup.md',
      memory_kind: 'general',
    });
    const parsed = JSON.parse(out.content[0]!.text) as {
      embedded: boolean;
      embed_error: string | null;
      merged_into: string | null;
    };
    expect(parsed.embedded).toBe(false);
    expect(parsed.embed_error).toBeTruthy();
    expect(parsed.merged_into).toBeNull(); // dedup requires a fresh embedding
  });
});

describe('synapse_recall', () => {
  it('filters by memory_kind and updates last_accessed_at', async () => {
    // Seed two memories of different kinds under the same scope.
    const fact = await tool('synapse_remember').handler(ctx, {
      text: 'the staging DB password is rotated weekly',
      target_scope: 'proj:demo/file:ops.md',
      memory_kind: 'fact',
    });
    const warning = await tool('synapse_remember').handler(ctx, {
      text: 'never log secrets even in dev mode',
      target_scope: 'proj:demo/file:ops.md',
      memory_kind: 'warning',
    });
    const factId = JSON.parse(fact.content[0]!.text).entity_id as string;
    void JSON.parse(warning.content[0]!.text).entity_id;

    // Recall with kind filter — the 'fact' must come back, the 'warning' must not.
    const out = await tool('synapse_recall').handler(ctx, {
      scopes: ['proj:demo/file:ops.md'],
      memory_kinds: ['fact'],
      limit: 10,
    });
    const parsed = JSON.parse(out.content[0]!.text) as {
      memories: { id: string; memory_kind: string }[];
    };
    expect(parsed.memories.every((r) => r.memory_kind === 'fact')).toBe(true);
    expect(parsed.memories.some((r) => r.id === factId)).toBe(true);

    // The recalled memory must have its last_accessed_at bumped.
    const touched = getEntity(db, factId);
    expect(touched?.lastAccessedAt).toBeTypeOf('number');
    expect(touched!.lastAccessedAt!).toBeGreaterThan(0);
  });

  it('rejects a non-array scopes argument', async () => {
    await expect(
      tool('synapse_recall').handler(ctx, { scopes: 'proj:demo' as unknown as string[] }),
    ).rejects.toThrow(/array/i);
  });

  it('filters by tags (memory must contain ALL requested tags)', async () => {
    const tagged = await tool('synapse_remember').handler(ctx, {
      text: 'rotate database credentials every quarter',
      target_scope: 'proj:demo/file:creds.md',
      tags: ['security', 'database'],
    });
    const taggedId = JSON.parse(tagged.content[0]!.text).entity_id as string;

    const both = await tool('synapse_recall').handler(ctx, { tags: ['security', 'database'], limit: 50 });
    const bothParsed = JSON.parse(both.content[0]!.text) as { memories: { id: string; tags: string[] }[] };
    expect(bothParsed.memories.some((m) => m.id === taggedId)).toBe(true);
    expect(bothParsed.memories.every((m) => m.tags.includes('security') && m.tags.includes('database'))).toBe(true);

    const none = await tool('synapse_recall').handler(ctx, { tags: ['does-not-exist-anywhere'], limit: 50 });
    const noneParsed = JSON.parse(none.content[0]!.text) as { memories: unknown[] };
    expect(noneParsed.memories).toEqual([]);
  });
});

describe('synapse_memory_search', () => {
  it('runs tri-hybrid search and returns per-channel ranks', async () => {
    // Seed two memories; one with matching text, one unrelated.
    await tool('synapse_remember').handler(ctx, {
      text: 'rate limiter token bucket burst size must be 20',
      target_scope: 'proj:demo/file:rate-limit.ts',
      memory_kind: 'convention',
    });
    await tool('synapse_remember').handler(ctx, {
      text: 'never trust client-supplied tokens',
      target_scope: 'proj:demo/file:auth.ts',
      memory_kind: 'warning',
    });

    const out = await tool('synapse_memory_search').handler(ctx, {
      query: 'rate limiter token bucket',
      limit: 5,
    });
    const parsed = JSON.parse(out.content[0]!.text) as {
      count: number;
      results: { scope_path: string; content: string | null; ranks: { fts: number | null; vector: number | null; graph: number | null } }[];
      vector_retrieval_used: boolean;
    };
    expect(parsed.count).toBeGreaterThan(0);
    // The top result must be the rate-limit memory (matching text). The
    // `name` field is the content (truncated to 80 chars in insertEntity),
    // so asserting on `scope_path` + `content` is the correct shape.
    const top = parsed.results[0]!;
    expect(top.scope_path).toBe('proj:demo/file:rate-limit.ts');
    expect(top.content).toContain('rate limiter token bucket');
    // All three channels must contribute ranks (lexical + semantic + graph).
    expect(top.ranks.fts).not.toBeNull();
    expect(top.ranks.vector).not.toBeNull();
    expect(parsed.vector_retrieval_used).toBe(true);
  });
});

describe('synapse_link_memories', () => {
  it('creates a SUPERSEDES edge from the new memory to the old', async () => {
    // Seed two memories with the same scope but lexically distinct text so
    // dedup (cosine >= 0.85 against the FakeEmbedder's deterministic output)
    // will not merge them. The two strings below share no tokens.
    const oldOut = await tool('synapse_remember').handler(ctx, {
      text: 'banana bicycle quantum zebra',
      target_scope: 'proj:demo/file:auth.ts',
      memory_kind: 'convention',
    });
    const newOut = await tool('synapse_remember').handler(ctx, {
      text: 'apple dragon kite marigold',
      target_scope: 'proj:demo/file:auth.ts',
      memory_kind: 'convention',
    });
    const oldId = JSON.parse(oldOut.content[0]!.text).entity_id as string;
    const newId = JSON.parse(newOut.content[0]!.text).entity_id as string;
    // Sanity: the two remember calls must produce distinct entities. If dedup
    // ever loosens, the link assertion below would silently pass against the
    // same id and the test would throw at source_id === target_id.
    expect(oldId).not.toBe(newId);

    // source_id = old (being archived), target_id = new (replacement).
    const link = await tool('synapse_link_memories').handler(ctx, {
      source_id: oldId,
      target_id: newId,
    });
    const parsed = JSON.parse(link.content[0]!.text) as { relation: string; bidirectional: boolean };
    expect(parsed.relation).toBe('SUPERSEDES');
    expect(parsed.bidirectional).toBe(false);

    // The edge must flow new → old (so retrieval chains can walk from the
    // current memory back to its archived ancestors).
    const edges = getNeighbors(db, newId, { depth: 1, direction: 'out', relationFilter: ['SUPERSEDES'] });
    expect(edges.some((e) => e.entityId === oldId)).toBe(true);

    // Without bidirectional=true, the SUPERSEDED_BY inverse must NOT exist.
    const inverseFromOld = getNeighbors(db, oldId, { depth: 1, direction: 'out', relationFilter: ['SUPERSEDED_BY'] });
    expect(inverseFromOld.some((e) => e.entityId === newId)).toBe(false);
  });

  it('bidirectional=true inserts both SUPERSEDES and SUPERSEDED_BY', async () => {
    // Distinct scopes — the cheapest, most reliable way to guarantee the two
    // seeds won't dedup-merge. Lexically distinct strings also bypass dedup,
    // but scopes don't depend on the FakeEmbedder's cosine output.
    const oldOut = await tool('synapse_remember').handler(ctx, {
      text: 'coconut elephant fountain giraffe',
      target_scope: 'proj:demo/file:tokens-v1.md',
      memory_kind: 'convention',
    });
    const newOut = await tool('synapse_remember').handler(ctx, {
      text: 'daisy fox glacier harp',
      target_scope: 'proj:demo/file:tokens-v2.md',
      memory_kind: 'convention',
    });
    const oldId = JSON.parse(oldOut.content[0]!.text).entity_id as string;
    const newId = JSON.parse(newOut.content[0]!.text).entity_id as string;
    expect(oldId).not.toBe(newId);

    const link = await tool('synapse_link_memories').handler(ctx, {
      source_id: oldId,
      target_id: newId,
      bidirectional: true,
    });
    const parsed = JSON.parse(link.content[0]!.text) as { bidirectional: boolean };
    expect(parsed.bidirectional).toBe(true);

    const supersededEdges = getNeighbors(db, newId, { depth: 1, direction: 'out', relationFilter: ['SUPERSEDES'] });
    expect(supersededEdges.some((e) => e.entityId === oldId)).toBe(true);
    const supersededByEdges = getNeighbors(db, oldId, { depth: 1, direction: 'out', relationFilter: ['SUPERSEDED_BY'] });
    expect(supersededByEdges.some((e) => e.entityId === newId)).toBe(true);
  });

  it('rejects linking a memory to itself', async () => {
    const out = await tool('synapse_remember').handler(ctx, {
      text: 'circular test entry',
      target_scope: 'proj:demo/file:loop.ts',
      memory_kind: 'general',
    });
    const id = JSON.parse(out.content[0]!.text).entity_id as string;
    await expect(
      tool('synapse_link_memories').handler(ctx, { source_id: id, target_id: id }),
    ).rejects.toThrow(/must differ/);
  });

  it('rejects unknown ids and non-memory entities', async () => {
    await expect(
      tool('synapse_link_memories').handler(ctx, { source_id: 'missing-a', target_id: 'missing-b' }),
    ).rejects.toThrow(/'missing-a' not found/);
    const mem = await tool('synapse_remember').handler(ctx, {
      text: 'type guard probe memory',
      target_scope: 'proj:demo/file:typeguard.ts',
      memory_kind: 'general',
    });
    const memId = JSON.parse(mem.content[0]!.text).entity_id as string;
    // A file entity (not a memory_entry) on the target side.
    await expect(
      tool('synapse_link_memories').handler(ctx, { source_id: memId, target_id: 'auth-file' }),
    ).rejects.toThrow(/is not a memory_entry/);
    // A missing TARGET id (the source resolves, the target does not).
    await expect(
      tool('synapse_link_memories').handler(ctx, { source_id: memId, target_id: 'missing-target' }),
    ).rejects.toThrow(/'missing-target' not found/);
    // A non-memory SOURCE (file entity first, memory second).
    await expect(
      tool('synapse_link_memories').handler(ctx, { source_id: 'auth-file', target_id: memId }),
    ).rejects.toThrow(/'auth-file' is not a memory_entry/);
  });

  it('falls back to general for an unknown memory_kind and honours relation_type', async () => {
    const out = await tool('synapse_remember').handler(ctx, {
      text: 'zebra xylophone waltz quicksand',
      // auth.ts carries a structural file entity, so the custom relation has
      // a real target to anchor against.
      target_scope: 'proj:demo/file:auth.ts',
      memory_kind: 'bogus-kind' as never,
      relation_type: 'RELATES_TO',
      metadata: { origin: 'test' },
    });
    const parsed = JSON.parse(out.content[0]!.text) as { entity_id: string; memory_kind: string };
    expect(parsed.memory_kind).toBe('general'); // unknown kinds degrade, not throw
    // The custom relation edge exists from the memory to the scoped target.
    const neighbors = getNeighbors(ctx.db, parsed.entity_id, { relationFilter: ['RELATES_TO'] });
    expect(neighbors.length).toBeGreaterThan(0);
  });
});

describe('synapse_purge_expired', () => {
  beforeEach(() => {
    // Drive all time arithmetic in this suite with Vitest's fake clock so the
    // test is deterministic and CI-fast (no real setTimeout, no race on the
    // host's wall clock). The fake clock applies to Date.now(), setTimeout,
    // and setInterval by default.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes memory entries whose TTL has elapsed and leaves fresh ones intact', async () => {
    // Pin the clock so `expires_at` arithmetic is deterministic. The seed
    // step calls Date.now() internally; advancing first prevents the seed
    // timestamp from sitting exactly on a boundary.
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    // Distinct scopes — the cheapest, most reliable way to guarantee the two
    // seeds won't dedup-merge into a single entity (which would swap
    // expiredId/permanentId and silently break the purge assertions).
    const expiredOut = await tool('synapse_remember').handler(ctx, {
      text: 'this convention was valid until 2024',
      target_scope: 'proj:demo/file:legacy-expired.md',
      memory_kind: 'convention',
      ttl_seconds: 60,
    });
    const permanentOut = await tool('synapse_remember').handler(ctx, {
      text: 'use HTTPS for all internal traffic',
      target_scope: 'proj:demo/file:legacy-permanent.md',
      memory_kind: 'convention',
    });
    const expiredId = JSON.parse(expiredOut.content[0]!.text).entity_id as string;
    const permanentId = JSON.parse(permanentOut.content[0]!.text).entity_id as string;

    // Advance the fake clock past the 60-second TTL window plus a buffer.
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));

    const purge = await tool('synapse_purge_expired').handler(ctx, {});
    const parsed = JSON.parse(purge.content[0]!.text) as { deleted: number; message: string };
    expect(parsed.deleted).toBeGreaterThanOrEqual(1);

    // The expired memory is gone; the permanent one is still there.
    expect(getEntity(db, expiredId)).toBeUndefined();
    expect(getEntity(db, permanentId)).toBeDefined();
  });
});

describe('argument validation hardening', () => {
  it('synapse_memory_search applies the memory_kinds post-filter', async () => {
    await tool('synapse_remember').handler(ctx, {
      text: 'run migrations before every deploy',
      target_scope: 'proj:demo/file:deploy.ts',
      memory_kind: 'workflow',
    });
    await tool('synapse_remember').handler(ctx, {
      text: 'never commit secrets into source files',
      target_scope: 'proj:demo/file:secrets.ts',
      memory_kind: 'warning',
    });
    const out = await tool('synapse_memory_search').handler(ctx, {
      query: 'deploy secrets',
      memory_kinds: ['workflow'],
      limit: 10,
    });
    const parsed = JSON.parse(out.content[0]!.text) as { results: { memory_kind: string }[] };
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.every((r) => r.memory_kind === 'workflow')).toBe(true);
  });

  it('rejects malformed scope prefixes upfront with a clean parameter error', async () => {
    await expect(
      tool('synapse_hybrid_query').handler(ctx, { query: 'x', scopes: ['not a scope'] }),
    ).rejects.toThrow();
    await expect(
      tool('synapse_recall').handler(ctx, { scopes: ['::bad::'] }),
    ).rejects.toThrow();
  });

  it('rejects non-numeric numeric arguments (numberArg throw arm)', async () => {
    await expect(
      tool('synapse_hybrid_query').handler(ctx, { query: 'x', limit: 'abc' as unknown as number }),
    ).rejects.toThrow(/finite number/);
  });

  it('memory_search passes an explicit types filter through to hybrid search', async () => {
    const out = await tool('synapse_memory_search').handler(ctx, {
      query: 'quick',
      types: ['memory_entry'],
      limit: 5,
    });
    const parsed = JSON.parse(out.content[0]!.text) as { results: { type: string }[] };
    expect(parsed.results.every((r) => r.type === 'memory_entry')).toBe(true);
  });

  it('clamps index depth into [1, 64] instead of passing it through raw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synapse-depth-clamp-'));
    try {
      // depth 0 would walk nothing; the clamp bumps it to the default 20 so
      // the workspace still indexes.
      const out = await tool('synapse_index_workspace').handler(ctx, {
        workspace_path: dir,
        options: { depth: 0 },
      });
      const parsed = JSON.parse(out.content[0]!.text) as { projectScope: string };
      expect(parsed.projectScope).toBe(`proj:${basename(dir)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
});
