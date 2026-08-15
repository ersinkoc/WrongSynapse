import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from './connection.js';
import { assertFts5, migrate } from './schema.js';
import {
  deleteEntity,
  getEntity,
  getNeighbors,
  getVectors,
  insertEntity,
  insertRelation,
  searchFts,
  upsertVector,
} from './queries.js';

let db: SynapseDatabase;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  assertFts5(db);
});

afterAll(() => {
  db.close();
});

describe('migrations', () => {
  it('advances user_version and creates the FTS table', () => {
    const row = db.prepare('PRAGMA user_version').get();
    expect(row?.['user_version']).toBe(1);
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities_fts'").get();
    expect(fts).toBeDefined();
  });
});

describe('FTS5 trigger sync', () => {
  it('indexes inserts', () => {
    insertEntity(db, { id: 'e1', type: 'file', scopePath: 'proj:t/file:a.ts', name: 'a.ts', content: 'token validation logic here' });
    expect(searchFts(db, 'validation', 10).some((h) => h.entityId === 'e1')).toBe(true);
  });

  it('tracks updates', () => {
    insertEntity(db, { id: 'e1', type: 'file', scopePath: 'proj:t/file:a.ts', name: 'a.ts', content: 'completely different text' });
    expect(searchFts(db, 'validation', 10).some((h) => h.entityId === 'e1')).toBe(false);
    expect(searchFts(db, 'different', 10).some((h) => h.entityId === 'e1')).toBe(true);
  });

  it('removes deleted rows', () => {
    deleteEntity(db, 'e1');
    expect(searchFts(db, 'different', 10).some((h) => h.entityId === 'e1')).toBe(false);
  });

  it('escapes special characters in queries', () => {
    insertEntity(db, { id: 'e2', type: 'file', scopePath: 'proj:t/file:b.ts', name: 'b.ts', content: 'cache invalidation is hard' });
    expect(searchFts(db, 'cache "invalidation" (hard)', 10).some((h) => h.entityId === 'e2')).toBe(true);
  });
});

describe('foreign-key cascades', () => {
  it('removes relations and vectors with their entity', () => {
    insertEntity(db, { id: 'parent', type: 'file', scopePath: 'proj:t/file:p.ts', name: 'p.ts', content: 'x' });
    insertEntity(db, { id: 'child', type: 'symbol', scopePath: 'proj:t/file:p.ts/sym:fn', name: 'fn', content: 'fn' });
    insertRelation(db, { sourceId: 'parent', targetId: 'child', relation: 'CONTAINS' });
    upsertVector(db, 'child', new Float32Array(4).fill(0.5));

    expect(getVectors(db, {}).some((v) => v.entityId === 'child')).toBe(true);

    // Deleting the child must cascade away its vector and the CONTAINS edge,
    // but leave the unrelated parent entity intact.
    deleteEntity(db, 'child');

    expect(getVectors(db, {}).some((v) => v.entityId === 'child')).toBe(false);
    expect(getEntity(db, 'child')).toBeUndefined();
    expect(getNeighbors(db, 'parent', {})).toEqual([]);
    expect(getEntity(db, 'parent')).toBeDefined();
  });
});

describe('entity upsert', () => {
  it('is idempotent and reports existence', () => {
    insertEntity(db, { id: 'dup', type: 'file', scopePath: 'proj:t/file:d.ts', name: 'd.ts', content: 'v1' });
    const existed = insertEntity(db, { id: 'dup', type: 'file', scopePath: 'proj:t/file:d.ts', name: 'd.ts', content: 'v2' });
    expect(existed).toBe(true);
    expect(getEntity(db, 'dup')?.content).toBe('v2');
  });
});
