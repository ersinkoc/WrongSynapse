/**
 * parser.ts — tree-sitter load failure (getTreeSitter catch): mocked at module
 * level so the lazily-cached loader takes the failure branch on first use.
 * Files must still be indexed structurally; a warning must be recorded.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('web-tree-sitter', () => {
  throw new Error('wasm loader missing (simulated)');
});

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let db: SynapseDatabase;
let dir: string;
const embedder = new FakeEmbedder();

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), 'synapse-nots-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-ts' }));
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() { return 1; }\n');
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexWorkspace without tree-sitter', () => {
  it('degrades to structural indexing with a warning', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: dir });
    expect(result.warnings.some((w) => w.includes('tree-sitter unavailable'))).toBe(true);
    expect(result.symbolsIndexed).toBe(0); // no AST symbols
    expect(result.filesScanned).toBe(2);
    // The file entity still exists and is searchable.
    const files = findEntitiesByScope(db, { scopePrefixes: ['proj:no-ts'], types: ['file'] }).map((f) => f.name);
    expect(files).toContain('a.ts');
  });
});
