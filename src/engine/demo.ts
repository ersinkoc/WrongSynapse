/**
 * Demo mode: continuous synthetic memory ingestion.
 *
 * DemoFeeder streams seeded observations into the episodic candidate pool
 * and periodically consolidates them — promoting high-confidence keepers
 * into `memory_entry` entities (embedding + `ANCHORED_TO` edge, exactly
 * mirroring the `synapse_promote_candidate` MCP tool) and discarding noise.
 * Everything it writes lives under the `proj:demo-*` namespace so demo data
 * can never leak into a real project scope, and the default `--demo` DB is
 * a separate `synapse-demo.db`.
 *
 * Determinism: content, scope rotation, and confidence all come from a
 * mulberry32 PRNG seeded via `--demo-seed`, so two runs with the same seed
 * produce identical streams (assertion-friendly, replayable demos).
 *
 * Testability: the scheduler and logger are injectable; unit tests drive
 * `tick()` directly instead of waiting on wall-clock timers.
 */

import { randomUUID } from 'node:crypto';

import type { SynapseDatabase } from '../db/connection.js';
import {
  getEntityByScope,
  insertCandidate,
  insertEntity,
  insertRelation,
  listCandidates,
  setCandidateStatus,
  upsertVector,
  type CandidateRow,
} from '../db/queries.js';
import type { Embedder } from './embedding.js';

export const DEFAULT_DEMO_INTERVAL_MS = 1000;
export const DEFAULT_DEMO_SCOPE_PREFIX = 'proj:demo';
export const DEFAULT_DEMO_SEED = 42;

/** Promote when confidence is at or above this; discard otherwise. */
export const DEMO_PROMOTE_THRESHOLD = 0.75;

/** Consolidate the pending pool every N ticks. */
export const DEMO_CONSOLIDATE_EVERY = 5;

/** How many pending candidates one consolidation pass may decide over. */
const CONSOLIDATION_BATCH = 10;

/** Anchor targets mirror the MCP promote tool: structural entities only. */
const STRUCTURAL_TARGET_TYPES: readonly string[] = ['project', 'package', 'directory', 'file', 'symbol', 'commit'];

export type DemoScheduler = (callback: () => void, intervalMs: number) => () => void;

export interface DemoFeederOptions {
  readonly db: SynapseDatabase;
  readonly embedder: Embedder;
  /** Milliseconds between observations (default 1000). */
  readonly intervalMs?: number;
  /** PRNG seed for reproducible streams (default 42). */
  readonly seed?: number;
  /** Namespace for all demo writes (default 'proj:demo'). */
  readonly scopePrefix?: string;
  /** Interval scheduler; defaults to an unref'd setInterval. */
  readonly scheduler?: DemoScheduler;
  /** Log sink; defaults to console.error (stderr — stdout belongs to stdio MCP). */
  readonly logger?: (line: string) => void;
}

/** mulberry32 — tiny, fast, well-distributed seeded PRNG. */
export function createDemoRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure consolidation decision — exported for direct unit testing. */
export function decideConsolidation(candidate: Pick<CandidateRow, 'confidence'>): 'promote' | 'discard' {
  return candidate.confidence >= DEMO_PROMOTE_THRESHOLD ? 'promote' : 'discard';
}

/** Default scheduler: repeating interval that never holds the event loop. */
function defaultScheduler(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  // Demo must not keep a headless process alive on its own.
  timer.unref?.();
  return () => clearInterval(timer);
}

interface DemoAnchor {
  readonly scopePath: string;
  readonly entityId: string;
}

