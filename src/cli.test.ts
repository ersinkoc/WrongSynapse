/**
 * CLI end-to-end (subprocess): exercises the real entry-point branch in
 * src/index.ts (signal handlers + main().catch) that in-process tests cannot
 * reach, plus the --help / --version / --index modes.
 *
 * Runs via tsx (a devDependency) so the suite does not depend on a prior
 * `npm run build`. `--help` and `--version` return before any DB is opened;
 * the index mode uses an explicit --db path inside a temp dir.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

let workDir: string;

function runCli(args: string[]): string {
  return execFileSync('node', ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNAPSE_DB_PATH: join(workDir, 'cli.db'),
      // Tests must never touch the network: the embedder's default 'auto'
      // mode would otherwise attempt the one-time model download on hosts
      // without a warm cache (CI). Strict-offline fails fast and the
      // indexer degrades to a no-vectors warning, as it always has.
      SYNAPSE_NO_REMOTE_MODEL: '1',
    },
  });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'synapse-cli-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CLI entry point', () => {
  it('prints help and exits 0 (--help)', () => {
    const out = runCli(['--help']);
    expect(out).toContain('WrongSynapse');
    expect(out).toContain('--transport');
    expect(out).toContain('synapse_index_workspace');
  });

  it('prints the version (--version)', () => {
    const out = runCli(['--version']);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('one-shot index mode emits JSON stats and creates entities', () => {
    const ws = join(workDir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'cli-fixture' }));
    writeFileSync(join(ws, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');

    const out = runCli(['--index', ws, '--db', join(workDir, 'idx.db')]);
    const parsed = JSON.parse(out) as {
      projectName: string;
      filesScanned: number;
      db_stats: Record<string, unknown>;
    };
    expect(parsed.projectName).toBe('cli-fixture');
    expect(parsed.filesScanned).toBeGreaterThanOrEqual(2);
    expect(parsed.db_stats['entities']).toBeGreaterThanOrEqual(1);
  });
});
