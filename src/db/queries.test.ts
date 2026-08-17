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
  findMemories,
  findSimilarMemories,
  getCandidate,
  getNeighbors,
  getVectors,
  insertCandidate,
  insertEntity,
  insertRelation,
  listCandidates,
  mergeMemories,
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

describe('findSimilarMemories guards', () => {
  beforeAll(() => {
    insertEntity(db, { id: 'sim-a', type: 'memory_entry', scopePath: 'proj:sim/file:a.ts', name: 'a', content: 'alpha note', memoryKind: 'convention' });
    insertEntity(db, { id: 'sim-b', type: 'memory_entry', scopePath: 'proj:other/file:b.ts', name: 'b', content: 'beta note', memoryKind: 'fact' });
    // Same text as sim-a → cosine 1 within scope; different scope.
    const vec = new Float32Array(4).fill(0.5);
    for (const id of ['sim-a', 'sim-b']) {
      db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run(id, Buffer.from(vec.buffer));
    }
  });

  it('returns [] for an empty query embedding or a zero vector', () => {
    expect(findSimilarMemories(db, new Float32Array(0), 0.5, null, 10)).toEqual([]);
    expect(findSimilarMemories(db, new Float32Array(8), 0.5, null, 10)).toEqual([]);
  });

  it('filters by memory kind and scope prefix SQL-side', () => {
    const probe = new Float32Array(4).fill(0.5);
    const all = findSimilarMemories(db, probe, 0.5, null, 10);
    expect(all.map((h) => h.entityId).sort()).toEqual(['sim-a', 'sim-b']);
    const conventions = findSimilarMemories(db, probe, 0.5, 'convention', 10);
    expect(conventions.map((h) => h.entityId)).toEqual(['sim-a']);
    const scoped = findSimilarMemories(db, probe, 0.5, null, 10, ['proj:other']);
    expect(scoped.map((h) => h.entityId)).toEqual(['sim-b']);
  });

  it('skips dimension-mismatched stored vectors instead of throwing', () => {
    insertEntity(db, { id: 'sim-odd', type: 'memory_entry', scopePath: 'proj:sim/file:c.ts', name: 'c', content: 'odd dims' });
    db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run('sim-odd', Buffer.from(new Float32Array(3).buffer));
    const probe = new Float32Array(4).fill(0.5);
    const hits = findSimilarMemories(db, probe, 0.5, null, 10);
    expect(hits.some((h) => h.entityId === 'sim-odd')).toBe(false);
    expect(hits.length).toBeGreaterThan(0); // well-formed rows still scored
  });

  it('defaults a NULL memory_kind column to general', () => {
    // Pre-v2 rows (or manual SQL) can carry a NULL memory_kind — the mapper
    // must coerce it instead of surfacing "null".
    db.prepare(
      "INSERT INTO entities (id, type, scope_path, name, content, memory_kind, importance, created_at, updated_at, tags) VALUES ('sim-nullkind', 'memory_entry', 'proj:sim/file:d.ts', 'd', 'null kind probe', NULL, 0.5, ?, ?, '[]')",
    ).run(Date.now(), Date.now());
    db.prepare('INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)').run('sim-nullkind', Buffer.from(new Float32Array(4).fill(0.5).buffer));
    const hits = findSimilarMemories(db, new Float32Array(4).fill(0.5), 0.5, null, 10);
    const hit = hits.find((h) => h.entityId === 'sim-nullkind');
    expect(hit).toBeDefined();
    expect(hit!.memoryKind).toBe('general');
  });
});

describe('mergeMemories guards', () => {
  it('refuses to merge an entity with itself', () => {
    expect(mergeMemories(db, 'sim-a', 'sim-a')).toBe(false);
  });

  it('returns false when either side is missing', () => {
    expect(mergeMemories(db, 'does-not-exist', 'sim-a')).toBe(false);
    expect(mergeMemories(db, 'sim-a', 'does-not-exist')).toBe(false);
  });

  it('merges two metadata-less memories end to end', () => {
    insertEntity(db, { id: 'mg-w', type: 'memory_entry', scopePath: 'proj:mg/file:w.ts', name: 'w', content: 'winner text', memoryKind: 'fact', importance: 0.4, tags: ['keepme'] });
    insertEntity(db, { id: 'mg-l', type: 'memory_entry', scopePath: 'proj:mg/file:l.ts', name: 'l', content: 'loser text', memoryKind: 'fact', importance: 0.9 });
    expect(mergeMemories(db, 'mg-w', 'mg-l')).toBe(true);
    const winner = findMemories(db, { scopePrefixes: ['proj:mg'], includeExpired: true });
    const w = winner.find((e) => e.id === 'mg-w');
    const l = winner.find((e) => e.id === 'mg-l');
    expect(w?.importance).toBe(0.9); // absorbed the loser's importance
    expect(w?.tags).toEqual(['keepme']);
    expect(l?.expiresAt).toBe(0); // archived, not deleted
  });
});

describe('insertRelation / insertCandidate defaults', () => {
  it('generates ids and applies default weight/confidence when omitted', () => {
    const before = dbStats(db);
    insertRelation(db, { sourceId: 'sim-a', targetId: 'sim-b', relation: 'RELATES_TO' });
    expect(dbStats(db).relations).toBe(before.relations + 1);
    const rel = getNeighbors(db, 'sim-a', { relationFilter: ['RELATES_TO'] });
    expect(rel.length).toBe(1);

    const candidateId = insertCandidate(db, { content: 'default confidence probe' });
    const candidate = getCandidate(db, candidateId);
    expect(candidate?.confidence).toBe(0.7);
    expect(candidate?.status).toBe('pending');
  });
});

describe('findMemories filter arms', () => {
  beforeAll(() => {
    insertEntity(db, { id: 'fm-explicit', type: 'memory_entry', scopePath: 'proj:fm/file:x.ts', name: 'x', content: 'explicit types probe', memoryKind: 'fact', importance: 0.9, expiresAt: Date.now() - 1000, tags: ['legacy'] });
    insertEntity(db, { id: 'fm-file', type: 'file', scopePath: 'proj:fm/file:y.ts', name: 'y.ts', content: 'not a memory' });
  });

  it('honours an explicit types filter (not just the memory_entry default)', () => {
    const files = findMemories(db, { types: ['file'], scopePrefixes: ['proj:fm'] });
    expect(files.some((e) => e.id === 'fm-file')).toBe(true);
    expect(files.every((e) => e.type === 'file')).toBe(true);
  });

  it('treats importanceMin as optional', () => {
    const all = findMemories(db, { scopePrefixes: ['proj:fm'], includeExpired: true });
    expect(all.length).toBeGreaterThan(0);
  });

  it('includes expired memories only when explicitly asked', () => {
    const fresh = findMemories(db, { scopePrefixes: ['proj:fm'] });
    expect(fresh.some((e) => e.id === 'fm-explicit')).toBe(false);
    const withExpired = findMemories(db, { scopePrefixes: ['proj:fm'], includeExpired: true });
    expect(withExpired.some((e) => e.id === 'fm-explicit')).toBe(true);
  });

  it('filters by tag', () => {
    const tagged = findMemories(db, { scopePrefixes: ['proj:fm'], tags: ['legacy'], includeExpired: true });
    expect(tagged.some((e) => e.id === 'fm-explicit')).toBe(true);
    expect(findMemories(db, { scopePrefixes: ['proj:fm'], tags: ['nope'], includeExpired: true })).toEqual([]);
  });
});
