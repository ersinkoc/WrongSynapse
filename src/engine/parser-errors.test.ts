/**
 * parser.ts — error paths and git-history linking (indexWorkspace).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getNeighbors } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let fixtureDir: string;
let gitDir: string;
let emptyGitDir: string;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);

  fixtureDir = mkdtempSync(join(tmpdir(), 'synapse-idx-err-'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'fixture-err' }));
  mkdirSync(join(fixtureDir, 'src'));
  // A valid file and a file that tree-sitter cannot parse.
  writeFileSync(join(fixtureDir, 'src', 'ok.ts'), 'export const ok = 1;\n');
  writeFileSync(join(fixtureDir, 'src', 'broken.ts'), 'export const = = = ;;;\n');

  // A real git repo with one commit touching a file.
  gitDir = mkdtempSync(join(tmpdir(), 'synapse-idx-git-'));
  git(['init', '-q', '-b', 'main'], gitDir);
  git(['config', 'user.email', 't@example.com'], gitDir);
  git(['config', 'user.name', 'T'], gitDir);
  writeFileSync(join(gitDir, 'package.json'), JSON.stringify({ name: 'fixture-git' }));
  writeFileSync(join(gitDir, 'src.ts'), 'export const fromGit = 1;\n');
  git(['add', '.'], gitDir);
  git(['commit', '-q', '-m', 'feat: initial'], gitDir);

  // An initialized repo with NO commits: git.log fails -> warning path.
  emptyGitDir = mkdtempSync(join(tmpdir(), 'synapse-idx-nocommit-'));
  git(['init', '-q', '-b', 'main'], emptyGitDir);
  writeFileSync(join(emptyGitDir, 'package.json'), JSON.stringify({ name: 'fixture-empty' }));
  writeFileSync(join(emptyGitDir, 'x.ts'), 'export const x = 1;\n');
});

afterAll(() => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(gitDir, { recursive: true, force: true });
  rmSync(emptyGitDir, { recursive: true, force: true });
});

describe('indexWorkspace error paths', () => {
  it('throws when the workspace path does not exist', async () => {
    await expect(indexWorkspace(db, embedder, { workspacePath: join(fixtureDir, 'missing') })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('tolerates malformed source files (tree-sitter recovers, no abort)', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: fixtureDir });
    // tree-sitter does not throw on malformed TS — it emits ERROR nodes, so
    // the file is still parsed and the index completes.
    expect(result.filesParsed).toBeGreaterThanOrEqual(1);
    expect(result.filesFailed).toBe(0);
    expect(result.warnings.some((w) => w.includes('tree-sitter'))).toBe(false);
  });

  it('records a warning when git history cannot be read', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: emptyGitDir, includeGitHistory: true });
    expect(result.warnings.some((w) => w.includes('git'))).toBe(true);
    expect(result.commitsIndexed).toBe(0);
  });
});

describe('indexWorkspace with git history', () => {
  it('indexes commits and links INTRODUCED_BY_COMMIT edges', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: gitDir, includeGitHistory: true });
    expect(result.commitsIndexed).toBeGreaterThanOrEqual(1);

    const commits = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-git'], types: ['commit'] });
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0]!.metadata?.['hash']).toBeTruthy();

    // The indexed file should be linked to the commit that introduced it.
    const file = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-git'], types: ['file'] }).find(
      (e) => e.name === 'src.ts',
    );
    expect(file).toBeDefined();
    const edges = getNeighbors(db, file!.id, { direction: 'out', relationFilter: ['INTRODUCED_BY_COMMIT'] });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0]!.entityId).toBe(commits[0]!.id);
  });
});
