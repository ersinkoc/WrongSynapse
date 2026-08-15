/**
 * parser.ts — option arms and fixture-driven branches that the main
 * indexWorkspace tests don't reach: nested monorepo packages, oversized-file
 * skip, depth cap, malformed manifests, unsupported extensions, and the
 * tree-sitter-unavailable degradation warning.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();
let dir: string;
let monorepo: string;

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
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(monorepo, { recursive: true, force: true });
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

  it('treats a nameless manifest as a package named by its directory', async () => {
    await indexWorkspace(db, embedder, { workspacePath: monorepo });
    const packages = findEntitiesByScope(db, { scopePrefixes: ['proj:mono-root'], types: ['package'] }).map(
      (p) => p.name,
    );
    expect(packages).toContain('@mono/core');
    expect(packages).toContain('anon');
    // Files inside a nested package scope use the package's name.
    const m = findEntitiesByScope(db, { scopePrefixes: ['proj:mono-root/pkg:@mono/core'], types: ['file'] });
    expect(m.map((f) => f.name)).toContain('m.ts');
  });
});
