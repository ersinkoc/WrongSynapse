/**
 * connection.ts — row-coercion branches (toRecord / mapAll) exercised through
 * a fake better-sqlite3 driver that returns crafted non-record rows. Real
 * SQLite drivers never produce these shapes from valid SQL, so the defensive
 * arms are reached deterministically via the driver boundary they guard.
 */

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = { get: undefined as unknown, all: [] as unknown[] };
  return { rows };
});

vi.mock('better-sqlite3', () => ({
  default: () => ({
    pragma: () => [],
    exec: () => {},
    prepare: () => ({
      get: () => mocks.rows.get,
      all: () => mocks.rows.all,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    }),
    close: () => {},
    transaction: (fn: () => unknown) => fn,
  }),
}));

import { openDatabase } from './connection.js';

describe('row coercion (toRecord / mapAll)', () => {
  it('maps a null/undefined driver row to undefined (no row)', async () => {
    const db = await openDatabase(':memory:');
    mocks.rows.get = null;
    expect(db.prepare('SELECT 1').get()).toBeUndefined();
    mocks.rows.get = undefined;
    expect(db.prepare('SELECT 1').get()).toBeUndefined();
  });

  it('throws a TypeError for a non-object row', async () => {
    const db = await openDatabase(':memory:');
    mocks.rows.get = 42;
    expect(() => db.prepare('SELECT 1').get()).toThrow(/expected a row object/);
  });

  it('drops null/undefined entries from all() but keeps valid rows', async () => {
    const db = await openDatabase(':memory:');
    mocks.rows.all = [null, undefined, { id: 'ok' }];
    expect(db.prepare('SELECT 1').all()).toEqual([{ id: 'ok' }]);
  });
});
