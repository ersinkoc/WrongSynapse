/**
 * connection.ts — better-sqlite3 backend (primary) and helpers.
 *
 * NOTE: before the PRAGMA fix, `createBetterSqlite` threw at the pragma loop
 * ("PRAGMA PRAGMA …") and every test silently ran on the node:sqlite fallback.
 * These tests pin the primary backend: it must load, apply the four pragmas,
 * and serve the minimal SynapseDatabase surface.
 */

import { describe, expect, it } from 'vitest';

import { describeError, openDatabase } from './connection.js';

describe('openDatabase (better-sqlite3 primary)', () => {
  it('opens an in-memory database on the better-sqlite3 backend', async () => {
    const db = await openDatabase(':memory:');
    expect(db.backend).toBe('better-sqlite3');
    db.close();
  });

  it('applies the required pragmas', async () => {
    const db = await openDatabase(':memory:');
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
    expect(['wal', 'memory']).toContain(row['journal_mode']);
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number };
    expect(fk['foreign_keys']).toBe(1);
    db.close();
  });

  it('serves prepare/run/get/all and transactions', async () => {
    const db = await openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const result = insert.run('a');
    expect(result.changes).toBe(1);
    expect(insert.run('b').changes).toBe(1);

    const one = db.prepare('SELECT v FROM t WHERE v = ?').get('a');
    expect(one).toEqual({ v: 'a' });
    const missing = db.prepare('SELECT v FROM t WHERE v = ?').get('zzz');
    expect(missing).toBeUndefined();
    const all = db.prepare('SELECT v FROM t ORDER BY v').all();
    expect(all.map((r) => r['v'])).toEqual(['a', 'b']);

    const committed = db.transaction(() => {
      insert.run('c');
    });
    expect(committed).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.['n']).toBe(3);
    db.close();
  });

  it('rolls back a throwing transaction', async () => {
    const db = await openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.['n']).toBe(0);
    db.close();
  });

  it('passes Uint8Array values through', async () => {
    const db = await openDatabase(':memory:');
    db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO b (data) VALUES (?)').run(new Uint8Array([1, 2, 3]));
    const row = db.prepare('SELECT data FROM b').get() as { data: Uint8Array };
    expect(Array.from(row['data'])).toEqual([1, 2, 3]);
    db.close();
  });
});

describe('describeError', () => {
  it('extracts Error messages', () => {
    expect(describeError(new Error('kaboom'))).toBe('kaboom');
  });

  it('stringifies non-Error values', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ code: 42 })).toBe('[object Object]');
    expect(describeError(null)).toBe('null');
  });
});
