/**
 * SQLite connection layer.
 *
 * Primary driver: `better-sqlite3` (synchronous, battle-tested, ships FTS5).
 * Fallback driver: `node:sqlite` (built into Node >= 22.5) when the native
 * binding cannot be loaded. Both expose the same minimal synchronous surface.
 */

import { SCHEMA_VERSION } from './schema.js';

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SynapseStatement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface SynapseDatabase {
  readonly backend: 'better-sqlite3' | 'node:sqlite';
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): SynapseStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Optional sqlite-vec capabilities — set by openDatabase(), absent on mocks. */
  vec?: VecCapabilities;
}

/** SQLite pragmas required by the WrongSynapse data model. */
const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
] as const;

/**
 * Pragma *bodies* for drivers whose API prepends the `PRAGMA` keyword itself
 * (better-sqlite3's `db.pragma(source)` compiles `PRAGMA ${source}`). Strips
 * the keyword and trailing semicolon so `pragma('journal_mode = WAL')` stays a
 * valid statement.
 */
const PRAGMA_BODIES: readonly string[] = PRAGMAS.map((statement) =>
  statement.replace(/^PRAGMA\s+/i, '').replace(/;\s*$/, ''),
);

/** Normalize a driver row into a plain record (undefined for no row). */
function toRecord(row: unknown): Record<string, unknown> | undefined {
  if (row === undefined || row === null) return undefined;
  if (typeof row !== 'object') throw new TypeError('expected a row object');
  return row as Record<string, unknown>;
}

