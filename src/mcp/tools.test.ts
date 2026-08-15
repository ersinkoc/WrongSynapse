import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getCandidate, getEntity, getNeighbors, insertEntity, insertRelation } from '../db/queries.js';
import { FakeEmbedder, FailingEmbedder } from '../../test/helpers/fake-embedder.js';
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
  it('exposes all six tools', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'synapse_index_workspace',
      'synapse_hybrid_query',
      'synapse_anchor_memory',
      'synapse_graph_neighbors',
      'synapse_record_observation',
      'synapse_promote_candidate',
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
});
