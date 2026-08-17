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
  /** sqlite-vec extension loaded into the connection. */
  extensionLoaded: boolean;
  /** `vec_entities` virtual table built and kept in sync — usable for KNN. */
  indexReady: boolean;
  /** Dimension of the embeddings held by `vec_entities` (null before build). */
  indexDimension: number | null;
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
    return { extensionLoaded: true, indexReady: false, indexDimension: null };
  } catch (error) {
    console.error(
      `sqlite-vec extension unavailable (semantic search degrades to exact cosine scan): ${describeError(error)}`,
    );
    return { extensionLoaded: false, indexReady: false, indexDimension: null };
  }
}

/** Default vec0 column width when the database has no vectors yet (matches
 *  the default embedding model, all-MiniLM-L6-v2). */
export const DEFAULT_VEC_DIMENSION = 384;

/**
 * Build the `vec_entities` vec0 virtual table from the BLOB vectors in
 * `entity_vectors`, so hybrid search can use sqlite-vec's native KNN instead
 * of a full-table cosine scan. sqlite-vec 0.1.x is brute-force KNN (no HNSW);
 * the vec0 table exists to push the scan into C and keep runtime writes in
 * sync (queries.ts mirrors upserts/deletes into it).
 *
 * Skips the rebuild when the build marker matches the schema version AND the
 * indexed row count matches `entity_vectors` (runtime sync keeps the counts
 * aligned, so a mismatch means a stale or failed index). Returns true when
 * `vec_entities` is usable; on any failure the partial table is dropped,
 * `db.vec.indexReady` stays false, and callers fall back to BLOB cosine
 * search — which is exactly what hybrid-search.ts checks.
 *
 * Requires the entities/entity_vectors tables to exist (call after migrate()).
 */
