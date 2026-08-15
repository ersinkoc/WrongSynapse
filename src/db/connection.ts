/**
 * SQLite connection layer.
 *
 * Primary driver: `better-sqlite3` (synchronous, battle-tested, ships FTS5).
 * Fallback driver: `node:sqlite` (built into Node >= 22.5) when the native
 * binding cannot be loaded. Both expose the same minimal synchronous surface.
 */

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
}

/** SQLite pragmas required by the WrongSynapse data model. */
const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
] as const;

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
}

async function createBetterSqlite(dbPath: string): Promise<SynapseDatabase> {
  // Dynamic import: a missing/broken native binding fails here, not at module
  // load, so the node:sqlite fallback can still be attempted.
  const mod = await import('better-sqlite3');
  const raw = mod.default(dbPath) as unknown as BetterDatabaseLike;
  for (const pragma of PRAGMAS) raw.pragma(pragma);
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
export async function openDatabase(dbPath: string): Promise<SynapseDatabase> {
  let betterError: unknown;
  try {
    return await createBetterSqlite(dbPath);
  } catch (error) {
    betterError = error;
  }
  try {
    return await createNodeSqlite(dbPath);
  } catch (error) {
    throw new Error(
      `No usable SQLite driver for '${dbPath}'. better-sqlite3 failed: ` +
        `${describeError(betterError)}; node:sqlite failed: ${describeError(error)}`,
    );
  }
}
