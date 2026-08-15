/**
 * queries.ts — candidate listing/status, stats, vector deletion, and the
 * deleteStaleIndexedEntities boundary regression (sibling scopes must survive).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from './connection.js';
import { migrate } from './schema.js';
import {
  dbStats,
  deleteStaleIndexedEntities,
  deleteVector,
  findEntitiesByScope,
  getVectors,
  insertCandidate,
  insertEntity,
  listCandidates,
  setCandidateStatus,
} from './queries.js';

let db: SynapseDatabase;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
});

afterAll(() => {
  db.close();
});

describe('memory candidates', () => {
  it('inserts, lists, and updates candidates', () => {
    const id = insertCandidate(db, { content: 'first observation', scopePath: 'proj:x', confidence: 0.9 });
    insertCandidate(db, { content: 'second observation' });
    expect(listCandidates(db).length).toBe(2);
    expect(listCandidates(db, { status: 'pending' }).length).toBe(2);
    expect(listCandidates(db, { status: 'promoted' }).length).toBe(0);
    expect(listCandidates(db, { limit: 1 }).length).toBe(1);

    setCandidateStatus(db, id, 'discarded');
    expect(listCandidates(db, { status: 'discarded' }).length).toBe(1);
  });
});

describe('dbStats', () => {
  it('counts every backing table', () => {
    const stats = dbStats(db);
    expect(stats.entities).toBe(0);
    expect(stats.relations).toBe(0);
    expect(stats.vectors).toBe(0);
    expect(stats.candidates).toBeGreaterThan(0);
    expect(stats.ftsRows).toBe(0);
  });
});

describe('vector deletion', () => {
  it('removes a stored embedding', () => {
    insertEntity(db, { id: 'v1', type: 'file', scopePath: 'proj:vec/file:a.ts', name: 'a.ts', content: 'x' });
    const vec = new Float32Array(4).fill(0.25);
    db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run('v1', Buffer.from(vec.buffer));
    expect(getVectors(db, {}).some((v) => v.entityId === 'v1')).toBe(true);
    deleteVector(db, 'v1');
    expect(getVectors(db, {}).some((v) => v.entityId === 'v1')).toBe(false);
  });
});

describe('deleteStaleIndexedEntities (boundary regression)', () => {
  function indexedEntity(id: string, scopePath: string): void {
    insertEntity(db, {
      id,
      type: 'file',
      scopePath,
      name: id,
      content: 'x',
      metadata: { synapse_indexed: true },
    });
  }

  it('keeps exact-prefix siblings outside the tree (proj:app vs proj:app2)', () => {
    indexedEntity('app-a', 'proj:app/file:a.ts');
    indexedEntity('app2-a', 'proj:app2/file:a.ts');
    indexedEntity('app-deep', 'proj:app/dir:src/file:b.ts');

    const deleted = deleteStaleIndexedEntities(db, 'proj:app', ['file'], new Set());
    expect(deleted).toBe(2); // app-a and app-deep, NOT app2-a
  });

  it('keeps entities re-touched during the current run', () => {
    indexedEntity('keep-me', 'proj:keep/file:k.ts');
    const deleted = deleteStaleIndexedEntities(db, 'proj:keep', ['file'], new Set(['keep-me']));
    expect(deleted).toBe(0);
  });

  it('handles type filters and underscores in the prefix', () => {
    indexedEntity('my-app-file', 'proj:my_app/file:x.ts');
    indexedEntity('my-xapp-file', 'proj:myXapp/file:y.ts');
    const deleted = deleteStaleIndexedEntities(db, 'proj:my_app', ['file'], new Set());
    expect(deleted).toBe(1); // underscore prefix must not match proj:myXapp
  });
});

describe('findEntitiesByScope / getVectors (boundary-aware prefixes)', () => {
  beforeAll(() => {
    insertEntity(db, { id: 'pfx-in', type: 'file', scopePath: 'proj:pfx/file:a.ts', name: 'a.ts', content: 'x' });
    insertEntity(db, { id: 'pfx-deep', type: 'file', scopePath: 'proj:pfx/dir:src/file:b.ts', name: 'b.ts', content: 'y' });
    insertEntity(db, { id: 'pfx-sibling', type: 'file', scopePath: 'proj:pfx2/file:c.ts', name: 'c.ts', content: 'z' });
    for (const id of ['pfx-in', 'pfx-deep', 'pfx-sibling']) {
      const vec = new Float32Array(4).fill(0.5);
      db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run(id, Buffer.from(vec.buffer));
    }
  });

  it('findEntitiesByScope excludes sibling scopes and includes descendants', () => {
    const found = findEntitiesByScope(db, { scopePrefixes: ['proj:pfx'], types: ['file'] }).map((e) => e.id);
    expect(found).toContain('pfx-in');
    expect(found).toContain('pfx-deep'); // '/'-rooted descendant still matches
    expect(found).not.toContain('pfx-sibling'); // proj:pfx2 must NOT match proj:pfx
  });

  it('getVectors excludes sibling scopes and includes descendants', () => {
    const ids = getVectors(db, { scopePrefixes: ['proj:pfx'], types: ['file'] }).map((v) => v.entityId);
    expect(ids).toContain('pfx-in');
    expect(ids).toContain('pfx-deep');
    expect(ids).not.toContain('pfx-sibling');
  });
});
