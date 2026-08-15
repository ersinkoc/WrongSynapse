import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { insertEntity, insertRelation, upsertVector } from '../db/queries.js';
import { FakeEmbedder, FailingEmbedder } from '../../test/helpers/fake-embedder.js';
import type { Embedder } from './embedding.js';
import { hybridSearch } from './hybrid-search.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();

const A_SCOPE = 'proj:demo/dir:src/file:alpha.ts';
const B_SCOPE = 'proj:demo/dir:src/file:beta.ts';
const SYM_SCOPE = 'proj:demo/dir:src/file:alpha.ts/sym:validate';
const MEM_SCOPE = 'proj:demo/dir:src/file:alpha.ts';

const CONTENT_A = 'token validation logic with authorization checks';
const CONTENT_B = 'database connection pool with query caching';
const CONTENT_SYM = 'function validate()';
const CONTENT_MEM = 'always validate tokens before trusting them';

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  insertEntity(db, { id: 'a', type: 'file', scopePath: A_SCOPE, name: 'alpha.ts', content: CONTENT_A });
  insertEntity(db, { id: 'b', type: 'file', scopePath: B_SCOPE, name: 'beta.ts', content: CONTENT_B });
  insertEntity(db, { id: 'sym', type: 'symbol', scopePath: SYM_SCOPE, name: 'validate', content: CONTENT_SYM });
  insertEntity(db, { id: 'mem', type: 'memory_entry', scopePath: MEM_SCOPE, name: 'auth note', content: CONTENT_MEM });
  insertRelation(db, { sourceId: 'a', targetId: 'sym', relation: 'CONTAINS' });
  for (const [id, text] of [
    ['a', CONTENT_A],
    ['b', CONTENT_B],
    ['sym', CONTENT_SYM],
    ['mem', CONTENT_MEM],
  ] as const) {
    upsertVector(db, id, await embedder.embed(text));
  }
});

afterAll(() => {
  db.close();
});

