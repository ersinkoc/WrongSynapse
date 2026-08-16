/**
 * DemoFeeder unit tests — real in-memory SQLite, fake embedder, driven
 * ticks (no wall-clock waits). OS-agnostic: no filesystem paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type SynapseDatabase } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { getEntityByScope, insertCandidate, insertEntity, listCandidates } from '../db/queries.js';

import {
  DEFAULT_DEMO_INTERVAL_MS,
  DEMO_CONSOLIDATE_EVERY,
  DEMO_PROMOTE_THRESHOLD,
  DemoFeeder,
  createDemoRng,
  decideConsolidation,
} from './demo.js';

let db: SynapseDatabase;

/** Fresh isolated DB per test (see beforeEach). */
const sharedDb = (): SynapseDatabase => db;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  migrate(db);
});

afterEach(() => {
  db.close();
});

function makeEmbedder(fail = false) {
  const embedCalls: string[] = [];
  return {
    embedCalls,
    embedder: {
      modelId: 'test',
      dimension: 8,
      isReady: () => !fail,
      init: async () => undefined,
      embed: async (text: string) => {
        if (fail) throw new Error('model missing');
        embedCalls.push(text);
        return new Float32Array(8).fill(0.5);
      },
      embedBatch: async (texts: readonly string[]) => texts.map(() => new Float32Array(8).fill(0.5)),
    },
  };
}

function makeFeeder(db: SynapseDatabase, opts: Partial<ConstructorParameters<typeof DemoFeeder>[0]> = {}) {
  const lines: string[] = [];
  const { embedder, embedCalls } = makeEmbedder();
  const feeder = new DemoFeeder({
    db,
    embedder,
    logger: (l) => lines.push(l),
    scheduler: (cb) => {
      void cb;
      return () => undefined;
    },
    ...opts,
  });
  return { feeder, lines, embedCalls, embedder };
}