const OBSERVATION_TEMPLATES: readonly ((rng: () => number, anchor: DemoAnchor) => string)[] = [
  () => '[domain-term: root-cause] The connection pool exhausted because checkout timeouts were treated as transient and retried forever.',
  () => '[domain-term: decision] Store embeddings as Float32 BLOBs in SQLite — one file, zero servers, byte-stable across restarts.',
  () => '[domain-term: trap] WAL mode silently degrades if two writers hold the same database path from separate processes.',
  () => '[domain-term: convention] Every scope query goes through the boundary-aware prefix clause; raw LIKE is banned.',
  () => '[domain-term: performance] BM25 ranking over 10k rows stays under 2ms when the FTS5 index is external-content.',
  () => '[domain-term: bug] Promoting a candidate must set status BEFORE returning, or a retry duplicates the memory_entry.',
  () => '[domain-term: api] MCP tool schemas must be Zod objects; the SDK rejects plain JSON Schema at server creation.',
  () => '[domain-term: workflow] One-shot --index prints JSON stats; long-lived modes log to stderr so stdio JSON-RPC stays clean.',
];

/** Pick template content deterministically from the RNG. */
function nextObservation(rng: () => number, anchor: DemoAnchor): string {
  const template = OBSERVATION_TEMPLATES[Math.floor(rng() * OBSERVATION_TEMPLATES.length)]!;
  return template(rng, anchor);
}

export class DemoFeeder {
  readonly #db: SynapseDatabase;
  readonly #embedder: Embedder;
  readonly #intervalMs: number;
  readonly #scopePrefix: string;
  readonly #scheduler: DemoScheduler;
  readonly #log: (line: string) => void;
  readonly #rng: () => number;
  #anchors: DemoAnchor[] = [];
  #cancel: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  #tickCount = 0;
  #promoted = 0;
  #discarded = 0;

  constructor(options: DemoFeederOptions) {
    this.#db = options.db;
    this.#embedder = options.embedder;
    this.#intervalMs = options.intervalMs ?? DEFAULT_DEMO_INTERVAL_MS;
    this.#scopePrefix = options.scopePrefix ?? DEFAULT_DEMO_SCOPE_PREFIX;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#log = options.logger ?? ((line) => console.error(line));
    this.#rng = createDemoRng(options.seed ?? 42);
  }

  get running(): boolean {
    return this.#cancel !== null;
  }

