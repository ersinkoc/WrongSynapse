/**
 * parser.ts — option arms and fixture-driven branches that the main
 * indexWorkspace tests don't reach: nested monorepo packages, oversized-file
 * skip, depth cap, malformed manifests, unsupported extensions, and the
 * tree-sitter-unavailable degradation warning.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();
let dir: string;
let monorepo: string;
let emptyNameDir: string;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);

  dir = mkdtempSync(join(tmpdir(), 'synapse-opt-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'opts' }));
  writeFileSync(join(dir, 'root.ts'), 'export const root = 1;\n');
  // Oversized: default maxFileBytes is 512 KiB; write 600 KiB.
  writeFileSync(join(dir, 'big.ts'), `export const big = '${'x'.repeat(600 * 1024)}';\n`);
  // Malformed root manifest -> falls back to directory name.
  const malformed = join(dir, 'malformed');
  mkdirSync(malformed);
  writeFileSync(join(malformed, 'package.json'), '{ not json');
  writeFileSync(join(malformed, 'a.ts'), 'export const a = 1;\n');

  // Monorepo: nested package manifest overrides project name for its subtree.
  monorepo = mkdtempSync(join(tmpdir(), 'synapse-mono-'));
  writeFileSync(join(monorepo, 'package.json'), JSON.stringify({ name: 'mono-root' }));
  mkdirSync(join(monorepo, 'packages'));
  mkdirSync(join(monorepo, 'packages', 'core'));
  writeFileSync(join(monorepo, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@mono/core' }));
  writeFileSync(join(monorepo, 'packages', 'core', 'm.ts'), 'export const m = 1;\n');
  // A dir with a nameless manifest: falls back to the directory name.
  mkdirSync(join(monorepo, 'packages', 'anon'));
  writeFileSync(join(monorepo, 'packages', 'anon', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(monorepo, 'packages', 'anon', 'n.ts'), 'export const n = 1;\n');

  // Root manifest with an EMPTY name: detectProjectName must fall back to the
  // directory name (`typeof name === 'string' && name !== ''` false arm).
  emptyNameDir = mkdtempSync(join(tmpdir(), 'synapse-emptyname-'));
  writeFileSync(join(emptyNameDir, 'package.json'), JSON.stringify({ name: '' }));
  writeFileSync(join(emptyNameDir, 'e.ts'), 'export const e = 1;\n');
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(monorepo, { recursive: true, force: true });
  rmSync(emptyNameDir, { recursive: true, force: true });
});

describe('indexWorkspace option arms', () => {
  it('skips oversized files (content empty, entity kept)', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: dir });
    const big = findEntitiesByScope(db, { scopePrefixes: ['proj:opts'], types: ['file'] }).find(
      (e) => e.name === 'big.ts',
    );
    expect(big).toBeDefined();
    expect(big!.content).toBeNull(); // skipped read, entity retained
    expect(result.warnings.length).toBe(0);
  });

  it('caps traversal at depth', async () => {
    mkdirSync(join(dir, 'd1', 'd2', 'd3'), { recursive: true });
    writeFileSync(join(dir, 'd1', 'd2', 'd3', 'deep.ts'), 'export const deep = 1;\n');
    const shallow = await indexWorkspace(db, embedder, { workspacePath: dir, depth: 1 });
    const files = findEntitiesByScope(db, { scopePrefixes: ['proj:opts'], types: ['file'] }).map((f) => f.name);
    expect(files).toContain('root.ts');
    expect(files).not.toContain('deep.ts');
    expect(shallow.filesScanned).toBeLessThan(
      (await indexWorkspace(db, embedder, { workspacePath: dir })).filesScanned,
    );
  });

  it('falls back to the directory name for a malformed root manifest', async () => {
    await indexWorkspace(db, embedder, { workspacePath: join(dir, 'malformed') });
    expect(findEntitiesByScope(db, { scopePrefixes: [`proj:malformed`] }, ).length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the directory name for an empty manifest name', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: emptyNameDir });
    expect(result.projectName).toBe(basename(emptyNameDir));
    // Entities are scoped under the directory-derived project name.
    const files = findEntitiesByScope(db, { scopePrefixes: [result.projectScope], types: ['file'] });
    expect(files.map((f) => f.name)).toContain('e.ts');
  });

  it('uses a nested manifest name as the package scope and falls back to the directory for nameless ones', async () => {
    await indexWorkspace(db, embedder, { workspacePath: monorepo });
    const packages = findEntitiesByScope(db, { scopePrefixes: ['proj:mono-root'], types: ['package'] }).map(
      (p) => p.name,
    );
    expect(packages).toContain('@mono/core'); // nested manifest name wins
    expect(packages).toContain('anon'); // nameless nested manifest -> basename
    // Files inside a named nested package scope use the package's name.
    const m = findEntitiesByScope(db, { scopePrefixes: ['proj:mono-root/pkg:@mono/core'], types: ['file'] });
    expect(m.map((f) => f.name)).toContain('m.ts');
  });

  it('skips the embedding pass when no content produces embed tasks', async () => {
    // maxFileBytes: 0 makes every file oversized -> content '' -> no embed
    // tasks, so the `embedTasks.length > 0` false arm is exercised.
    const result = await indexWorkspace(db, embedder, { workspacePath: dir, maxFileBytes: 0 });
    expect(result.embeddingsStored).toBe(0);
    expect(result.warnings.some((w) => w.includes('embeddings'))).toBe(false);
  });
});
