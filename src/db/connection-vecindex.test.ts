/**
 * buildVecIndex + runtime vec_entities sync — integration tests against the
 * REAL sqlite-vec extension (loaded by openDatabase whenever the platform
 * binary is installable). These pin the regression where the vec0 CREATE
 * used unsupported `hnsw_parameters`, silently killed the ANN table, and the
 * stale capability flags then disabled the working BLOB cosine fallback.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildVecIndex, openDatabase, type SynapseDatabase } from './connection.js';
import { migrate } from './schema.js';
import { deleteEntity, insertEntity, upsertVector, deleteVector, getEntities, countVectors } from './queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();

function vecCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM vec_entities').get() as { n: number };
  return row.n;
}

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  await embedder.init();
});

afterAll(() => {
  db.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildVecIndex', () => {
  it('builds an empty index with the default dimension on a fresh database', () => {
    expect(db.vec!.extensionLoaded).toBe(true);
    const ok = buildVecIndex(db);
    expect(ok).toBe(true);
    expect(db.vec!.indexReady).toBe(true);
    expect(db.vec!.indexDimension).toBe(384);
    expect(vecCount()).toBe(0);
  });

  it('derives the dimension from stored vectors and copies them into vec_entities', async () => {
    // FakeEmbedder is 16-dim — the vec0 column must follow the data, not the
    // default 384.
    insertEntity(db, { id: 'e1', type: 'memory_entry', scopePath: 'proj:v/file:a.ts', name: 'a', content: 'alpha content' });
    insertEntity(db, { id: 'e2', type: 'memory_entry', scopePath: 'proj:v/file:b.ts', name: 'b', content: 'beta content' });
    await upsertVector(db, 'e1', await embedder.embed('alpha'));
    await upsertVector(db, 'e2', await embedder.embed('beta'));
    // The runtime index from the previous test is stale (dim 384 vs 16) —
    // force a rebuild by clearing the marker, like a schema bump would.
    db.exec("DELETE FROM _synapse_vec_meta WHERE key LIKE 'vec_index_%'");
    const ok = buildVecIndex(db);
    expect(ok).toBe(true);
    expect(db.vec!.indexDimension).toBe(16);
    expect(vecCount()).toBe(2);
  });

  it('skips the rebuild when the marker matches and counts agree', () => {
    // Make the index deliberately stale (missing row) while the meta count
    // still equals entity_vectors — a skip must NOT repair it, proving no
    // rebuild ran.
    db.prepare('DELETE FROM vec_entities WHERE entity_id = ?').run('e1');
    db.prepare(
      "UPDATE _synapse_vec_meta SET value = '2' WHERE key = 'vec_index_count'",
    ).run();
    const ok = buildVecIndex(db);
    expect(ok).toBe(true);
    expect(vecCount()).toBe(1); // stale row NOT restored → rebuild skipped
    // Restore full parity for the later tests.
    db.exec('DROP TABLE vec_entities');
    expect(buildVecIndex(db)).toBe(true);
  });

  it('tolerates a database handle without vec capabilities on the skip path', () => {
    // Mocked/test databases may lack db.vec entirely — the skip arm must not
    // touch it.
    const dbAny = db as unknown as { vec?: unknown };
    const saved = dbAny.vec;
    delete dbAny.vec;
    try {
      // State is consistent from the previous test → skip arm.
      expect(buildVecIndex(db)).toBe(true);
    } finally {
      dbAny.vec = saved;
    }
  });

  it('rebuilds when the table is missing even though the marker matches', () => {
    db.exec('DROP TABLE vec_entities');
    const ok = buildVecIndex(db);
    expect(ok).toBe(true);
    expect(vecCount()).toBe(2); // full rebuild restored both rows
  });

  it('reports null indexDimension when the stored dim marker is zero', () => {
    db.prepare("UPDATE _synapse_vec_meta SET value = '0' WHERE key = 'vec_index_dim'").run();
    // Marker + count still agree → skip arm reads the dim marker.
    db.prepare(
      "UPDATE _synapse_vec_meta SET value = '2' WHERE key = 'vec_index_count'",
    ).run();
    const ok = buildVecIndex(db);
    expect(ok).toBe(true);
    expect(db.vec!.indexDimension).toBeNull();
    db.prepare("UPDATE _synapse_vec_meta SET value = '16' WHERE key = 'vec_index_dim'").run();
  });

  it('rejects a vector whose byte length is not a multiple of 4', () => {
    // 'aaa-' sorts before every existing entity_id, so the dimension probe
    // (ORDER BY entity_id LIMIT 1) sees THIS row first.
    insertEntity(db, { id: 'aaa-odd', type: 'memory_entry', scopePath: 'proj:v/file:odd.ts', name: 'odd', content: 'odd bytes' });
    // 5 bytes cannot be a whole number of float32s — the dimension derived
    // from it is not an integer and the build must abort cleanly.
    db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run('aaa-odd', Buffer.alloc(5));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ok = buildVecIndex(db);
      expect(ok).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive embedding dimension'));
    } finally {
      db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run('aaa-odd');
      deleteEntity(db, 'aaa-odd');
      expect(buildVecIndex(db)).toBe(true);
    }
  });

  it('rejects mixed-dimension corpora: drops the table, clears markers, stays not-ready', async () => {
    insertEntity(db, { id: 'e3', type: 'memory_entry', scopePath: 'proj:v/file:c.ts', name: 'c', content: 'gamma' });
    // Raw insert with a foreign dimension — upsertVector would self-disable
    // the index instead; here we want the build itself to see the mix.
    db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run(
      'e3',
      Buffer.from(new Float32Array(24).buffer),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = buildVecIndex(db);
    expect(ok).toBe(false);
    expect(db.vec!.indexReady).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mixed embedding dimensions'));
    // Failed build leaves no half-built table or marker behind.
    const table = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_entities'").get();
    expect(table).toBeUndefined();
    const marker = db.prepare("SELECT value FROM _synapse_vec_meta WHERE key = 'vec_index_built_for'").get();
    expect(marker).toBeUndefined();
    // Recover: remove the poisoned row, rebuild succeeds again.
    db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run('e3');
    deleteEntity(db, 'e3');
    expect(buildVecIndex(db)).toBe(true);
  });
});

describe('runtime vec_entities sync', () => {
  it('mirrors upserts after the index is built (new rows and updates)', async () => {
    expect(db.vec!.indexReady).toBe(true);
    insertEntity(db, { id: 'e4', type: 'memory_entry', scopePath: 'proj:v/file:d.ts', name: 'd', content: 'delta' });
    const before = vecCount();
    await upsertVector(db, 'e4', await embedder.embed('delta'));
    expect(vecCount()).toBe(before + 1);
    // Upsert again (same id) → UPDATE arm, no duplicate row.
    await upsertVector(db, 'e4', await embedder.embed('delta two'));
    expect(vecCount()).toBe(before + 1);
  });

  it('self-disables on a dimension mismatch instead of throwing', async () => {
    insertEntity(db, { id: 'e5', type: 'memory_entry', scopePath: 'proj:v/file:e.ts', name: 'e', content: 'epsilon' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 32-dim embedding against a 16-dim index: BLOB store accepts it, the
    // vec0 mirror cannot — the index must disable itself, not crash.
    expect(() => upsertVector(db, 'e5', new Float32Array(32))).not.toThrow();
    expect(db.vec!.indexReady).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dimension 32'));
    // The BLOB write itself succeeded.
    expect(countVectors(db)).toBeGreaterThan(3);
    db.vec!.indexReady = true; // restore for the delete tests below
  });

  it('deleteVector removes the row from both stores while the index is ready', async () => {
    const blobBefore = countVectors(db);
    const vecBefore = vecCount();
    deleteVector(db, 'e4');
    expect(countVectors(db)).toBe(blobBefore - 1);
    expect(vecCount()).toBe(vecBefore - 1);
  });

  it('deleteEntity also cleans the vec_entities row (no FK on virtual tables)', async () => {
    insertEntity(db, { id: 'e6', type: 'memory_entry', scopePath: 'proj:v/file:f.ts', name: 'f', content: 'zeta' });
    await upsertVector(db, 'e6', await embedder.embed('zeta'));
    const vecBefore = vecCount();
    deleteEntity(db, 'e6');
    expect(vecCount()).toBe(vecBefore - 1);
  });
});

describe('getEntities (batch fetch)', () => {
  it('resolves ids in chunked IN(...) queries and skips unknown ids', () => {
    const ids = ['e1', 'e2', 'missing'];
    const map = getEntities(db, ids);
    expect(map.has('e1')).toBe(true);
    expect(map.has('e2')).toBe(true);
    expect(map.has('missing')).toBe(false);
    expect(map.get('e1')!.scopePath).toBe('proj:v/file:a.ts');
    expect(map.size).toBe(2);
  });

  it('handles batches larger than one chunk', () => {
    // 150 ids exercises the chunked loop's second iteration.
    const many: string[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `bulk${i}`;
      insertEntity(db, { id, type: 'memory_entry', scopePath: `proj:v/file:bulk${i}.ts`, name: id, content: id });
      many.push(id);
    }
    const map = getEntities(db, many);
    expect(map.size).toBe(150);
  });

  it('returns an empty map for an empty id list', () => {
    expect(getEntities(db, []).size).toBe(0);
  });
});
