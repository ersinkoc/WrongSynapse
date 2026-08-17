import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from './connection.js';
import { assertFts5, migrate, SCHEMA_VERSION } from './schema.js';
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

// ESM-friendly bridge for the CommonJS `better-sqlite3` native binding used in
// the partial-migration fixture test. `createRequire` keeps the binding through
// Vitest's module-resolution pipeline (a bare `require()` inside an ESM file
// triggers Vitest's `require-not-allowed` lint rule).
const requireNative = createRequire(import.meta.url);

let db: SynapseDatabase;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  assertFts5(db);
});

afterAll(() => {
  db.close();
});

describe('assertFts5 failure branch', () => {
  it('throws a descriptive error when the SQLite build lacks FTS5', () => {
    const broken = {
      exec: () => {
        throw new Error('no such module: fts5');
      },
    } as unknown as SynapseDatabase;
    expect(() => assertFts5(broken)).toThrow(/lacks FTS5 support/);
  });
});


describe('migrations', () => {
  it('advances user_version to SCHEMA_VERSION and creates the FTS table', () => {
    const row = db.prepare('PRAGMA user_version').get();
    expect(row?.['user_version']).toBe(SCHEMA_VERSION);
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities_fts'").get();
    expect(fts).toBeDefined();
  });

  it('v4: scopes the FTS update trigger to the indexed columns only', async () => {
    // The v1 trigger fired on EVERY update; v4 must replace it with an
    // AFTER UPDATE OF (name, content, scope_path) variant so access tracking
    // (last_accessed_at) does not rewrite the FTS row.
    const trigger = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'entities_au'")
      .get() as { sql: string };
    expect(trigger.sql).toContain('AFTER UPDATE OF name, content, scope_path');
    // touchMemory must not churn FTS: capture the FTS row's state, touch,
    // confirm the entity updated but the FTS row was NOT deleted/reinserted.
    const { touchMemory } = await import('./queries.js');
    insertEntity(db, { id: 'v4mem', type: 'memory_entry', scopePath: 'proj:t/file:v4.ts', name: 'v4', content: 'fts churn probe' });
    const before = db.prepare("SELECT count(*) AS n FROM entities_fts WHERE entities_fts MATCH 'churn'").get() as { n: number };
    expect(before.n).toBe(1);
    touchMemory(db, 'v4mem');
    const after = db.prepare("SELECT count(*) AS n FROM entities_fts WHERE entities_fts MATCH 'churn'").get() as { n: number };
    expect(after.n).toBe(1); // still indexed, row was not cycled
    const entity = getEntity(db, 'v4mem');
    expect(entity?.lastAccessedAt).not.toBeNull();
  });

  it('v2 idempotency arm: an empty dynamic SQL batch still advances the version', () => {
    // A database sitting at version 1 whose v2 columns all exist must bump
    // user_version without executing any SQL (the `sql.trim().length > 0`
    // false arm).
    const row = db.prepare('PRAGMA user_version').get();
    expect(row?.['user_version']).toBe(SCHEMA_VERSION); // all migrations ran
    db.exec('PRAGMA user_version = 1'); // rewind to force the v2 loop pass
    migrate(db);
    expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — calling migrate again does not error on partial state', () => {
    // Simulate a PARTIAL v2 migration: `memory_kind` was added on a previous
    // boot but the rest of the v2 columns never landed (e.g. process crashed
    // mid-migration, or an older SQLite build hit the `ADD COLUMN IF NOT
    // EXISTS` syntax error). The next migrate() must add the missing columns
    // without touching the ones already present.
    const fresh = requireNative('better-sqlite3')(':memory:');
    fresh.pragma('journal_mode = WAL');
    fresh.pragma('foreign_keys = ON');
    fresh.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope_path TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT,
        metadata JSON,
        confidence REAL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        memory_kind TEXT DEFAULT 'general'
      );
    `);
    expect(() => {
      // Wrap the raw better-sqlite3 instance into a SynapseDatabase-compatible
      // shim and call migrate on it. The v2 migration should inspect
      // table_info(entities) and add only the missing columns.
      const shim = {
        exec: (sql: string) => fresh.exec(sql),
        prepare: (sql: string) => {
          const s = fresh.prepare(sql);
          return {
            run: (...p: unknown[]) => s.run(...(p as never[])),
            get: (...p: unknown[]) => s.get(...(p as never[])),
            all: (...p: unknown[]) => s.all(...(p as never[])),
          };
        },
        transaction: <T>(fn: () => T): T => fresh.transaction(fn)(),
        close: () => fresh.close(),
      } as unknown as SynapseDatabase;
      migrate(shim);
    }).not.toThrow();
    // Verify the partial state was repaired:
    //  - memory_kind (already present) was preserved
    //  - importance, expires_at, last_accessed_at, tags were added
    const cols = fresh
      .prepare('PRAGMA table_info(entities)')
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).toContain('memory_kind');
    expect(cols).toContain('importance');
    expect(cols).toContain('expires_at');
    expect(cols).toContain('last_accessed_at');
    expect(cols).toContain('tags');
    fresh.close();
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
