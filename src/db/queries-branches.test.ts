/**
 * queries.ts — mapper and branch arms reached through a fake SynapseDatabase
 * whose prepared statements return crafted rows. Covers the coercion helpers'
 * defensive arms (reqStr throw, parseMetadata variants) and the query-builder
 * branches (type filters, empty filters, neighbor caps, decode errors).
 */

import { describe, expect, it, vi } from 'vitest';

import type { SynapseDatabase } from './connection.js';
import {
  escapeFtsQuery,
  getEntity,
  getEntityByScope,
  getNeighbors,
  getVectors,
  searchFts,
  findEntitiesByScope,
} from './queries.js';

function fakeDb(row: unknown = undefined, rows: unknown[] = []): SynapseDatabase {
  return {
    backend: 'better-sqlite3',
    path: ':memory:',
    exec: () => {},
    close: () => {},
    transaction: <T>(fn: () => T): T => fn(),
    prepare: () => ({
      get: vi.fn(() => row),
      all: vi.fn(() => rows),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    }),
  };
}

describe('entity mapper defensive arms', () => {
  it('reqStr throws for a non-string required column', () => {
    expect(() => getEntity(fakeDb({ id: 7 }), '7')).toThrow(/column 'id' is not a string/);
  });

  it('parseMetadata returns the parsed object for valid JSON objects', () => {
    const entity = getEntity(fakeDb({ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n', metadata: '{"a":1}' }), 'x');
    expect(entity?.metadata).toEqual({ a: 1 });
  });

  it('parseMetadata tolerates an object value straight from the driver', () => {
    const entity = getEntity(fakeDb({ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n', metadata: { b: 2 } }), 'x');
    expect(entity?.metadata).toEqual({ b: 2 });
  });

  it('parseMetadata maps undefined to null', () => {
    const entity = getEntity(fakeDb({ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n', metadata: undefined }), 'x');
    expect(entity?.metadata).toBeNull();
  });
});

describe('getEntityByScope type filter arms', () => {
  it('adds a type clause when types are given', () => {
    const db = fakeDb({ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n' });
    expect(getEntityByScope(db, 'proj:p', ['file'])).toBeDefined();
    expect(getEntityByScope(db, 'proj:p', [])).toBeDefined();
  });
});

describe('escapeFtsQuery / searchFts empty-token arms', () => {
  it('returns null for a query with no usable tokens', () => {
    expect(escapeFtsQuery('!!! ???')).toBeNull();
    expect(escapeFtsQuery('')).toBeNull();
  });

  it('searchFts returns [] when no tokens survive escaping', () => {
    expect(searchFts(fakeDb(), '!!!', 10)).toEqual([]);
  });
});

describe('findEntitiesByScope clause arms', () => {
  it('builds WHERE clauses for prefixes, types, both, and neither', () => {
    const rows = [{ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n' }];
    const db = fakeDb(undefined, rows);
    expect(findEntitiesByScope(db, {})).toHaveLength(1);
    expect(findEntitiesByScope(db, { scopePrefixes: ['proj:p'] })).toHaveLength(1);
    expect(findEntitiesByScope(db, { types: ['file'] })).toHaveLength(1);
    expect(findEntitiesByScope(db, { scopePrefixes: ['proj:p'], types: ['file'] })).toHaveLength(1);
  });
});

describe('getNeighbors traversal arms', () => {
  function graphDb(): SynapseDatabase {
    // Direction-aware fake: match on the WHERE clause, not bare column names —
    // inStmt's SELECT list also contains 'source_id' ("source_id AS neighbor_id").
    const make = (sql: string) => ({
      get: vi.fn(),
      all: vi.fn(() => (sql.includes('WHERE source_id') ? [{ neighbor_id: 'n1', relation: 'CALLS' }] : [])),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    });
    return {
      backend: 'better-sqlite3',
      path: ':memory:',
      exec: () => {},
      close: () => {},
      transaction: <T>(fn: () => T): T => fn(),
      prepare: (sql: string) => make(sql),
    };
  }

  it('caps traversal at maxNodes', () => {
    const hits = getNeighbors(graphDb(), 'root', { depth: 5, maxNodes: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('stops at depth even with a live frontier', () => {
    const hits = getNeighbors(graphDb(), 'root', { depth: 1 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.depth === 1)).toBe(true);
  });

  it('skips already-seen edges (seenEdge continue arm)', () => {
    // Depth 2 re-scans 'root' (n1 has no out-edges, so the frontier returns);
    // the identical out-edge must be deduplicated, not re-emitted.
    const hits = getNeighbors(graphDb(), 'root', { depth: 2 });
    expect(hits.filter((h) => h.entityId === 'n1')).toHaveLength(1);
  });

  it('follows direction=in edges', () => {
    const db = {
      backend: 'better-sqlite3' as const,
      path: ':memory:',
      exec: () => {},
      close: () => {},
      transaction: <T>(fn: () => T): T => fn(),
      prepare: (sql: string) => ({
        get: vi.fn(),
        all: vi.fn(() => (sql.includes('WHERE target_id') ? [{ neighbor_id: 'caller', relation: 'CALLS' }] : [])),
        run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      }),
    };
    const hits = getNeighbors(db, 'root', { direction: 'in' });
    expect(hits.map((h) => h.entityId)).toEqual(['caller']);
    expect(hits[0]!.direction).toBe('in');
  });
});

describe('getVectors decode arm', () => {
  it('throws a TypeError for a non-BLOB embedding column', () => {
    const db = fakeDb(undefined, [
      { entity_id: 'v', scope_path: 'proj:p', type: 'file', embedding: 'not-a-blob' },
    ]);
    expect(() => getVectors(db, {})).toThrow(/embedding column is not a BLOB/);
  });
});

describe('getNeighbors diamond traversal arms', () => {
  // root -> a, root -> b, a -CALLS-> c, b -CONTAINS-> c: c is reachable through
  // two DISTINCT (relation, direction) keys, so it is emitted twice but
  // enqueued (traversed) only once.
  function diamondDb(): SynapseDatabase {
    const edges: Record<string, { id: string; neighbor_id: string; relation: string }[]> = {
      root: [
        { id: 'e1', neighbor_id: 'a', relation: 'CALLS' },
        { id: 'e2', neighbor_id: 'b', relation: 'CALLS' },
      ],
      a: [{ id: 'e3', neighbor_id: 'c', relation: 'CALLS' }],
      b: [{ id: 'e4', neighbor_id: 'c', relation: 'CONTAINS' }],
    };
    return {
      backend: 'better-sqlite3',
      path: ':memory:',
      exec: () => {},
      close: () => {},
      transaction: <T>(fn: () => T): T => fn(),
      prepare: (sql: string) => ({
        get: vi.fn(),
        all: vi.fn((...params: unknown[]) =>
          sql.includes('WHERE source_id') ? (edges[String(params[0])] ?? []) : [],
        ),
        run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      }),
    };
  }

  it('emits both edges to a shared neighbor without re-enqueueing the node', () => {
    const hits = getNeighbors(diamondDb(), 'root', { depth: 2 });
    expect(hits.filter((h) => h.entityId === 'c')).toHaveLength(2); // via a and via b
    expect(hits).toHaveLength(4); // a, b, c, c — c is not traversed twice
  });

  it('stops scanning mid-frontier once maxNodes results are collected', () => {
    const hits = getNeighbors(diamondDb(), 'root', { depth: 2, maxNodes: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe('parseMetadata JSON null arm', () => {
  it('maps a JSON null literal to null', () => {
    const entity = getEntity(
      fakeDb({ id: 'x', type: 'file', scope_path: 'proj:p', name: 'n', metadata: 'null' }),
      'x',
    );
    expect(entity?.metadata).toBeNull();
  });
});