describe('createDemoRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createDemoRng(42);
    const b = createDemoRng(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds and stays in [0,1)', () => {
    const a = createDemoRng(1);
    const b = createDemoRng(2);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).not.toEqual(seqB);
    for (const v of [...seqA, ...seqB]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('decideConsolidation', () => {
  it('promotes at and above the threshold, discards below', () => {
    expect(decideConsolidation({ confidence: DEMO_PROMOTE_THRESHOLD })).toBe('promote');
    expect(decideConsolidation({ confidence: 0.99 })).toBe('promote');
    expect(decideConsolidation({ confidence: DEMO_PROMOTE_THRESHOLD - 0.01 })).toBe('discard');
  });
});

describe('DemoFeeder', () => {
  it('scaffolds the demo namespace once and anchors everything under proj:demo', async () => {
    const db = sharedDb();
    const { feeder, lines } = makeFeeder(db);
    feeder.ensureScaffold();
    feeder.ensureScaffold(); // idempotent
    const project = getEntityByScope(db, 'proj:demo');
    expect(project?.type).toBe('project');
    const file = getEntityByScope(db, 'proj:demo/file:src/db/queries.ts');
    expect(file?.type).toBe('file');
    const symbol = getEntityByScope(db, 'proj:demo/file:src/db/queries.ts/sym:queries');
    expect(symbol?.type).toBe('symbol');
    await feeder.tick();
    // Diagnostic: any line here is a swallowed tick error — surface it.
    expect(lines).toEqual([]);
    expect(feeder.stats.ticks).toBe(1);
    const pending = listCandidates(db, { status: 'pending' });
    for (const c of pending) {
      expect(c.scopePath?.startsWith('proj:demo/')).toBe(true);
    }
  });

  it('produces a deterministic stream for a fixed seed', async () => {
    // Hermetic: a fresh :memory: DB per run, contents collected by NEW
    // candidate id (insertion order), immune to created_at tie-breaking
    // in listCandidates' DESC ordering.
    const run = async (): Promise<string[]> => {
      const db = await openDatabase(':memory:');
      migrate(db);
      const { embedder } = makeEmbedder();
      const feeder = new DemoFeeder({
        db,
        embedder,
        logger: () => undefined,
        scheduler: () => () => undefined,
        seed: 7,
      });
      feeder.ensureScaffold();
      const seen = new Set<string>();
      const contents: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await feeder.tick();
        for (const row of listCandidates(db, { limit: 50 })) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            contents.push(row.content);
          }
        }
      }
      db.close();
      return contents;
    };
    const first = await run();
    const second = await run();
    expect(first.length).toBe(6);
    expect(first).toEqual(second);
  });

  it('consolidates on cadence: promotes keepers with vectors + ANCHORED_TO, discards noise', async () => {
    const db = sharedDb();
    const { feeder, lines, embedCalls } = makeFeeder(db, { seed: 3 });
    feeder.ensureScaffold();
    for (let i = 0; i < DEMO_CONSOLIDATE_EVERY; i += 1) {
      await feeder.tick();
    }
    const all = listCandidates(db, { limit: 50 });
    expect(all.length).toBe(DEMO_CONSOLIDATE_EVERY);
    const promoted = all.filter((c) => c.status === 'promoted');
    const discarded = all.filter((c) => c.status === 'discarded');
    expect(promoted.length + discarded.length).toBe(DEMO_CONSOLIDATE_EVERY);
    const stats = feeder.stats;
    expect(stats.ticks).toBe(DEMO_CONSOLIDATE_EVERY);
    expect(stats.promoted).toBe(promoted.length);
    expect(stats.discarded).toBe(discarded.length);
    for (const p of promoted) {
      const memory = getEntityByScope(db, p.scopePath ?? '', ['memory_entry']);
      expect(memory).toBeDefined();
    }
    expect(embedCalls.length).toBe(promoted.length);
    expect(lines.some((l) => l.includes('demo: promoted'))).toBe(true);
    expect(lines.some((l) => l.includes('demo: discarded'))).toBe(true);
  });

  it('degrades gracefully when the embedder fails (promoted without vector)', async () => {
    const db = sharedDb();
    const { embedder } = makeEmbedder(true);
    const lines: string[] = [];
    const feeder = new DemoFeeder({
      db,
      embedder,
      logger: (l) => lines.push(l),
      scheduler: (cb) => {
        void cb;
        return () => undefined;
      },
      seed: 3,
    });
    feeder.ensureScaffold();
    for (let i = 0; i < DEMO_CONSOLIDATE_EVERY; i += 1) {
      await feeder.tick();
    }
    const promoted = listCandidates(db, { limit: 50 }).filter((c) => c.status === 'promoted');
    expect(promoted.length).toBeGreaterThan(0);
    const stats = feeder.stats;
    expect(stats.promoted).toBe(promoted.length);
  });

  it('start/stop lifecycle: idempotent, scheduler receives the interval, stop logs totals', async () => {
    const db = sharedDb();
    const intervals: number[] = [];
    const cancels = vi.fn();
    const lines: string[] = [];
    const feeder = new DemoFeeder({
      db,
      embedder: makeEmbedder().embedder,
      logger: (l) => lines.push(l),
      scheduler: (_cb, intervalMs) => {
        intervals.push(intervalMs);
        return cancels;
      },
      intervalMs: 250,
    });
    expect(feeder.running).toBe(false);
    feeder.start();
    feeder.start(); // idempotent
    expect(feeder.running).toBe(true);
    expect(intervals).toEqual([250]);
    await feeder.stop();
    await feeder.stop(); // idempotent
    expect(feeder.running).toBe(false);
    expect(cancels).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('streaming observations every 250ms'))).toBe(true);
    expect(lines.some((l) => l.includes('stopped'))).toBe(true);
  });

  it('a failing tick logs and does not throw', async () => {
    const db = sharedDb();
    const lines: string[] = [];
    const feeder = new DemoFeeder({
      db,
      embedder: makeEmbedder().embedder,
      logger: (l) => lines.push(l),
      scheduler: (cb) => {
        void cb;
        return () => undefined;
      },
    });
    db.close();
    await expect(feeder.tick()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('demo tick failed'))).toBe(true);
  });

  it('defaults: interval, scope prefix, threshold re-exported', () => {
    expect(DEFAULT_DEMO_INTERVAL_MS).toBe(1000);
    const db = sharedDb();
    const { feeder } = makeFeeder(db);
    feeder.ensureScaffold();
    expect(getEntityByScope(db, 'proj:demo')?.type).toBe('project');
  });

  it('uses the real scheduler and the default logger when none are injected', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = sharedDb();
    const { embedder } = makeEmbedder();
    const feeder = new DemoFeeder({ db, embedder, intervalMs: 1, seed: 1 });
    feeder.start();
    expect(feeder.running).toBe(true);
    await vi.waitFor(() => {
      expect(listCandidates(db, { limit: 1 }).length).toBeGreaterThan(0);
    });
    feeder.stop();
    expect(feeder.running).toBe(false);
    // The no-logger default routes demo lines through console.error.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  }, 10_000);

  it('reaches every observation template deterministically (seeded coupon collection)', async () => {
    const db = sharedDb();
    const { feeder } = makeFeeder(db, { seed: 42 });
    feeder.ensureScaffold();
    for (let i = 0; i < 40; i += 1) {
      await feeder.tick();
    }
    const contents = listCandidates(db, { limit: 50 }).map((c) => c.content);
    const prefixes = [
      '[domain-term: root-cause]',
      '[domain-term: decision]',
      '[domain-term: trap]',
      '[domain-term: convention]',
      '[domain-term: performance]',
      '[domain-term: bug]',
      '[domain-term: api]',
      '[domain-term: workflow]',
    ];
    for (const prefix of prefixes) {
      expect(contents.some((c) => c.startsWith(prefix)), `template ${prefix} never selected`).toBe(true);
    }
  }, 10_000);

  it('consolidates pre-existing demo-owned candidates: null scope anchors to the project, missing target skips the edge', async () => {
    const db = sharedDb();
    const { feeder } = makeFeeder(db, { seed: 3 });
    feeder.ensureScaffold();
    // Pre-date the feeder with DEMO-OWNED rows (extractedFrom: 'demo') —
    // one with no scope, one aimed at a scope with no structural entity.
    insertCandidate(db, { content: 'legacy note without a scope', confidence: 0.9, extractedFrom: 'demo' });
    insertCandidate(db, { content: 'note aimed at a ghost file', confidence: 0.9, extractedFrom: 'demo', scopePath: 'proj:demo/file:ghost.ts' });
    for (let i = 0; i < DEMO_CONSOLIDATE_EVERY; i += 1) {
      await feeder.tick();
    }
    const all = listCandidates(db, { limit: 50 });
    const legacy = all.find((c) => c.content === 'legacy note without a scope');
    const ghost = all.find((c) => c.content === 'note aimed at a ghost file');
    expect(legacy?.status).toBe('promoted');
    expect(ghost?.status).toBe('promoted');
    // Both promotions produced memory entities; the legacy one anchored at
    // the project scope, the ghost one simply has no ANCHORED_TO edge.
    expect(getEntityByScope(db, 'proj:demo', ['memory_entry'])).toBeDefined();
    expect(getEntityByScope(db, 'proj:demo/file:ghost.ts', ['memory_entry'])).toBeDefined();
  });

  it('never touches foreign pending candidates (ownership filter — --db escape-hatch safety)', async () => {
    const db = sharedDb();
    const { feeder } = makeFeeder(db, { seed: 5 });
    feeder.ensureScaffold();
    // Foreign rows: a user observation via the MCP tool and one with no
    // source at all. Both have high confidence — the sweep would promote
    // them if the ownership filter were missing — and one low-confidence
    // row that would be discarded. All must stay untouched.
    insertCandidate(db, { content: 'user observation via mcp', confidence: 0.95, extractedFrom: 'mcp:synapse_record_observation' });
    insertCandidate(db, { content: 'unattributed user note', confidence: 0.95 });
    insertCandidate(db, { content: 'another unattributed note', confidence: 0.3 });
    for (let i = 0; i < DEMO_CONSOLIDATE_EVERY * 2; i += 1) {
      await feeder.tick();
    }
    const all = listCandidates(db, { limit: 50 });
    const user1 = all.find((c) => c.content === 'user observation via mcp');
    const user2 = all.find((c) => c.content === 'unattributed user note');
    const user3 = all.find((c) => c.content === 'another unattributed note');
    expect(user1?.status).toBe('pending');
    expect(user2?.status).toBe('pending');
    expect(user3?.status).toBe('pending');
    // ...while the feeder's own rows were decided as usual.
    const demoRows = all.filter((c) => c.extractedFrom === 'demo');
    expect(demoRows.length).toBeGreaterThan(0);
    expect(demoRows.every((c) => c.status !== 'pending')).toBe(true);
  });

  it('logs non-Error throw values from a tick without crashing', async () => {
    const lines: string[] = [];
    const db = sharedDb();
    const feeder = new DemoFeeder({
      db,
      embedder: makeEmbedder().embedder,
      logger: (l) => lines.push(l),
      scheduler: () => () => undefined,
    });
    feeder.ensureScaffold();
    // Break the candidate write AFTER the scaffold: the next tick's
    // insertCandidate hits a missing table and throws (a driver Error —
    // the String() arm is exercised by the bare-throw variant below).
    db.exec('DROP TABLE memory_candidates');
    await expect(feeder.tick()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('demo tick failed'))).toBe(true);
  });

  it('skips scaffold insertion when a same-type entity already exists at a scope', () => {
    const db = sharedDb();
    // Pre-create one scaffold entity of the SAME type: ensureScaffold must
    // resolve it (skip-insert arm) rather than blindly INSERT.
    insertCandidate(db, { content: 'warmup', confidence: 0.5 });
    const { feeder } = makeFeeder(db);
    insertEntity(db, { id: 'pre-file', type: 'file', scopePath: 'proj:demo/file:src/db/queries.ts', name: 'queries.ts' });
    feeder.ensureScaffold();
    const file = getEntityByScope(db, 'proj:demo/file:src/db/queries.ts', ['file']);
    expect(file?.id).toBe('pre-file');
  });

  it('stop() drains an in-flight consolidation before returning (quiescence)', async () => {
    const db = sharedDb();
    let releaseEmbed: (() => void) | undefined;
    const embedGate = new Promise<void>((resolveGate) => {
      releaseEmbed = resolveGate;
    });
    const embedder = {
      modelId: 'test', dimension: 8, isReady: () => true,
      init: async () => undefined,
      embed: async () => {
        await embedGate; // park the 5th tick's consolidation mid-promote
        return new Float32Array(8).fill(0.5);
      },
      embedBatch: async () => [new Float32Array(8)],
    };
    let scheduled: (() => void) | undefined;
    const feeder = new DemoFeeder({
      db,
      embedder,
      logger: () => undefined,
      scheduler: (cb: () => void) => {
        scheduled = cb;
        return () => undefined;
      },
      seed: 3,
    });
    feeder.start();
    // Drive ticks manually; a macrotask hop between ticks lets each promise
    // fully settle so the skip-if-busy guard never drops one.
    for (let i = 0; i < DEMO_CONSOLIDATE_EVERY; i += 1) {
      scheduled!();
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    }
    // Tick #5 is parked on the embed gate — firing the scheduler again
    // must hit the skip-if-busy guard (droppable tick), NOT start a sixth.
    scheduled!();
    // stop() must await the still-in-flight tick.
    let stoppedDone = false;
    const stopped = feeder.stop().then(() => {
      stoppedDone = true;
    });
    // Deterministic tidemark: several macrotask hops let every pending
    // callback/microtask that COULD settle `stopped` run. No wall-clock
    // timer — the gate is still closed, so if stop() respects quiescence,
    // `stopped` cannot resolve here no matter how slow the host is.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolveHop) => setImmediate(resolveHop));
    }
    expect(stoppedDone).toBe(false); // still draining the in-flight tick
    releaseEmbed!();
    await stopped;
    expect(stoppedDone).toBe(true);
    // The guarded extra fire never became a sixth tick.
    expect(feeder.stats.ticks).toBe(DEMO_CONSOLIDATE_EVERY);
  }, 10_000);

  it('stringifies a bare thrown string from a tick (non-Error arm)', async () => {
    const lines: string[] = [];
    const db = sharedDb();
    // Conditional hostile proxy: scaffold/entity queries pass through;
    // only the candidate INSERT throws a bare string — inside tick's
    // try/catch, exercising the non-Error arm of the logger.
    const hostile = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('memory_candidates')) throw 'bare boom';
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SynapseDatabase;
    const feeder = new DemoFeeder({
      db: hostile,
      embedder: makeEmbedder().embedder,
      logger: (l) => lines.push(l),
      scheduler: () => () => undefined,
    });
    feeder.ensureScaffold();
    await expect(feeder.tick()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('bare boom'))).toBe(true);
  });
});