export function buildVecIndex(db: SynapseDatabase): boolean {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _synapse_vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  );
  const metaGet = (key: string): string | undefined => {
    const row = db
      .prepare('SELECT value FROM _synapse_vec_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  };
  const schemaVersion = String(SCHEMA_VERSION);
  const marker = metaGet('vec_index_built_for');
  const storedCount = Number(metaGet('vec_index_count') ?? '-1');
  const storedDim = Number(metaGet('vec_index_dim') ?? '0');
  // COUNT(*) always returns exactly one row; the ?? 0 is a typing nicety.
  /* v8 ignore next */
  const blobCount = (
    db.prepare('SELECT COUNT(*) AS n FROM entity_vectors').get() as { n: number } | undefined
  )?.n ?? 0;
  const tableExists =
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'vec_entities'")
      .get() !== undefined;

  if (marker === schemaVersion && tableExists && storedCount === blobCount) {
    // Index is fresh: runtime sync in queries.ts has kept it aligned.
    if (db.vec !== undefined) {
      db.vec.indexReady = true;
      db.vec.indexDimension = storedDim > 0 ? storedDim : null;
    }
    return true;
  }

  try {
    // Derive the column width from the stored vectors so a non-default
    // embedding model still gets a matching vec0 table. All rows must share
    // the same dimension — a mixed-dimension corpus (user switched
    // SYNAPSE_EMBEDDING_MODEL) cannot be indexed; disable instead of
    // silently dropping rows.
    const first = db
      .prepare('SELECT embedding FROM entity_vectors ORDER BY entity_id LIMIT 1')
      .get() as { embedding: Uint8Array } | undefined;
    const dim = first !== undefined ? first.embedding.byteLength / 4 : DEFAULT_VEC_DIMENSION;
    if (!Number.isInteger(dim) || dim <= 0) {
      // `?? 0`: first is undefined only on the DEFAULT arm above, where dim
      // is a valid constant — the fallback is unreachable typing hygiene.
      /* v8 ignore next */
      throw new Error(`cannot derive embedding dimension from stored vectors (${first?.embedding.byteLength ?? 0} bytes)`);
    }

    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS vec_entities');
      db.exec(`CREATE VIRTUAL TABLE vec_entities USING vec0(embedding float[${dim}], entity_id text)`);
      const rows = db
        .prepare('SELECT entity_id, embedding FROM entity_vectors ORDER BY entity_id')
        .all() as { entity_id: string; embedding: Uint8Array }[];
      const insert = db.prepare('INSERT INTO vec_entities(embedding, entity_id) VALUES (?, ?)');
      for (const row of rows) {
        if (row.embedding.byteLength / 4 !== dim) {
          throw new Error(
            `mixed embedding dimensions in entity_vectors (${dim} vs ${row.embedding.byteLength / 4}); ` +
              'delete the database or re-index before enabling the vector index',
          );
        }
        // entity_vectors stores little-endian float32 BLOBs — exactly the
        // packed format vec0 accepts, so no re-serialization is needed.
        insert.run(row.embedding, row.entity_id);
      }
      db.prepare(
        "INSERT INTO _synapse_vec_meta(key, value) VALUES('vec_index_built_for', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(schemaVersion);
      db.prepare(
        "INSERT INTO _synapse_vec_meta(key, value) VALUES('vec_index_count', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(rows.length));
      db.prepare(
        "INSERT INTO _synapse_vec_meta(key, value) VALUES('vec_index_dim', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(dim));
    });
    if (db.vec !== undefined) {
      db.vec.indexReady = true;
      db.vec.indexDimension = dim;
    }
    return true;
  } catch (error) {
    // Log but don't throw — callers fall back to BLOB cosine search and the
    // next boot retries the build.
    try {
      db.exec('DROP TABLE IF EXISTS vec_entities');
      db.exec("DELETE FROM _synapse_vec_meta WHERE key LIKE 'vec_index_%'");
    } catch {
      // secondary failure while cleaning up: nothing further to do
    }
    // Defensive: mocked test databases have no vec capability object.
    /* v8 ignore next */
    if (db.vec !== undefined) db.vec.indexReady = false;
    console.error(
      `buildVecIndex failed (falling back to BLOB cosine search): ${describeError(error)}`,
    );
    return false;
  }
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

/**
 * Per-connection prepared-statement cache. SQL compilation is the dominant
 * fixed cost in the hot paths (every queries.ts call previously re-prepared),
 * and better-sqlite3/node:sqlite statements are safe to reuse until closed.
 *
 * Bounded: dynamic SQL (IN-list lengths, scope-prefix OR groups) produces an
 * unbounded key space, so the cache resets wholesale when it overflows —
 * amortized O(1) with a hard memory ceiling.
 */
const STATEMENT_CACHE_MAX = 512;

function createStatementCache<S>(compile: (sql: string) => S): (sql: string) => S {
  const cache = new Map<string, S>();
  return (sql: string): S => {
    const cached = cache.get(sql);
    if (cached !== undefined) return cached;
    if (cache.size >= STATEMENT_CACHE_MAX) cache.clear();
    const stmt = compile(sql);
    cache.set(sql, stmt);
    return stmt;
  };
}

async function createBetterSqlite(dbPath: string): Promise<{ db: SynapseDatabase; raw: BetterDatabaseLike }> {
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
  const cached = createStatementCache((sql: string) => wrapStatement(raw.prepare(sql)));
  const db: SynapseDatabase = {
    backend: 'better-sqlite3',
    path: dbPath,
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => cached(sql),
    transaction: <T>(fn: () => T): T => raw.transaction(fn)(),
    close: () => raw.close(),
  };
  // The raw handle travels alongside the wrapper: loadExtension exists only
  // on the driver's own Database object, and passing the wrapper here meant
  // the sqlite-vec extension silently never loaded.
  return { db, raw };
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
  const cached = createStatementCache((sql: string) => wrapStatement(raw.prepare(sql)));
  return {
    backend: 'node:sqlite',
    path: dbPath,
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => cached(sql),
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
    const { db, raw } = await createBetterSqlite(dbPath);
    // Extension loading needs the RAW driver handle (see createBetterSqlite).
    const vec = await tryLoadVecExtension(raw);
    return Object.assign(db, { vec });
  } catch (error) {
    betterError = error;
  }
  try {
    return Object.assign(await createNodeSqlite(dbPath), {
      vec: { extensionLoaded: false, indexReady: false, indexDimension: null },
    });
  } catch (error) {
    throw new Error(
      `No usable SQLite driver for '${dbPath}'. better-sqlite3 failed: ` +
        `${describeError(betterError)}; node:sqlite failed: ${describeError(error)}`,
    );
  }
}
