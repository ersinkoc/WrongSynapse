/**
 * hybridSearch KNN path — exercises the sqlite-vec vec0 branch that only
 * engages when the corpus exceeds VECTOR_SCAN_CAP (10_000) AND the vec index
 * is ready. Fillers are inserted with raw SQL (no FTS trigger noise) so the
 * bulk setup stays fast; the semantic targets are regular entities whose
 * vectors are upserted AFTER buildVecIndex, proving the runtime sync feeds
 * the KNN index.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildVecIndex, openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { insertEntity, insertRelation, upsertVector } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { hybridSearch } from './hybrid-search.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();

const FILLERS = 10_100; // comfortably past VECTOR_SCAN_CAP (10_000)
const TARGET_SCOPE = 'proj:ann/file:target.ts';
const FILLER_SCOPE = 'proj:ann/file:filler.txt';

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  await embedder.init();

  // Bulk fillers: raw SQL inside one transaction (no FTS/log overhead).
  db.transaction(() => {
    const insertEntityStmt = db.prepare(
      'INSERT INTO entities (id, type, scope_path, name, content, metadata, confidence, created_at, updated_at, memory_kind, importance, expires_at, last_accessed_at, tags) VALUES (?, ?, ?, ?, ?, NULL, 1.0, ?, ?, ?, 0.5, NULL, NULL, ?)',
    );
    const insertVectorStmt = db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)');
    for (let i = 0; i < FILLERS; i++) {
      const now = Date.now();
      insertEntityStmt.run(`filler${i}`, 'file', FILLER_SCOPE, `filler${i}.txt`, null, now, now, 'file_note', '[]');
      // Deterministic filler embedding: unit vectors cycling through dims.
      const vec = new Float32Array(embedder.dimension);
      vec[i % embedder.dimension] = 1;
      insertVectorStmt.run(`filler${i}`, Buffer.from(vec.buffer));
    }
  });

  // Build the index from the fillers (derives dim 16).
  expect(buildVecIndex(db)).toBe(true);
  expect(db.vec!.indexReady).toBe(true);

  // Post-build writes must reach vec_entities via the runtime sync.
  insertEntity(db, { id: 'target1', type: 'memory_entry', scopePath: TARGET_SCOPE, name: 'target one', content: 'the quick brown fox jumps over the lazy dog' });
  insertEntity(db, { id: 'target2', type: 'memory_entry', scopePath: TARGET_SCOPE, name: 'target two', content: 'quick brown foxes are agile jumpers' });
  insertEntity(db, { id: 'target3', type: 'memory_entry', scopePath: TARGET_SCOPE, name: 'unrelated', content: 'postgresql vacuum analyzer settings' });
  // Expired neighbor: ANN will still see its vector (the vec index has no
  // expiry semantics) and the graph channel reaches it via the relation —
  // both channels must filter it out.
  insertEntity(db, { id: 'target4', type: 'memory_entry', scopePath: TARGET_SCOPE, name: 'expired fox', content: 'quick brown fox expired note', expiresAt: Date.now() - 1000 });
  insertRelation(db, { sourceId: 'target1', targetId: 'target4', relation: 'ANCHORED_TO' });
  await upsertVector(db, 'target1', await embedder.embed('quick brown fox jumps'));
  await upsertVector(db, 'target2', await embedder.embed('quick brown fox jumpers'));
  await upsertVector(db, 'target3', await embedder.embed('vacuum analyzer'));
  await upsertVector(db, 'target4', await embedder.embed('quick brown fox expired note'));
  // Orphan vec row: delete the entity with raw SQL so FK cascades take the
  // BLOB vector and relations but the vec_entities mirror survives — the KNN
  // loop must skip rows whose entity no longer resolves.
  insertEntity(db, { id: 'target5', type: 'memory_entry', scopePath: TARGET_SCOPE, name: 'ghost', content: 'quick brown fox ghost' });
  await upsertVector(db, 'target5', await embedder.embed('quick brown fox ghost'));
  db.prepare('DELETE FROM entities WHERE id = ?').run('target5');
});

afterAll(() => {
  db.close();
});

describe('hybridSearch KNN path (corpus > VECTOR_SCAN_CAP)', () => {
  it('uses the vec_entities KNN index and ranks semantically-matching memories', async () => {
    const out = await hybridSearch(db, embedder, {
      query: 'quick brown fox jumps',
      lexicalWeight: 0, // isolate the semantic channel
      graphWeight: 0,
      limit: 5,
    });
    expect(out.vectorRetrievalUsed).toBe(true);
    const ids = out.results.map((r) => r.entity.id);
    expect(ids).toContain('target1');
    expect(ids).toContain('target2');
    // The filler corpus must not crowd out the targets entirely, and the
    // unrelated target must not outrank the two matching ones.
    const idx1 = ids.indexOf('target1');
    const idx3 = ids.indexOf('target3');
    if (idx3 >= 0) expect(idx1).toBeLessThan(idx3);
    // Exact-scan truncation warning must be absent — the KNN branch ran
    // instead of scanning (and capping) the BLOB table.
    expect(out.warnings.some((w) => w.includes('semantic scan truncated'))).toBe(false);
    // The expired memory and the orphaned vec row must never surface,
    // even though both sit inside the KNN candidate set.
    expect(ids).not.toContain('target4');
    expect(ids).not.toContain('target5');
  });

  it('applies scope filters against the global KNN candidate set', async () => {
    // All 10k fillers live under FILLER_SCOPE; restricting to TARGET_SCOPE
    // must reject them post-KNN while still returning the in-scope targets.
    // graphWeight stays on so the expired ANCHORED_TO neighbor (target4) is
    // also reached — and filtered — by the graph channel.
    const out = await hybridSearch(db, embedder, {
      query: 'quick brown fox jumps',
      scopes: [TARGET_SCOPE],
      lexicalWeight: 0,
      graphWeight: 1,
      limit: 5,
    });
    expect(out.vectorRetrievalUsed).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.entity.scopePath.startsWith(TARGET_SCOPE))).toBe(true);
    expect(out.results.some((r) => r.entity.id === 'target1')).toBe(true);
  });

  it('degrades to the exact scan (with a warning) when the KNN table is unavailable', async () => {
    // Simulate a stale/missing vec_entities while the flags still claim ready
    // — exactly the state the old hnsw bug left behind. The channel must
    // survive via the BLOB cosine scan.
    db.exec('DROP TABLE vec_entities');
    try {
      const out = await hybridSearch(db, embedder, {
        query: 'quick brown fox',
        lexicalWeight: 0,
        graphWeight: 0,
        limit: 5,
      });
      expect(out.vectorRetrievalUsed).toBe(true);
      expect(out.warnings.some((w) => w.includes('KNN query failed'))).toBe(true);
      // Fallback exact scan is capped at VECTOR_SCAN_CAP on this corpus.
      expect(out.warnings.some((w) => w.includes('semantic scan truncated'))).toBe(true);
    } finally {
      // Restore the index for any later tests in this file.
      db.exec("DELETE FROM _synapse_vec_meta WHERE key LIKE 'vec_index_%'");
      expect(buildVecIndex(db)).toBe(true);
    }
  });
});
