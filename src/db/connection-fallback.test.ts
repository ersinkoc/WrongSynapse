/**
 * connection.ts — node:sqlite fallback and combined-failure diagnostics.
 *
 * better-sqlite3 is mocked to throw at open time, forcing the fallback path.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => ({
  default: () => {
    throw new Error('native binding unavailable');
  },
}));

import { openDatabase } from './connection.js';

describe('openDatabase (node:sqlite fallback)', () => {
  it('falls back to node:sqlite when better-sqlite3 cannot load', async () => {
    const db = await openDatabase(':memory:');
    expect(db.backend).toBe('node:sqlite');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    insert.run('x');
    expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'x' });
    expect(db.prepare('SELECT v FROM t WHERE v = ?').get('nope')).toBeUndefined();
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'x' }]);
    db.close();
  });

  it('commits and rolls back transactions on node:sqlite', async () => {
    const db = await openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.['n']).toBe(1);

    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('bad');
        throw new Error('rollback me');
      }),
    ).toThrow('rollback me');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.['n']).toBe(1);
    db.close();
  });
});