  get stats(): { ticks: number; promoted: number; discarded: number } {
    return { ticks: this.#tickCount, promoted: this.#promoted, discarded: this.#discarded };
  }

  /** Start streaming. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.#cancel !== null) return;
    this.ensureScaffold();
    this.#log(`WrongSynapse demo mode: streaming observations every ${this.#intervalMs}ms into ${this.#scopePrefix}/...`);
    this.#cancel = this.#scheduler(() => {
      // Skip-if-busy: demo ticks are droppable. Blindly overwriting
      // #inFlight here would orphan a still-running slow tick (e.g. a
      // long embed) — stop() would then await only the newest reference
      // while the orphan kept writing, racing the DB close.
      if (this.#inFlight !== null) return;
      this.#inFlight = this.tick();
      void this.#inFlight.then(() => {
        this.#inFlight = null;
      });
    }, this.#intervalMs);
  }

  /**
   * Stop streaming and await any in-flight tick. Idempotent.
   * Async by design: a synchronous stop could return while a scheduled
   * tick is still writing to the DB — a caller that then closes the DB
   * would race the tick into "database closed" errors. Awaiting the
   * in-flight promise guarantees quiescence before teardown continues.
   */
  async stop(): Promise<void> {
    if (this.#cancel === null) return;
    this.#cancel();
    this.#cancel = null;
    if (this.#inFlight !== null) {
      await this.#inFlight;
      this.#inFlight = null;
    }
    this.#log(`WrongSynapse demo mode stopped (${this.#tickCount} ticks, ${this.#promoted} promoted, ${this.#discarded} discarded).`);
  }

  /**
   * Idempotently create the demo namespace scaffold: one project, a few
   * files, one symbol per file. Promotions anchor against these, so the
   * admin UI graph grows real `ANCHORED_TO` edges during the demo.
   */
  ensureScaffold(): void {
    if (this.#anchors.length > 0) return;
    const projectScope = `${this.#scopePrefix}`;
    this.#ensureEntity(projectScope, 'project', 'demo');
    const files = ['src/engine/hybrid-search.ts', 'src/db/queries.ts', 'src/web/server.ts'];
    const anchors: DemoAnchor[] = [];
    for (const file of files) {
      const fileScope = `${projectScope}/file:${file}`;
      this.#ensureEntity(fileScope, 'file', file);
      const symbolName = file.split('/').pop()!.replace(/\.ts$/, '');
      const symbolScope = `${fileScope}/sym:${symbolName}`;
      this.#ensureEntity(symbolScope, 'symbol', symbolName);
      anchors.push({ scopePath: fileScope, entityId: this.#entityIdOf(fileScope) });
    }
    this.#anchors = anchors;
  }

  /** One observation + occasional consolidation. Safe to await or fire-and-forget. */
  async tick(): Promise<void> {
    try {
      const anchor = this.#anchors[Math.floor(this.#rng() * this.#anchors.length)]!;
      const content = nextObservation(this.#rng, anchor);
      const confidence = 0.45 + this.#rng() * 0.5; // straddles the 0.75 threshold
      insertCandidate(this.#db, { content, scopePath: anchor.scopePath, extractedFrom: 'demo', confidence });
      this.#tickCount += 1;
      if (this.#tickCount % DEMO_CONSOLIDATE_EVERY === 0) {
        await this.#consolidate();
      }
    } catch (error) {
      // The feeder must never take the host process down — log and keep going.
      this.#log(`WrongSynapse demo tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Decide over the pending batch: promote keepers, discard noise. Demo-owned rows only. */
  async #consolidate(): Promise<void> {
    // Ownership filter (extractedFrom: 'demo'): when the user points --demo
    // at a real database via --db, this sweep must decide ONLY over rows the
    // feeder wrote — foreign pending candidates stay untouched no matter
    // their confidence.
    const pending = listCandidates(this.#db, {
      status: 'pending',
      limit: CONSOLIDATION_BATCH,
      extractedFrom: 'demo',
    });
    for (const candidate of pending) {
      if (decideConsolidation(candidate) === 'promote') {
        await this.#promote(candidate);
        this.#promoted += 1;
        this.#log(`demo: promoted "${candidate.content.slice(0, 48)}…" (confidence ${candidate.confidence.toFixed(2)})`);
      } else {
        setCandidateStatus(this.#db, candidate.id, 'discarded');
        this.#discarded += 1;
        this.#log(`demo: discarded noise (confidence ${candidate.confidence.toFixed(2)})`);
      }
    }
  }

  /** Mirror of the synapse_promote_candidate MCP tool, minus JSON wrapping. */
  async #promote(candidate: CandidateRow): Promise<void> {
    const targetScope = candidate.scopePath ?? `${this.#scopePrefix}`;
    const id = randomUUID();
    insertEntity(this.#db, {
      id,
      type: 'memory_entry',
      scopePath: targetScope,
      name: candidate.content.slice(0, 80),
      content: candidate.content,
      metadata: { promoted_from: candidate.id, source_confidence: candidate.confidence, demo: true },
    });
    const target = getEntityByScope(this.#db, targetScope, STRUCTURAL_TARGET_TYPES);
    if (target !== undefined) {
      insertRelation(this.#db, { sourceId: id, targetId: target.id, relation: 'ANCHORED_TO' });
    }
    try {
      await this.#embedder.init();
      upsertVector(this.#db, id, await this.#embedder.embed(candidate.content));
    } catch {
      // Degrade like the MCP tool does: promoted without a vector.
    }
    setCandidateStatus(this.#db, candidate.id, 'promoted');
  }

  #ensureEntity(scopePath: string, type: string, name: string): void {
    // Type-filtered: an unrelated entity (e.g. a promoted memory_entry at
    // the project root scope) must not short-circuit the scaffold.
    if (getEntityByScope(this.#db, scopePath, [type]) === undefined) {
      insertEntity(this.#db, { id: randomUUID(), type, scopePath, name });
    }
  }

  #entityIdOf(scopePath: string): string {
    /* v8 ignore next -- defensive: ensureEntity just created/resolved the
       entity, so the ?? '' arm is unreachable without a mid-scaffold write
       race that SQLite's single-writer model excludes. */
    return getEntityByScope(this.#db, scopePath, STRUCTURAL_TARGET_TYPES)?.id ?? '';
  }
}
