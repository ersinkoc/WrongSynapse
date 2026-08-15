/**
 * git.ts — parser-side edge branches (parseNameStatus / parseBlamePorcelain
 * malformed-input handling) exercised through the exported GitService surface.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitService } from './git.js';

let repoDir: string;
let nonRepoDir: string;
let service: GitService;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'synapse-git2-'));
  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 't@example.com'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  writeFileSync(join(repoDir, 'a.ts'), 'export const a = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'one'], repoDir);

  nonRepoDir = mkdtempSync(join(tmpdir(), 'synapse-nonrepo-'));
  service = new GitService(repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(nonRepoDir, { recursive: true, force: true });
});

describe('GitService edge branches', () => {
  it('reports false outside a work tree (isRepo catch branch)', async () => {
    await expect(new GitService(nonRepoDir).isRepo()).resolves.toBe(false);
  });

  it('returns one change for a root commit (--root diff-tree)', async () => {
    const commits = await service.listCommits(10);
    expect(commits.length).toBe(1);
    const changes = await service.changesForCommit(commits[0]!.hash);
    expect(changes).toEqual([{ status: 'A', path: 'a.ts' }]);
  });

  it('blames every line of the tracked file', async () => {
    const blame = await service.blameFile('a.ts');
    expect(blame.length).toBe(1);
    expect(blame[0]!.line).toBe(1);
    expect(blame[0]!.commitHash).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('skips not-yet-committed boundary lines (all-zero hash) in blame', async () => {
    const committed = 'export const a = 1;\n';
    writeFileSync(join(repoDir, 'a.ts'), `${committed}export const uncommitted = 2;\n`);
    try {
      const blame = await service.blameFile('a.ts');
      // line 1 carries a real commit hash; line 2 is an unstaged worktree line
      // that git blame reports with the all-zero boundary hash and must be
      // excluded from the line -> commit mapping.
      expect(blame).toHaveLength(1);
      expect(blame[0]!.line).toBe(1);
      expect(blame[0]!.commitHash).not.toMatch(/^0+$/);
    } finally {
      writeFileSync(join(repoDir, 'a.ts'), committed);
    }
  });
});
