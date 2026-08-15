/**
 * parser.ts — workspace WITHOUT a root package.json. Exercises every `pkg ===
 * null` arm (fileScope/dirChain/containment parents), project-name detection
 * fallback, and the call-graph edge cases that manifest-less fixtures expose:
 * unknown callees, top-level calls (no enclosing symbol), self-recursion, and
 * duplicate call edges.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getNeighbors } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let db: SynapseDatabase;
const embedder = new FakeEmbedder();
let dir: string;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);

  // No package.json anywhere: every package lookup must degrade to null and
  // the project takes its name from the directory.
  dir = mkdtempSync(join(tmpdir(), 'synapse-bare-'));
  writeFileSync(join(dir, 'root.ts'), 'export function rootFn() {}\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'calls.ts'),
    [
      'function localFn() { return 1; }',
      'function caller() {',
      '  localFn();', // resolvable callee
      '  externalFn();', // unknown callee -> skipped
      '  localFn();', // duplicate edge -> deduped
      '}',
      'function recurse() { recurse(); }', // self-call -> same-scope skip
      'topLevel();', // call with no enclosing symbol -> no caller
    ].join('\n'),
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexWorkspace without a root manifest', () => {
  it('falls back to the directory name and scopes files under proj only', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: dir });
    expect(result.projectName).toBe(basename(dir));
    expect(result.filesScanned).toBe(2);

    const root = findEntitiesByScope(db, { scopePrefixes: [`proj:${basename(dir)}`], types: ['file'] });
    const names = root.map((f) => f.name).sort();
    expect(names).toEqual(['calls.ts', 'root.ts']);
    // No pkg segment in any scope: the bare workspace has no package.json.
    for (const file of root) {
      expect(file.scopePath).not.toContain('/pkg:');
    }
  });

  it('extracts symbols, links resolvable calls, and dedupes repeated edges', async () => {
    const symbols = findEntitiesByScope(db, { scopePrefixes: [`proj:${basename(dir)}`], types: ['symbol'] });
    const byName = new Map(symbols.map((s) => [s.name, s.id] as const));
    expect(byName.has('localFn')).toBe(true);
    expect(byName.has('caller')).toBe(true);
    expect(byName.has('recurse')).toBe(true);
    expect(byName.has('topLevel')).toBe(false); // undefined at extraction time

    // caller -> localFn: exactly one CALLS edge despite two call sites.
    const edges = getNeighbors(db, byName.get('caller')!, { direction: 'out', relationFilter: ['CALLS'] });
    const callees = edges.map((e) => e.entityId);
    expect(callees.filter((id) => id === byName.get('localFn')).length).toBe(1);
    // externalFn is not a known symbol -> no edge, no crash.
    expect(callees).not.toContain(byName.get('externalFn'));

    // recurse calls itself: caller scope === callee scope -> edge skipped.
    const selfEdges = getNeighbors(db, byName.get('recurse')!, { direction: 'out', relationFilter: ['CALLS'] });
    expect(selfEdges.filter((e) => e.entityId === byName.get('recurse'))).toHaveLength(0);
  });
});
