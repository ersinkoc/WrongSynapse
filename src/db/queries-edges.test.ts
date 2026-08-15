/**
 * queries.ts — row-coercion edge branches reached through raw SQL (SQLite is
 * dynamically typed, so wrong-typed columns and corrupt metadata JSON are
 * real-world possibilities the mappers must tolerate).
 *
 * Each test uses its own row: several assertions depend on deliberately
 * corrupt column values, and a shared row would contaminate later reads.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from './connection.js';
import { migrate } from './schema.js';
import { getEntity, insertEntity, optionalNumber } from './queries.js';

let db: SynapseDatabase;
let seq = 0;

/** Insert a fresh, well-formed entity and return its id. */
function freshRow(): string {
  seq += 1;
  const id = `typed-${seq}`;
  insertEntity(db, {
    id,
    type: 'file',
    scopePath: `proj:t/file:t${seq}.ts`,
    name: `t${seq}.ts`,
    content: 'ok',
  });
  return id;
}

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
});

afterAll(() => {
  db.close();
});

describe('row coercion edge branches', () => {
  it('coerces a non-numeric confidence to NaN through num() (documented semantics)', () => {
    const id = freshRow();
    // 'abc' is not a valid REAL, so affinity keeps it TEXT. num() coerces via
    // Number() — corrupt numeric columns surface as NaN (the coercing mapper),
    // unlike optional columns which degrade to null.
    db.prepare("UPDATE entities SET confidence = 'abc' WHERE id = ?").run(id);
    const entity = getEntity(db, id);
    expect(entity).toBeDefined();
    expect(entity!.confidence).toBeNaN();
  });

  it('maps corrupt metadata JSON to null (parseMetadata string-fail branch)', () => {
    const id = freshRow();
    db.prepare("UPDATE entities SET metadata = 'not-json{' WHERE id = ?").run(id);
    expect(getEntity(db, id)?.metadata).toBeNull();
  });

  it('maps non-object metadata JSON to null (parseMetadata scalar branch)', () => {
    const id = freshRow();
    db.prepare("UPDATE entities SET metadata = '123' WHERE id = ?").run(id);
    expect(getEntity(db, id)?.metadata).toBeNull();
  });

  it('maps non-string non-object metadata to null (parseMetadata non-string branch)', () => {
    const id = freshRow();
    db.prepare('UPDATE entities SET metadata = 7 WHERE id = ?').run(id);
    expect(getEntity(db, id)?.metadata).toBeNull();
  });

  it('optionalNumber coerces numbers and rejects everything else', () => {
    expect(optionalNumber({ n: 5 }, 'n')).toBe(5);
    expect(optionalNumber({ n: '5' }, 'n')).toBeNull();
    expect(optionalNumber({}, 'n')).toBeNull();
  });
});
