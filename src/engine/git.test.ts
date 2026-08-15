/**
 * GitService integration tests against a real temporary git repository.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitService } from './git.js';

let repoDir: string;
let plainDir: string;
let service: GitService;
let firstHash = '';
let secondHash = '';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'synapse-git-'));
  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test User'], repoDir);

  writeFileSync(join(repoDir, 'alpha.ts'), 'export const a = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'feat: add alpha'], repoDir);
  firstHash = git(['rev-parse', 'HEAD'], repoDir);

  writeFileSync(join(repoDir, 'alpha.ts'), 'export const a = 2;\nexport function changed() {}\n');
  writeFileSync(join(repoDir, 'beta.ts'), 'export const b = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'feat: modify alpha, add beta'], repoDir);
  secondHash = git(['rev-parse', 'HEAD'], repoDir);

  writeFileSync(join(repoDir, 'alpha.ts'), 'export const a = 3;\nexport function changed() {}\nexport const three = 3;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'feat: extend alpha'], repoDir);

  plainDir = mkdtempSync(join(tmpdir(), 'synapse-git-plain-'));
  mkdirSync(join(plainDir, 'src'));

  service = new GitService(repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe('GitService', () => {
  it('detects a git work tree', async () => {
    await expect(service.isRepo()).resolves.toBe(true);
    await expect(new GitService(plainDir).isRepo()).resolves.toBe(false);
  });

  it('lists commits newest first with author metadata', async () => {
    const commits = await service.listCommits();
    expect(commits.length).toBe(3);
    expect(commits[0]!.message).toBe('feat: extend alpha');
    expect(commits[0]!.authorName).toBe('Test User');
    expect(commits[0]!.authorEmail).toBe('test@example.com');
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(commits[0]!.date).getTime()).not.toBeNaN();

    // maxCount limits results
    const limited = await service.listCommits(1);
    expect(limited.length).toBe(1);
    expect(limited[0]!.message).toBe('feat: extend alpha');
  });

  it('reports file changes for a commit', async () => {
    const changes = await service.changesForCommit(firstHash);
    expect(changes).toEqual([{ status: 'A', path: 'alpha.ts' }]);

    const secondChanges = await service.changesForCommit(secondHash);
    expect(secondChanges).toEqual([
      { status: 'M', path: 'alpha.ts' },
      { status: 'A', path: 'beta.ts' },
    ]);
  });

  it('blames a file into line -> commit mappings', async () => {
    const lines = await service.blameFile('alpha.ts');
    // 3 lines in the final alpha.ts; each maps to the commit that last touched it
    expect(lines.length).toBe(3);
    const hashes = new Set(lines.map((l) => l.commitHash));
    expect(hashes.size).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.line).toBeGreaterThan(0);
      expect(line.commitHash).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
