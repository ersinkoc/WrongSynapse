/**
 * EmbeddingCache — semantic cache behaviour including the batch-aware
 * embedBatch (all misses must be computed in ONE underlying embedBatch call
 * instead of collapsing to per-text embeds).
 */

import { describe, expect, it, vi } from 'vitest';

import { EmbeddingCache } from './embedding-cache.js';
import type { Embedder } from './embedding.js';

/** Recording fake: counts embed vs embedBatch invocations and batch sizes. */
function makeEmbedder(): { embedder: Embedder; calls: { embed: string[]; batches: number[][] } } {
  const calls = { embed: [] as string[], batches: [] as number[][] };
  const embedder: Embedder = {
    modelId: 'fake',
    dimension: 8,
    isReady: () => true,
    init: async () => undefined,
    embed: async (text: string) => {
      calls.embed.push(text);
      return new Float32Array([text.length, 1, 0, 0, 0, 0, 0, 0]);
    },
    embedBatch: async (texts: readonly string[]) => {
      calls.batches.push(texts.map((t) => t.length));
      return texts.map((t) => new Float32Array([t.length, 1, 0, 0, 0, 0, 0, 0]));
    },
  };
  return { embedder, calls };
}

describe('EmbeddingCache.wrap().embed', () => {
  it('computes once and serves the cached vector afterwards', async () => {
    const { embedder, calls } = makeEmbedder();
    const cache = new EmbeddingCache();
    const wrapped = cache.wrap(embedder);

    const first = await wrapped.embed('hello world');
    const second = await wrapped.embed('hello world');

    expect(second).toBe(first); // same Float32Array object — no recompute
    expect(calls.embed).toEqual(['hello world']);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('normalizes cache keys: case and whitespace variants are hits', async () => {
    const { embedder, calls } = makeEmbedder();
    const cache = new EmbeddingCache();
    const wrapped = cache.wrap(embedder);
    await wrapped.embed('Hello   World');
    await wrapped.embed('hello world');
    expect(calls.embed).toHaveLength(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('drops expired entries (lazy TTL) and recomputes', async () => {
    vi.useFakeTimers();
    try {
      const { embedder } = makeEmbedder();
      const cache = new EmbeddingCache({ ttlMs: 1000 });
      const wrapped = cache.wrap(embedder);
      await wrapped.embed('temporal');
      vi.advanceTimersByTime(1500);
      await wrapped.embed('temporal');
      const stats = cache.stats();
      expect(stats.expirations).toBe(1);
      expect(stats.misses).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts least-recently-used entries beyond maxEntries', async () => {
    const { embedder } = makeEmbedder();
    const cache = new EmbeddingCache({ maxEntries: 2 });
    const wrapped = cache.wrap(embedder);
    await wrapped.embed('a');
    await wrapped.embed('b');
    await wrapped.embed('a'); // refresh 'a' so 'b' is the LRU victim
    await wrapped.embed('c'); // evicts 'b'
    const stats = cache.stats();
    expect(stats.evictions).toBe(1);
    expect(stats.size).toBe(2);
    await wrapped.embed('b'); // recomputed after eviction
    expect(cache.stats().misses).toBe(4);
  });

  it('clear() resets entries and counters', async () => {
    const { embedder } = makeEmbedder();
    const cache = new EmbeddingCache();
    const wrapped = cache.wrap(embedder);
    await wrapped.embed('x');
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, evictions: 0, expirations: 0, size: 0 });
    await wrapped.embed('x');
    expect(cache.stats().misses).toBe(1);
  });

  it('forwards model metadata and lifecycle from the wrapped embedder', () => {
    const { embedder } = makeEmbedder();
    const wrapped = new EmbeddingCache().wrap(embedder);
    expect(wrapped.modelId).toBe('fake');
    expect(wrapped.dimension).toBe(8);
    expect(wrapped.isReady()).toBe(true);
  });
});

describe('EmbeddingCache.wrap().embedBatch', () => {
  it('computes all misses in ONE underlying batch call', async () => {
    const { embedder, calls } = makeEmbedder();
    const cache = new EmbeddingCache();
    const wrapped = cache.wrap(embedder);
    const out = await wrapped.embedBatch(['alpha', 'beta', 'gamma']);
    expect(out).toHaveLength(3);
    expect(calls.batches).toEqual([[5, 4, 5]]); // single batch, all misses
    expect(calls.embed).toEqual([]); // never collapsed to per-text embeds
  });

  it('serves cached entries without recomputing them', async () => {
    const { embedder, calls } = makeEmbedder();
    const cache = new EmbeddingCache();
    const wrapped = cache.wrap(embedder);
    await wrapped.embed('alpha'); // prime the cache
    const out = await wrapped.embedBatch(['alpha', 'beta']);
    expect(out[0]![0]).toBe(5); // cached vector for alpha
    expect(calls.batches).toEqual([[4]]); // only beta missed
  });

  it('tolerates an embedder returning fewer rows than requested', async () => {
    const shortEmbedder: Embedder = {
      modelId: 'short',
      dimension: 8,
      isReady: () => true,
      init: async () => undefined,
      embed: async () => new Float32Array(8),
      // Drops the last requested row.
      embedBatch: async (texts: readonly string[]) => texts.slice(0, -1).map(() => new Float32Array(8)),
    };
    const cache = new EmbeddingCache();
    const out = await cache.wrap(shortEmbedder).embedBatch(['x', 'y', 'z']);
    expect(out[0]).toBeDefined();
    expect(out[1]).toBeDefined();
    expect(out[2]).toBeUndefined(); // hole preserved for the missing row
  });

  it('returns an empty array for an empty batch without touching the embedder', async () => {
    const { embedder, calls } = makeEmbedder();
    const cache = new EmbeddingCache();
    const out = await cache.wrap(embedder).embedBatch([]);
    expect(out).toEqual([]);
    expect(calls.batches).toEqual([]);
  });

  it('recomputes entries that expired between batch calls', async () => {
    vi.useFakeTimers();
    try {
      const { embedder, calls } = makeEmbedder();
      const cache = new EmbeddingCache({ ttlMs: 1000 });
      const wrapped = cache.wrap(embedder);
      await wrapped.embed('temporal batch');
      vi.advanceTimersByTime(1500);
      const out = await wrapped.embedBatch(['temporal batch', 'fresh']);
      expect(out[0]![0]).toBe(14); // recomputed: expired entry missed the cache
      expect(out[1]![0]).toBe(5);
      expect(calls.batches).toEqual([[14, 5]]); // both rows missed → one batch
      expect(cache.stats().expirations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives maxEntries=0 (eviction arm with an empty cache)', async () => {
    const { embedder } = makeEmbedder();
    const cache = new EmbeddingCache({ maxEntries: 0 });
    const wrapped = cache.wrap(embedder);
    const out = await wrapped.embed('uncached by cfg');
    expect(out[0]).toBe('uncached by cfg'.length);
    expect(cache.stats().size).toBe(1); // insert still lands; nothing to evict
  });
});