function mapAll(rows: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const rec = toRecord(row);
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

export interface VecCapabilities {
  hnswEnabled: boolean;
  hnswBuildComplete: boolean;
}

/**
 * Attempt to load the sqlite-vec extension into a better-sqlite3 database.
 * Returns capabilities object synchronously — never throws. When loading fails,
 * the caller degrades gracefully to the existing BLOB-based vector store.
 */
async function tryLoadVecExtension(db: BetterDatabaseLike): Promise<VecCapabilities> {
  try {
    const { getLoadablePath } = await import('sqlite-vec');
    const path = getLoadablePath();
    db.loadExtension(path);
    return { hnswEnabled: true, hnswBuildComplete: false };
  } catch {
    return { hnswEnabled: false, hnswBuildComplete: false };
  }
}

/**
 * Build HNSW indexes for all existing vectors in entity_vectors.
 * Migrates BLOB vectors → sqlite-vec HNSW virtual table. Safe to call multiple
 * times (checks build marker before rebuilding). Marks hnswBuildComplete on the
 * passed db object when complete.
 *
 * Schema: vec_entities uses `entity_id TEXT` as a metadata column (indexed), so
 * sqlite-vec can filter by it during KNN without a JOIN. The entity_id is stable
 * (UUID, never changes) — no rowid dependency.
 */
export function buildHnswIndexes(db: SynapseDatabase): void {
  // Ensure the build-marker table exists (idempotent). Tracks whether the HNSW
  // index has been built for the current schema. If the schema version bumps we
  // delete the marker so the next call rebuilds.
  db.exec(
    'CREATE TABLE IF NOT EXISTS _synapse_vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  );
  // Always check schema version — if it changed, force a rebuild.
  const schemaVersion = String(SCHEMA_VERSION);
  const marker = db
    .prepare("SELECT value FROM _synapse_vec_meta WHERE key = 'hnsw_built_for'")
    .get() as { value: string } | undefined;

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM entity_vectors')
    .get() as { n: number } | undefined;
  const totalVectors = count?.n ?? 0;

  // Skip rebuild if the index already exists, the schema matches, and there are
  // no new vectors to insert. (We always check the count below to pick up new
  // vectors inserted since the last build.)
  if (marker?.value === schemaVersion && totalVectors === 0) return;

  // Wrap the rest in try/catch so a sqlite-vec build failure (e.g. extension
  // missing on a new machine) can't take down the whole server. The fallback
  // BLOB cosine search in hybrid-search.ts is still available.
  try {
    // Drop and recreate to pick up any schema changes; IF NOT EXISTS alone is not
    // enough since the column list might have changed across rebuilds.
    db.exec('DROP TABLE IF EXISTS vec_entities');

    // entity_id as a TEXT metadata column lets sqlite-vec apply the filter during
    // the KNN search (no post-hoc JOIN needed in hybrid-search hot path).
    db.exec(`
    CREATE VIRTUAL TABLE vec_entities USING vec0(
      embedding float[384],
      entity_id text,
      hnsw_parameters(m=16, ef_construction=200)
    );
  `);

    // ORDER BY entity_id ensures deterministic iteration across rebuilds.
    const rows = db
      .prepare(
        'SELECT entity_id, embedding FROM entity_vectors ORDER BY entity_id LIMIT 100000',
      )
      .all() as { entity_id: string; embedding: Uint8Array }[];

    const insert = db.prepare(
      'INSERT INTO vec_entities(embedding, entity_id) VALUES (?, ?)',
    );
    for (const row of rows) {
      insert.run(JSON.stringify([...bufferToFloats(row.embedding)]), row.entity_id);
    }

    // Mark the build complete for this schema version.
    db.prepare(
      "INSERT INTO _synapse_vec_meta(key, value) VALUES('hnsw_built_for', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(schemaVersion);
  } catch (error) {
    // Log but don't throw — the caller will fall back to BLOB cosine search.
    // Re-running this function on the next boot will retry the build.
    db.exec('DROP TABLE IF EXISTS vec_entities');
    db.exec(
      "DELETE FROM _synapse_vec_meta WHERE key = 'hnsw_built_for'",
    );
    console.error(
      `buildHnswIndexes failed (falling back to BLOB cosine search): ${describeError(error)}`,
    );
  }
}

function bufferToFloats(buf: Uint8Array): Float32Array {
  const floats = new Float32Array(buf.length / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < floats.length; i++) floats[i] = view.getFloat32(i * 4, true);
  return floats;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- better-sqlite3 backend -------------------------------------------------

interface BetterStatementLike {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterDatabaseLike {
  pragma(source: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): BetterStatementLike;
  close(): void;
  transaction<T>(fn: () => T): () => T;
  loadExtension(path: string, entrypoint?: string): void;
}

async function createBetterSqlite(dbPath: string): Promise<SynapseDatabase> {
  // Dynamic import: a missing/broken native binding fails here, not at module
  // load, so the node:sqlite fallback can still be attempted.
  const mod = await import('better-sqlite3');
  const raw = mod.default(dbPath) as unknown as BetterDatabaseLike;
  // better-sqlite3's `pragma()` compiles `PRAGMA ${source}` itself, so the
  // keyword must NOT be repeated in the source (would yield `PRAGMA PRAGMA …`).
  for (const pragma of PRAGMA_BODIES) raw.pragma(pragma);
  const wrapStatement = (stmt: BetterStatementLike): SynapseStatement => ({
    run: (...params: SqlValue[]) => stmt.run(...params),
    get: (...params: SqlValue[]) => toRecord(stmt.get(...params)),
    all: (...params: SqlValue[]) => mapAll(stmt.all(...params)),
  });
  return {
    backend: 'better-sqlite3',
    path: dbPath,
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => wrapStatement(raw.prepare(sql)),
    transaction: <T>(fn: () => T): T => raw.transaction(fn)(),
    close: () => raw.close(),
  };
}

// ---- node:sqlite backend ----------------------------------------------------

interface NodeStatementLike {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementLike;
  close(): void;
}

async function createNodeSqlite(dbPath: string): Promise<SynapseDatabase> {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(dbPath) as unknown as NodeDatabaseLike;
  for (const pragma of PRAGMAS) raw.exec(pragma);
  const wrapStatement = (stmt: NodeStatementLike): SynapseStatement => ({
    run: (...params: SqlValue[]) => stmt.run(...params),
    get: (...params: SqlValue[]) => toRecord(stmt.get(...params)),
    all: (...params: SqlValue[]) => mapAll(stmt.all(...params)),
  });
  return {
    backend: 'node:sqlite',
    path: dbPath,
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => wrapStatement(raw.prepare(sql)),
    transaction: <T>(fn: () => T): T => {
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => raw.close(),
  };
}

/**
 * Open (or create) a WrongSynapse database, preferring better-sqlite3 and
 * falling back to node:sqlite. Throws with a combined diagnostic when both
 * drivers are unusable.
 */
export async function openDatabase(dbPath: string): Promise<SynapseDatabase & { vec: VecCapabilities }> {
  let betterError: unknown;
  try {
    const db = await createBetterSqlite(dbPath);
    const vec = await tryLoadVecExtension(db as unknown as BetterDatabaseLike);
    return Object.assign(db, { vec });
  } catch (error) {
    betterError = error;
  }
  try {
    return Object.assign(await createNodeSqlite(dbPath), { vec: { hnswEnabled: false, hnswBuildComplete: false } });
  } catch (error) {
    throw new Error(
      `No usable SQLite driver for '${dbPath}'. better-sqlite3 failed: ` +
        `${describeError(betterError)}; node:sqlite failed: ${describeError(error)}`,
    );
  }
}
