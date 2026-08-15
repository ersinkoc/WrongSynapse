import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getCandidate, insertEntity } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
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
});
