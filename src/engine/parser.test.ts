import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { findEntitiesByScope, getNeighbors } from '../db/queries.js';
import { FakeEmbedder } from '../../test/helpers/fake-embedder.js';
import { indexWorkspace } from './parser.js';

let dir: string;
let db: SynapseDatabase;
const embedder = new FakeEmbedder();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'synapse-index-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }));
  writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'auth.ts'),
    [
      'export function validateToken(token: string): boolean {',
      '  return token.length > 0;',
      '}',
      'export class Auth {',
      '  login() { return validateToken("x"); }',
      '}',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'src', 'ignored.ts'), 'export const secret = 1;\n');
  mkdirSync(join(dir, 'src', 'nested'));
  writeFileSync(join(dir, 'src', 'nested', 'helper.js'), 'export function helper() { return 42; }\n');
  db = await openDatabase(':memory:');
  migrate(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexWorkspace', () => {
  it('indexes the hierarchy, respects .gitignore, and extracts symbols', async () => {
    const result = await indexWorkspace(db, embedder, { workspacePath: dir });

    expect(result.projectName).toBe('fixture-pkg');
    expect(result.filesScanned).toBe(4); // package.json, .gitignore, auth.ts, helper.js (ignored.ts excluded)
    expect(result.symbolsIndexed).toBeGreaterThanOrEqual(4); // validateToken, Auth, login, helper
    expect(result.embeddingsStored).toBeGreaterThan(0);
    expect(result.warnings.length).toBe(0);

    const files = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-pkg'], types: ['file'] });
    expect(files.map((f) => f.name).sort()).toEqual(['.gitignore', 'auth.ts', 'helper.js', 'package.json']);
    expect(files.find((f) => f.name === 'auth.ts')?.content).toContain('validateToken');

    const symbols = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-pkg'], types: ['symbol'] });
    const names = symbols.map((s) => s.name);
    expect(names).toContain('validateToken');
    expect(names).toContain('Auth');
    expect(names).toContain('login');
    expect(names).toContain('helper');

    // symbol metadata carries line/column positions
    const validate = symbols.find((s) => s.name === 'validateToken');
    const metadata = validate?.metadata ?? {};
    expect(typeof metadata['start_row']).toBe('number');
    expect(metadata['kind']).toBe('function_declaration');
  });

  it('creates CONTAINS and CALLS edges', async () => {
    const symbols = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-pkg'], types: ['symbol'] });
    const login = symbols.find((s) => s.name === 'login');
    const validate = symbols.find((s) => s.name === 'validateToken');
    expect(login).toBeDefined();
    expect(validate).toBeDefined();

    const calls = getNeighbors(db, login!.id, { direction: 'out', relationFilter: ['CALLS'] });
    expect(calls.some((c) => c.entityId === validate!.id)).toBe(true);

    const contains = getNeighbors(db, login!.id, { direction: 'in', relationFilter: ['CONTAINS'] });
    expect(contains.length).toBe(1); // the containing file
  });

  it('removes stale entities on re-index', async () => {
    writeFileSync(join(dir, 'src', 'temp.ts'), 'export function tempFn() { return 1; }\n');
    await indexWorkspace(db, embedder, { workspacePath: dir });

    let entities = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-pkg'], types: ['file', 'symbol'] });
    expect(entities.some((e) => e.name === 'temp.ts')).toBe(true);
    expect(entities.some((e) => e.name === 'tempFn')).toBe(true);

    rmSync(join(dir, 'src', 'temp.ts'));
    const result = await indexWorkspace(db, embedder, { workspacePath: dir });
    expect(result.entitiesDeleted).toBeGreaterThan(0);

    entities = findEntitiesByScope(db, { scopePrefixes: ['proj:fixture-pkg'], types: ['file', 'symbol'] });
    expect(entities.some((e) => e.name === 'temp.ts')).toBe(false);
    expect(entities.some((e) => e.name === 'tempFn')).toBe(false);
  });
});
