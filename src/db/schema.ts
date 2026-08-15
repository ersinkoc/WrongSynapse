/**
 * Schema bootstrap and versioned migrations.
 *
 * Versioning uses `PRAGMA user_version`; each migration runs inside a
 * transaction. Migration 1 implements the canonical WrongSynapse data model
 * (entities, relations, FTS5 external-content table + sync triggers,
 * entity_vectors, memory_candidates) plus supporting indexes.
 */

import { describeError, type SynapseDatabase } from './connection.js';

const MIGRATION_V1 = `
-- 1. UNIFIED ENTITY HIERARCHY
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL, -- 'project', 'package', 'directory', 'file', 'symbol', 'memory_entry', 'decision', 'command_run', 'commit'
    scope_path TEXT NOT NULL, -- URI-like: "proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken"
    name TEXT NOT NULL,
    content TEXT,
    metadata JSON,
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities(scope_path);

-- 2. KNOWLEDGE GRAPH RELATIONS (SYNAPSE EDGES)
CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL, -- 'CONTAINS', 'ANCHORED_TO', 'CALLS', 'DEPENDS_ON', 'SUPERSEDES', 'INTRODUCED_BY_COMMIT'
    weight REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(source_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY(target_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique ON relations(source_id, target_id, relation);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);

-- 3. FULL-TEXT SEARCH (FTS5, external content, auto-synced by triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name,
    content,
    scope_path,
    content='entities',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, content, scope_path) VALUES (new.rowid, new.name, new.content, new.scope_path);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content, scope_path) VALUES('delete', old.rowid, old.name, old.content, old.scope_path);
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content, scope_path) VALUES('delete', old.rowid, old.name, old.content, old.scope_path);
  INSERT INTO entities_fts(rowid, name, content, scope_path) VALUES (new.rowid, new.name, new.content, new.scope_path);
END;

-- 4. VECTOR EMBEDDINGS (Local Cosine / Raw BLOB Storage)
CREATE TABLE IF NOT EXISTS entity_vectors (
    entity_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL, -- Float32Array (384 float values)
    FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

-- 5. SAGE-COMPATIBLE EPISODIC MEMORY CANDIDATES
CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    scope_path TEXT,
    extracted_from TEXT, -- tool execution, user prompt, agent thought
    confidence REAL DEFAULT 0.7,
    status TEXT DEFAULT 'pending', -- 'pending', 'promoted', 'discarded'
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status);
`;

export const MIGRATIONS: readonly string[] = [MIGRATION_V1];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

/**
 * Bring the database schema up to the current version. Idempotent; safe to
 * call on every boot.
 */
export function migrate(db: SynapseDatabase): void {
  const row = db.prepare('PRAGMA user_version').get();
  // The non-number arm is defensive: `PRAGMA user_version` always returns an
  // integer row on both drivers.
  /* v8 ignore next */
  let version = typeof row?.['user_version'] === 'number' ? (row['user_version'] as number) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1};`);
    });
    version += 1;
  }
}

/**
 * Verify that the underlying SQLite build ships FTS5 (required by the lexical
 * search engine). Throws a descriptive error when missing.
 */
export function assertFts5(db: SynapseDatabase): void {
  try {
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS _synapse_fts_probe USING fts5(probe); DROP TABLE IF EXISTS _synapse_fts_probe;',
    );
  } catch (error) {
    throw new Error(
      `SQLite build lacks FTS5 support (required for lexical/BM25 search): ${describeError(error)}`,
    );
  }
}
