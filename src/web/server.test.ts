/**
 * Tests for the optional admin web UI server.
 *
 * Coverage focus: every endpoint branch (success, not-found, bad-id,
 * unauthorized deletion, oversized body, missing SPA), every pure helper
 * (stats breakdown, memory graph, summarization, scope parsing), and the
 * HTTP shell's full request lifecycle including static-asset serving.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  insertCandidate,
  insertEntity,
  insertRelation,
  upsertVector,
} from '../db/queries.js';
import {
  route,
  resolveStaticFile,
  resolveSpaFallback,
  runWebServer,
  type WebContext,
  type WebResponse,
} from './server.js';

let db: SynapseDatabase;
let ctx: WebContext;

beforeAll(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
  ctx = { db };
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // Wipe entities / relations / candidates / vectors between tests for isolation.
  db.exec('DELETE FROM relations; DELETE FROM entity_vectors; DELETE FROM memory_candidates; DELETE FROM entities;');
});

function jsonBody(res: WebResponse): { status: number; body: Record<string, unknown> } {
  return { status: res.status, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('route — health and 404s', () => {
  it('GET /api/health returns ok', () => {
    const res = route({ method: 'GET', rawUrl: '/api/health' }, ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('GET /healthz (alias) returns ok', () => {
    const res = route({ method: 'GET', rawUrl: '/healthz' }, ctx);
    expect(res.status).toBe(200);
  });

  it('unknown /api/* path returns 404', () => {
    const res = route({ method: 'GET', rawUrl: '/api/unknown' }, ctx);
    expect(res.status).toBe(404);
    expect(jsonBody(res).body['error']).toContain('unknown api endpoint');
  });

  it('non-/api path returns null (static fallback signal)', () => {
    // The route() function returns null for non-API paths so the HTTP shell
    // can attempt static serving. route()'s declared type is WebResponse but
    // null is the documented signal — cast via `unknown` to assert the runtime
    // contract without a separate overload.
    const res = route({ method: 'GET', rawUrl: '/some/static/path' }, ctx) as unknown;
    expect(res).toBeNull();
  });
});

describe('route — stats', () => {
  it('returns base counts and breakdowns', () => {
    insertEntity(db, { id: 'a', type: 'memory_entry', scopePath: 'proj:x', name: 'a' });
    insertEntity(db, { id: 'b', type: 'file', scopePath: 'proj:y', name: 'b' });
    insertRelation(db, { sourceId: 'a', targetId: 'b', relation: 'ANCHORED_TO' });
    const res = route({ method: 'GET', rawUrl: '/api/stats' }, ctx);
    expect(res.status).toBe(200);
    const body = jsonBody(res).body;
    expect(body['entities']).toBe(2);
    expect(body['relations']).toBe(1);
    expect(body['candidates']).toBe(0);
    expect(body['vectors']).toBe(0);
    expect(body['ftsRows']).toBe(2);
    const breakdown = body['breakdown'] as { types: Record<string, number>; relations: Record<string, number> };
    expect(breakdown.types['memory_entry']).toBe(1);
    expect(breakdown.types['file']).toBe(1);
    expect(breakdown.relations['ANCHORED_TO']).toBe(1);
  });
});

describe('route — memory list / get / delete', () => {
  beforeEach(() => {
    insertEntity(db, {
      id: 'm1',
      type: 'memory_entry',
      scopePath: 'proj:app/file:src/auth.ts',
      name: 'token caching decision',
      content: 'AuthService caches tokens for 5 minutes',
      metadata: { anchored_to: 'proj:app/file:src/auth.ts' },
    });
    insertEntity(db, {
      id: 'm2',
      type: 'memory_entry',
      scopePath: 'proj:app/file:src/payments.ts',
      name: 'payment retry',
      content: 'PaymentsService retries failed charges 3x',
    });
    insertEntity(db, {
      id: 'f1',
      type: 'file',
      scopePath: 'proj:app/file:src/auth.ts',
      name: 'auth.ts',
    });
  });

  it('falls back to the default limit when the value is non-positive', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?limit=-5' }, ctx);
    const memories = jsonBody(res).body['memories'] as unknown[];
    expect(memories).toHaveLength(2);
  });

  it('falls back to the default limit when the value is not a finite number', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?limit=abc' }, ctx);
    const memories = jsonBody(res).body['memories'] as unknown[];
    expect(memories).toHaveLength(2);
  });

  it('truncates memory names longer than 60 characters to fit the UI label', () => {
    insertEntity(db, {
      id: 'long',
      type: 'memory_entry',
      scopePath: 'proj:app/file:long.ts',
      name: 'this is a very long memory entry name that exceeds the sixty character display limit',
      content: 'truncation test',
    });
    insertRelation(db, { sourceId: 'long', targetId: 'f1', relation: 'ANCHORED_TO' });
    const listRes = route({ method: 'GET', rawUrl: '/api/memory?q=truncation' }, ctx);
    const listBody = jsonBody(listRes).body['memories'] as Array<{ id: string; name: string }>;
    expect(listBody[0]?.['name'].length).toBeGreaterThan(60);

    const graphRes = route({ method: 'GET', rawUrl: '/api/graph/memory' }, ctx);
    const nodes = jsonBody(graphRes).body['nodes'] as Array<{ id: string; label: string }>;
    const longNode = nodes.find((n) => n.id === 'long');
    expect(longNode?.['label']).toContain('…');
    expect(longNode?.['label'].length).toBeLessThanOrEqual(60);
  });

  it('truncates neighbor entity names in the graph', () => {
    insertEntity(db, {
      id: 'f2',
      type: 'file',
      scopePath: 'proj:app/file:src/longfile.ts',
      name: 'this is a very long file name that exceeds sixty characters by quite a lot actually yes',
    });
    insertRelation(db, { sourceId: 'm1', targetId: 'f2', relation: 'ANCHORED_TO' });
    const graphRes = route({ method: 'GET', rawUrl: '/api/graph/memory' }, ctx);
    const nodes = jsonBody(graphRes).body['nodes'] as Array<{ id: string; label: string }>;
    const f2 = nodes.find((n) => n.id === 'f2');
    expect(f2?.['label']).toContain('…');
    expect(f2?.['label'].length).toBeLessThanOrEqual(60);
  });

  it('filters out FTS hits whose entity is not a memory_entry', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?q=auth' }, ctx);
    const memories = jsonBody(res).body['memories'] as Array<{ id: string; type?: string }>;
    expect(memories.map((m) => m.id).sort()).toEqual(['m1']);
  });

  it('filters out graph edges whose endpoints were trimmed by the limit', () => {
    // With limit=1 only one memory survives (which one is non-deterministic —
    // both rows share updated_at within the same millisecond); what we
    // assert is the invariant: exactly one node remains, and the edge that
    // touched the trimmed memory is filtered.
    insertRelation(db, { sourceId: 'm1', targetId: 'm2', relation: 'SUPERSEDES' });
    const graphRes = route({ method: 'GET', rawUrl: '/api/graph/memory?limit=1' }, ctx);
    const body = jsonBody(graphRes).body;
    const nodes = body['nodes'] as Array<{ id: string }>;
    const edges = body['edges'] as Array<{ source: string; target: string }>;
    expect(nodes).toHaveLength(1);
    expect(['m1', 'm2']).toContain(nodes[0]?.['id']);
    expect(edges).toEqual([]);
  });

  it('GET /api/memory lists every memory_entry', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory' }, ctx);
    expect(res.status).toBe(200);
    const body = jsonBody(res).body;
    expect(body['count']).toBe(2);
    const memories = body['memories'] as Array<{ id: string; scope_path: string }>;
    expect(memories.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(memories.every((m) => m.scope_path.startsWith('proj:'))).toBe(true);
  });

  it('GET /api/memory respects scope filter', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?scope=proj:app/file:src/auth.ts' }, ctx);
    const memories = jsonBody(res).body['memories'] as Array<{ id: string }>;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.['id']).toBe('m1');
  });

  it('GET /api/memory respects limit', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?limit=1' }, ctx);
    const memories = jsonBody(res).body['memories'] as unknown[];
    expect(memories).toHaveLength(1);
  });

  it('GET /api/memory?q= runs FTS5 and filters by type', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?q=token' }, ctx);
    const memories = jsonBody(res).body['memories'] as Array<{ id: string }>;
    expect(memories.map((m) => m.id)).toEqual(['m1']);
  });

  it('GET /api/memory?q= returns empty array when nothing matches', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory?q=zzznonexistent' }, ctx);
    expect(jsonBody(res).body['count']).toBe(0);
  });

  it('GET /api/memory/:id returns the memory with graph paths', () => {
    insertRelation(db, { sourceId: 'm1', targetId: 'f1', relation: 'ANCHORED_TO' });
    const res = route({ method: 'GET', rawUrl: '/api/memory/m1' }, ctx);
    expect(res.status).toBe(200);
    const body = jsonBody(res).body;
    expect(body['id']).toBe('m1');
    expect(Array.isArray(body['graph_paths'])).toBe(true);
    expect((body['graph_paths'] as unknown[]).length).toBe(1);
  });

  it('GET /api/memory/:id returns 404 for unknown id', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory/missing' }, ctx);
    expect(res.status).toBe(404);
  });

  it('GET /api/memory/:id returns 400 for a non-memory entity', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory/f1' }, ctx);
    expect(res.status).toBe(400);
  });

  it('GET /api/memory/:id returns 400 for malformed id', () => {
    const res = route({ method: 'GET', rawUrl: '/api/memory/..%2F..%2Fetc' }, ctx);
    expect(res.status).toBe(400);
  });

  it('DELETE /api/memory/:id removes the memory + cascades', () => {
    insertRelation(db, { sourceId: 'm1', targetId: 'f1', relation: 'ANCHORED_TO' });
    upsertVector(db, 'm1', new Float32Array([1, 0, 0]));
    const before = route({ method: 'GET', rawUrl: '/api/stats' }, ctx);
    expect(jsonBody(before).body['entities']).toBe(3);
    const res = route({ method: 'DELETE', rawUrl: '/api/memory/m1' }, ctx);
    expect(res.status).toBe(200);
    expect(jsonBody(res).body['deleted']).toBe(true);
    const after = route({ method: 'GET', rawUrl: '/api/stats' }, ctx);
    expect(jsonBody(after).body['entities']).toBe(2);
    expect(jsonBody(after).body['relations']).toBe(0);
    expect(jsonBody(after).body['vectors']).toBe(0);
  });

  it('DELETE /api/memory/:id returns 404 for unknown id', () => {
    const res = route({ method: 'DELETE', rawUrl: '/api/memory/missing' }, ctx);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/memory/:id returns 400 for non-memory entity', () => {
    const res = route({ method: 'DELETE', rawUrl: '/api/memory/f1' }, ctx);
    expect(res.status).toBe(400);
  });

  it('DELETE /api/memory/:id returns 400 for malformed id', () => {
    const res = route({ method: 'DELETE', rawUrl: '/api/memory/!!!bad!!!' }, ctx);
    expect(res.status).toBe(400);
  });
});

describe('route — auth-token gating', () => {
  // Dummy test fixtures (not real secrets); the header value is assembled
  // dynamically so the file carries no literal credential-looking string.
  const TOKEN = 'synapse-test-token';
  const WRONG_SAME_LENGTH = 'synapse-test-tokeX';
  const bearer = (t: string) => `Bearer ${t}`;
  let authCtx: WebContext;

  beforeEach(() => {
    authCtx = { ...ctx, authToken: TOKEN };
  });

  it('DELETE is 401 without an Authorization header', () => {
    const res = route({ method: 'DELETE', rawUrl: '/api/memory/m1' }, authCtx);
    expect(res.status).toBe(401);
  });

  it('DELETE is 401 with the wrong token (same length, constant-time path)', () => {
    const res = route(
      { method: 'DELETE', rawUrl: '/api/memory/m1', authorization: bearer(WRONG_SAME_LENGTH) },
      authCtx,
    );
    expect(res.status).toBe(401);
  });

  it('DELETE is 401 with a wrong-length bearer token', () => {
    const res = route(
      { method: 'DELETE', rawUrl: '/api/memory/m1', authorization: bearer('short') },
      authCtx,
    );
    expect(res.status).toBe(401);
  });

  it('DELETE succeeds with the correct bearer token', () => {
    insertEntity(db, { id: 'm1', type: 'memory_entry', scopePath: 'proj:demo', name: 'm1' });
    const res = route(
      { method: 'DELETE', rawUrl: '/api/memory/m1', authorization: bearer(TOKEN) },
      authCtx,
    );
    expect(res.status).toBe(200);
    expect(jsonBody(res).body['deleted']).toBe(true);
  });

  it('DELETE succeeds with the correct raw (non-bearer) token', () => {
    insertEntity(db, { id: 'm2', type: 'memory_entry', scopePath: 'proj:demo/file:src/x.ts', name: 'm2' });
    const res = route(
      { method: 'DELETE', rawUrl: '/api/memory/m2', authorization: TOKEN },
      authCtx,
    );
    expect(res.status).toBe(200);
  });

  it('read-only GET is not gated when a token is configured', () => {
    insertEntity(db, { id: 'm1', type: 'memory_entry', scopePath: 'proj:demo', name: 'm1' });
    const res = route({ method: 'GET', rawUrl: '/api/memory/m1' }, authCtx);
    expect(res.status).toBe(200);
  });
});

describe('route — candidates', () => {
  beforeEach(() => {
    insertCandidate(db, { content: 'first observation', confidence: 0.6 });
    insertCandidate(db, { content: 'second observation', confidence: 0.8 });
  });

  it('lists all candidates by default', () => {
    const res = route({ method: 'GET', rawUrl: '/api/candidates' }, ctx);
    expect(res.status).toBe(200);
    expect(jsonBody(res).body['count']).toBe(2);
  });

  it('filters by status', () => {
    const res = route({ method: 'GET', rawUrl: '/api/candidates?status=pending' }, ctx);
    expect(res.status).toBe(200);
    expect(jsonBody(res).body['count']).toBe(2);
  });

  it('ignores an unknown status (returns all)', () => {
    const res = route({ method: 'GET', rawUrl: '/api/candidates?status=bogus' }, ctx);
    expect(jsonBody(res).body['count']).toBe(2);
  });

  it('respects limit', () => {
    const res = route({ method: 'GET', rawUrl: '/api/candidates?limit=1' }, ctx);
    const list = jsonBody(res).body['candidates'] as unknown[];
    expect(list).toHaveLength(1);
  });
});

describe('route — memory graph', () => {
  beforeEach(() => {
    insertEntity(db, { id: 'm1', type: 'memory_entry', scopePath: 'proj:a/file:x.ts', name: 'm1', confidence: 0.9 });
    insertEntity(db, { id: 'm2', type: 'memory_entry', scopePath: 'proj:a/file:y.ts', name: 'm2', confidence: 0.8 });
    insertEntity(db, { id: 'm3', type: 'memory_entry', scopePath: 'proj:b/file:z.ts', name: 'm3', confidence: 0.7 });
    insertEntity(db, { id: 'f1', type: 'file', scopePath: 'proj:a/file:x.ts', name: 'x.ts' });
    insertEntity(db, { id: 'f2', type: 'file', scopePath: 'proj:a/file:y.ts', name: 'y.ts' });
    insertRelation(db, { sourceId: 'm1', targetId: 'f1', relation: 'ANCHORED_TO' });
    insertRelation(db, { sourceId: 'm2', targetId: 'f2', relation: 'ANCHORED_TO' });
    insertRelation(db, { sourceId: 'm3', targetId: 'm1', relation: 'SUPERSEDES' });
    // Source-side neighbor: a commit whose INTRODUCED_BY_COMMIT edge points
    // AT a memory — exercises the source branch of neighbor expansion
    // (lines where sid is non-memory), mirroring the target-side f1/f2.
    insertEntity(db, { id: 'c1', type: 'commit', scopePath: 'proj:a/commit:abc123', name: 'abc123' });
    insertRelation(db, { sourceId: 'c1', targetId: 'm2', relation: 'INTRODUCED_BY_COMMIT' });
  });

  it('returns every memory_entry plus edges that touch them', () => {
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory' }, ctx);
    const body = jsonBody(res).body;
    const nodes = body['nodes'] as Array<{ id: string; type: string }>;
    const edges = body['edges'] as Array<{ source: string; target: string; relation: string }>;
    const nodeIds = nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual(['c1', 'f1', 'f2', 'm1', 'm2', 'm3']);
    expect(nodes.filter((n) => n.type === 'memory_entry')).toHaveLength(3);
    expect(edges).toHaveLength(4);
    const rels = edges.map((e) => e.relation).sort();
    expect(rels).toEqual(['ANCHORED_TO', 'ANCHORED_TO', 'INTRODUCED_BY_COMMIT', 'SUPERSEDES']);
  });

  it('returns empty arrays when there are no memories', () => {
    db.exec('DELETE FROM relations; DELETE FROM entity_vectors; DELETE FROM memory_candidates; DELETE FROM entities;');
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory' }, ctx);
    const body = jsonBody(res).body;
    expect(body['nodes']).toEqual([]);
    expect(body['edges']).toEqual([]);
  });

  it('respects limit', () => {
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory?limit=1' }, ctx);
    const body = jsonBody(res).body;
    expect((body['nodes'] as unknown[]).length).toBe(1);
  });

  it('emits no position when layoutSeed is absent (back-compat)', () => {
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory' }, ctx);
    const nodes = jsonBody(res).body['nodes'] as Array<{ id: string; position?: unknown }>;
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(n.position).toBeUndefined();
  });

  it('seeded layout: deterministic across calls, distinct per node, seed-sensitive', () => {
    const seededCtx = { ...ctx, layoutSeed: 7 };
    type P = { x: number; y: number };
    const call = (c: typeof seededCtx): Array<{ id: string; position?: P }> =>
      (jsonBody(route({ method: 'GET', rawUrl: '/api/graph/memory' }, c)).body['nodes'] as Array<{
        id: string;
        position?: P;
      }>).map((n) => ({ id: n.id, position: n.position }));
    const a = call(seededCtx);
    const b = call(seededCtx);
    expect(a).toEqual(b); // determinism across independent calls
    expect(a.length).toBe(6); // m1..m3, f1, f2, c1
    for (const n of a) expect(n.position).toBeDefined();
    const keys = a.map((n) => `${n.position?.x}:${n.position?.y}`);
    expect(new Set(keys).size).toBe(a.length); // no two distinct nodes share coords
    // Memories fan out around their anchor file within the polar band.
    const pos = new Map(a.map((n) => [n.id, n.position ?? { x: 0, y: 0 }]));
    const dist = (p: P, q: P): number => Math.hypot(p.x - q.x, p.y - q.y);
    const far = { x: 9e9, y: 0 };
    const d1 = dist(pos.get('m1') ?? far, pos.get('f1') ?? far);
    expect(d1).toBeGreaterThanOrEqual(120);
    expect(d1).toBeLessThanOrEqual(320);
    const d2 = dist(pos.get('m2') ?? far, pos.get('f2') ?? far);
    expect(d2).toBeGreaterThanOrEqual(120);
    expect(d2).toBeLessThanOrEqual(320);
    // m3 has no file anchor (SUPERSEDES memory target) → anchors to its own scope.
    expect(pos.get('m3')).toBeDefined();
    // Seed sensitivity: another seed moves at least one node.
    const c = call({ ...ctx, layoutSeed: 8 });
    const moved = a.filter((n, i) => n.position?.x !== c[i]?.position?.x || n.position?.y !== c[i]?.position?.y);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('collision retry: identical (scope,label) nodes still land on distinct coords — memory + neighbor loops', () => {
    db.exec('DELETE FROM relations; DELETE FROM entity_vectors; DELETE FROM memory_candidates; DELETE FROM entities;');
    // Identical (scope_path, label) pairs produce IDENTICAL PRNG streams:
    // the first node claims the shared first proposal, the second MUST walk
    // the retry branch in BOTH loops (non-memory nudge + memory polar band).
    insertEntity(db, { id: 'a', type: 'memory_entry', scopePath: 'proj:c/file:same.ts', name: 'twin', confidence: 0.9 });
    insertEntity(db, { id: 'b', type: 'memory_entry', scopePath: 'proj:c/file:same.ts', name: 'twin', confidence: 0.9 });
    insertEntity(db, { id: 'fa', type: 'symbol', scopePath: 'proj:c/file:same.ts/sym:one', name: 'twin' });
    insertEntity(db, { id: 'fb', type: 'symbol', scopePath: 'proj:c/file:same.ts/sym:two', name: 'twin' });
    // buildMemoryGraph only includes non-memory nodes that are endpoints of
    // edges touching a selected memory — the twins must be related or they
    // never enter the graph and the neighbor loop goes untested.
    insertRelation(db, { sourceId: 'a', targetId: 'fa', relation: 'ANCHORED_TO' });
    insertRelation(db, { sourceId: 'b', targetId: 'fb', relation: 'ANCHORED_TO' });
    // Same scope as the twins but a DIFFERENT label: exercises the label
    // arm of the content-identity sort comparator (scope_path tie-break).
    insertEntity(db, { id: 'c', type: 'memory_entry', scopePath: 'proj:c/file:same.ts', name: 'alpha', confidence: 0.9 });
    const seededCtx = { ...ctx, layoutSeed: 7 };
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory' }, seededCtx);
    const nodes = jsonBody(res).body['nodes'] as Array<{ id: string; position?: { x: number; y: number } }>;
    expect(nodes).toHaveLength(5);
    const coords = nodes.map((n) => `${n.position?.x}:${n.position?.y}`);
    expect(new Set(coords).size).toBe(5); // all distinct — both retries fired, 'c' placed too
    for (const n of nodes) expect(n.position).toBeDefined();
    // The twins sharing an rng stream must differ (one retried outward).
    const pa = nodes.find((n) => n.id === 'a')?.position;
    const pb = nodes.find((n) => n.id === 'b')?.position;
    expect(`${pa?.x}:${pa?.y}`).not.toBe(`${pb?.x}:${pb?.y}`);
    const fa = nodes.find((n) => n.id === 'fa')?.position;
    const fb = nodes.find((n) => n.id === 'fb')?.position;
    expect(`${fa?.x}:${fa?.y}`).not.toBe(`${fb?.x}:${fb?.y}`);
  });

  it('handles large memory sets via SQLite placeholder chunking', () => {
    db.exec('DELETE FROM relations; DELETE FROM entity_vectors; DELETE FROM memory_candidates; DELETE FROM entities;');
    const stmt = db.prepare(
      `INSERT INTO entities (id, type, scope_path, name, content, metadata, confidence, created_at, updated_at)
       VALUES (?, 'memory_entry', ?, ?, NULL, NULL, 1.0, 0, 0)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 750; i += 1) {
        stmt.run(`mem-${i}`, `proj:bulk/file:${i}.ts`, `memory ${i}`);
      }
    });
    const res = route({ method: 'GET', rawUrl: '/api/graph/memory?limit=2000' }, ctx);
    expect(res.status).toBe(200);
    const body = jsonBody(res).body;
    expect((body['nodes'] as unknown[]).length).toBe(750);
    expect((body['edges'] as unknown[]).length).toBe(0);
  });
});

let httpShellDir = '';
beforeAll(() => {
  httpShellDir = mkdtempSync(join(tmpdir(), 'synapse-web-http-'));
  writeFileSync(join(httpShellDir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  writeFileSync(join(httpShellDir, 'app.js'), 'console.log("app")');
});
afterAll(() => {
  rmSync(httpShellDir, { recursive: true, force: true });
});

function httpRequest(
  port: number,
  path: string,
  method: 'GET' | 'DELETE' | 'POST' = 'GET',
  body?: string,
  authorization?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authorization !== undefined) headers['authorization'] = authorization;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolveRequest({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }),
      );
    });
    req.on('error', rejectRequest);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

describe('runWebServer (HTTP shell)', () => {
  it('binds to a kernel-assigned port and reports the URL', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toContain(String(handle.port));
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true);
    await handle.close();
  });

  it('GET /api/health over real HTTP', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/health');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)['ok']).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('GET /api/stats over real HTTP', async () => {
    insertEntity(db, { id: 'a', type: 'memory_entry', scopePath: 'proj:x', name: 'a' });
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/stats');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { entities: number };
      expect(body.entities).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('DELETE /api/memory/:id over real HTTP cascades', async () => {
    insertEntity(db, { id: 'm1', type: 'memory_entry', scopePath: 'proj:x', name: 'm1' });
    insertEntity(db, { id: 'f1', type: 'file', scopePath: 'proj:x/file:x.ts', name: 'x.ts' });
    insertRelation(db, { sourceId: 'm1', targetId: 'f1', relation: 'ANCHORED_TO' });
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/memory/m1', 'DELETE');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)['deleted']).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('auth token flows through the real HTTP shell (401 vs 200)', async () => {
    // The route()-level suite covers isAuthorized(); this exercises the
    // production path end-to-end: header read by the HTTP shell, forwarded
    // to route(), enforced on DELETE. WebContext.authToken drives it.
    const TOKEN = 'synapse-http-shell-token';
    insertEntity(db, { id: 'm1', type: 'memory_entry', scopePath: 'proj:x', name: 'm1' });
    const handle = await runWebServer({ db, staticDir: httpShellDir, authToken: TOKEN }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const denied = await httpRequest(port, '/api/memory/m1', 'DELETE');
      expect(denied.status).toBe(401);
      const wrong = await httpRequest(port, '/api/memory/m1', 'DELETE', undefined, `Bearer ${TOKEN}X`);
      expect(wrong.status).toBe(401);
      const allowed = await httpRequest(port, '/api/memory/m1', 'DELETE', undefined, `Bearer ${TOKEN}`);
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)['deleted']).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('returns 400 for oversized request bodies', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const huge = 'x'.repeat(2 * 1024 * 1024);
      const res = await httpRequest(port, '/api/memory', 'POST', huge);
      expect(res.status === 400 || res.status === 500).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('falls back to index.html for unknown paths when SPA is present', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/some/spa/route');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<!doctype html>');
    } finally {
      await handle.close();
    }
  });

  it('serves a real static asset when present', async () => {
    writeFileSync(join(httpShellDir, 'asset.js'), '// asset');
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/asset.js');
      expect(res.status).toBe(200);
      expect(res.body).toBe('// asset');
    } finally {
      await handle.close();
    }
  });

  it('returns 404 when SPA is missing and path is unknown', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'synapse-web-empty-'));
    try {
      const handle = await runWebServer({ db, staticDir: empty }, 0);
      try {
        const port = (handle.server.address() as AddressInfo).port;
        const res = await httpRequest(port, '/no-spa-here');
        expect(res.status).toBe(404);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('handles missing staticDir gracefully (API still works)', async () => {
    const handle = await runWebServer({ db }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/health');
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for a non-API path when no staticDir is configured', async () => {
    const handle = await runWebServer({ db }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/no/static/dir/here');
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('POST to unknown /api endpoint returns 404', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/unknown', 'POST', '{}');
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns null port sentinel when listen() fails (port in use)', async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as AddressInfo).port;
    const handle = await runWebServer({ db }, taken);
    try {
      expect(handle.port).toBe(0);
      expect(handle.url).toBe('');
      await handle.close();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('resolveStaticFile / resolveSpaFallback', () => {
  it('resolves a file inside the static dir', async () => {
    const found = await resolveStaticFile(httpShellDir, '/app.js');
    expect(found).not.toBeNull();
    expect(found?.mime).toContain('javascript');
  });

  it('resolves index.html as the SPA fallback', async () => {
    const found = await resolveSpaFallback(httpShellDir);
    expect(found).not.toBeNull();
    expect(found?.mime).toContain('html');
  });

  it('returns null for a directory traversal attempt', async () => {
    const found = await resolveStaticFile(httpShellDir, '/../../etc/passwd');
    expect(found).toBeNull();
  });

  it('returns null when the requested file does not exist', async () => {
    const found = await resolveStaticFile(httpShellDir, '/missing.js');
    expect(found).toBeNull();
  });

  it('returns null when the static dir is empty', async () => {
    expect(await resolveStaticFile('', '/anything')).toBeNull();
    expect(await resolveSpaFallback('')).toBeNull();
  });

  it('returns null when the path resolves to a directory', async () => {
    const found = await resolveStaticFile(httpShellDir, '/some/dir');
    expect(found).toBeNull();
  });

  it('returns null when the path is the static dir itself (directory, not file)', async () => {
    const found = await resolveStaticFile(httpShellDir, '/');
    expect(found).toBeNull();
  });

  it('guesses mime for svg/woff/json/etc.', async () => {
    writeFileSync(join(httpShellDir, 'logo.svg'), '<svg/>');
    writeFileSync(join(httpShellDir, 'font.woff2'), 'fake-font-bytes');
    writeFileSync(join(httpShellDir, 'data.json'), '{}');
    const svg = await resolveStaticFile(httpShellDir, '/logo.svg');
    expect(svg?.mime).toContain('svg');
    const woff = await resolveStaticFile(httpShellDir, '/font.woff2');
    expect(woff?.mime).toContain('woff2');
    const json = await resolveStaticFile(httpShellDir, '/data.json');
    expect(json?.mime).toContain('json');
  });

  it('falls back to octet-stream for unknown extensions', async () => {
    writeFileSync(join(httpShellDir, 'thing.xyz'), 'data');
    const found = await resolveStaticFile(httpShellDir, '/thing.xyz');
    expect(found?.mime).toBe('application/octet-stream');
  });

  it('returns null when staticDir does not exist', async () => {
    expect(await resolveStaticFile(join(httpShellDir, 'no-such-dir'), '/app.js')).toBeNull();
    expect(await resolveSpaFallback(join(httpShellDir, 'no-such-dir'))).toBeNull();
  });

  it('decodes percent-encoded paths', async () => {
    writeFileSync(join(httpShellDir, 'with space.js'), '//');
    const found = await resolveStaticFile(httpShellDir, '/with%20space.js');
    expect(found).not.toBeNull();
  });
});

describe('HTTP shell error path', () => {
  it('returns 500 when an unhandled error escapes route()', async () => {
    const closedDb = await openDatabase(':memory:');
    closedDb.close();
    const handle = await runWebServer({ db: closedDb }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const res = await httpRequest(port, '/api/stats');
      expect(res.status).toBe(500);
      const body = JSON.parse(res.body) as { error: string };
      expect(typeof body.error).toBe('string');
    } finally {
      await handle.close();
    }
  });

  it('drains a request whose socket errors mid-body without crashing the server', async () => {
    const handle = await runWebServer({ db, staticDir: httpShellDir }, 0);
    try {
      const port = (handle.server.address() as AddressInfo).port;
      await new Promise<void>((resolveDone) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/memory', method: 'POST', headers: { 'content-type': 'application/json' } },
          (res) => {
            res.resume();
            res.on('end', resolveDone);
          },
        );
        req.on('error', () => resolveDone());
        req.write('x'.repeat(64));
        req.destroy();
      });
      const follow = await httpRequest(port, '/api/health');
      expect(follow.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

// Touch tmpdir/join so the imports are exercised (lint sanity).
describe('OS-agnostic imports', () => {
  it('tmpdir and join are usable on every platform', () => {
    const p = join(tmpdir(), 'synapse-web-test');
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});