describe('hybridSearch', () => {
  it('returns lexical matches for exact terms', async () => {
    const out = await hybridSearch(db, embedder, { query: 'token validation', limit: 10 });
    expect(out.warnings).toEqual([]); // semantic retrieval must not silently degrade here
    const ids = out.results.map((r) => r.entity.id);
    expect(ids).toContain('a');
    expect(ids).toContain('sym');
    expect(ids).toContain('mem');
    expect(out.results[0]!.score).toBeGreaterThan(0);
  });

  it('ranks semantic matches above unrelated files', async () => {
    const out = await hybridSearch(db, embedder, { query: 'validate tokens', vectorWeight: 2, lexicalWeight: 0, limit: 10 });
    const ids = out.results.map((r) => r.entity.id);
    const idxA = ids.indexOf('a');
    const idxB = ids.indexOf('b');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
    expect(out.vectorRetrievalUsed).toBe(true);
  });

  it('fuses fts and vector ranks with RRF', async () => {
    const out = await hybridSearch(db, embedder, { query: 'token validation', lexicalWeight: 1, vectorWeight: 1, limit: 10 });
    const a = out.results.find((r) => r.entity.id === 'a');
    expect(a).toBeDefined();
    expect(a!.ranks.fts).not.toBeNull();
    expect(a!.ranks.vector).not.toBeNull();
    // RRF term: 1/61 for rank 1 with k=60
    expect(a!.score).toBeGreaterThan(0.016);
  });

  it('applies scope filters', async () => {
    const out = await hybridSearch(db, embedder, { query: 'validate tokens', scopes: [B_SCOPE], limit: 10 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.entity.id === 'b')).toBe(true);
  });

  it('applies type filters', async () => {
    const out = await hybridSearch(db, embedder, { query: 'validate tokens', types: ['symbol'], limit: 10 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.entity.type === 'symbol')).toBe(true);
  });

  it('expands graph neighbors of seeds (CONTAINS edge)', async () => {
    // 'authorization' matches only file a; the symbol is reachable via CONTAINS.
    const out = await hybridSearch(db, embedder, { query: 'authorization', lexicalWeight: 1, vectorWeight: 0, graphWeight: 1, limit: 10 });
    const ids = out.results.map((r) => r.entity.id);
    expect(ids).toContain('a');
    const sym = out.results.find((r) => r.entity.id === 'sym');
    expect(sym).toBeDefined();
    expect(sym!.ranks.graph).not.toBeNull();
    expect(sym!.graphPaths.length).toBeGreaterThan(0);
  });

  it('degrades gracefully when the embedder is unavailable', async () => {
    const out = await hybridSearch(db, new FailingEmbedder(), { query: 'token validation', limit: 10 });
    expect(out.vectorRetrievalUsed).toBe(false);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.results.length).toBeGreaterThan(0); // lexical path still works
  });

  it('stringifies non-Error throwables from the embedder in warnings', async () => {
    // A pipeline that throws a plain string (some native bindings do) must be
    // reported by message, not crash the whole query.
    const stringThrower: Embedder = {
      modelId: 'string-thrower',
      dimension: 16,
      isReady: () => false,
      init: async () => {},
      embed: async () => {
        throw 'raw string failure';
      },
      embedBatch: async () => {
        throw 'raw string failure';
      },
    };
    const out = await hybridSearch(db, stringThrower, { query: 'token validation', limit: 10 });
    expect(out.vectorRetrievalUsed).toBe(false);
    expect(out.warnings.some((w) => w.includes('raw string failure'))).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
  });

  it('skips stored vectors whose dimension does not match the query embedding', async () => {
    // A stale/corrupt 3-dim vector must be skipped by the cosine pass — the
    // entity may still surface via FTS, but its vector rank stays null.
    insertEntity(db, { id: 'odd', type: 'file', scopePath: 'proj:demo/dir:src/file:odd.ts', name: 'odd.ts', content: 'token validation' });
    upsertVector(db, 'odd', new Float32Array([1, 0, 0])); // 3 dims vs FakeEmbedder's 16
    const out = await hybridSearch(db, embedder, { query: 'token validation', limit: 10 });
    const odd = out.results.find((r) => r.entity.id === 'odd');
    expect(odd).toBeDefined(); // lexical path still finds it
    expect(odd!.ranks.vector).toBeNull(); // dimension mismatch: skipped by cosine
    expect(out.vectorRetrievalUsed).toBe(true); // well-formed vectors still ranked
    expect(out.warnings).toEqual([]); // a skipped mismatch is silent degradation
  });

  it('skips vector candidates whose scope only shares a LIKE prefix', async () => {
    // getVectors filters by SQL LIKE 'prefix%', which matches proj:demo2;
    // the segment-aware matchesFilters re-check must reject it.
    insertEntity(db, { id: 'like', type: 'file', scopePath: 'proj:demo2/file:like.ts', name: 'like.ts', content: 'validate tokens' });
    upsertVector(db, 'like', await embedder.embed('validate tokens'));
    const out = await hybridSearch(db, embedder, {
      query: 'validate tokens',
      scopes: ['proj:demo'],
      lexicalWeight: 0,
      vectorWeight: 1,
      graphWeight: 0,
      limit: 10,
    });
    expect(out.results.every((r) => r.entity.id !== 'like')).toBe(true);
  });

  it('skips graph expansion entirely when graphWeight is zero', async () => {
    const out = await hybridSearch(db, embedder, {
      query: 'authorization',
      lexicalWeight: 1,
      vectorWeight: 0,
      graphWeight: 0,
      limit: 10,
    });
    // 'authorization' only matches file a; its CONTAINS neighbor sym is
    // reachable only through graph expansion, which is disabled here.
    expect(out.results.some((r) => r.entity.id === 'sym')).toBe(false);
    expect(out.results.some((r) => r.entity.id === 'a')).toBe(true);
  });

  it('reports matched scopes for multi-prefix queries', async () => {
    const out = await hybridSearch(db, embedder, {
      query: 'validate tokens',
      scopes: ['proj:demo/dir:src/file:alpha.ts', 'proj:demo/dir:src/file:beta.ts'],
      limit: 10,
    });
    for (const result of out.results) {
      expect(result.matchedScopes.length).toBeGreaterThan(0);
    }
  });
});
