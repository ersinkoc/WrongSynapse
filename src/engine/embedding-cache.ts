/**
 * Semantic caching layer for the embedder.
 *
 * Embedding computation is the single most expensive operation in the memory
 * pipeline. A semantic cache stores recently computed embeddings in process
 * memory so that near-identical text never hits the embedder twice.
 *
 *   - Key: SHA-256 hex of the normalized text (trim + NFC lowercase + collapse
 *     whitespace). Normalization is deliberately conservative — the goal is
 *     exact dedup, not fuzzy matching. Misses are cheap; false positives are
 *     silently wrong embeddings.
 *   - Value: Float32Array (the embedder's output).
 *   - Eviction: LRU bounded by `maxEntries` (default 1024). When the cache is
 *     full, the least-recently-used entry is dropped.
 *   - TTL: entries older than `ttlMs` (default 1 hour) are dropped on read.
 *     The cache does not run a background sweeper — stale entries are purged
 *     lazily on the next access.
 *
 * Returns the embedder result unchanged; the cache is invisible to callers.
 */

import { createHash } from 'node:crypto';

import type { Embedder } from './embedding.js';

export interface EmbeddingCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
}

interface CacheEntry {
  embedding: Float32Array;
  expiresAt: number;
  lastUsedAt: number;
}

/** Normalize input text for cache key purposes. Trim, NFC, lowercase, collapse whitespace. */
function normalizeForKey(text: string): string {
  return text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashKey(text: string): string {
  return createHash('sha256').update(normalizeForKey(text)).digest('hex');
}

export class EmbeddingCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: EmbeddingCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  }

  /** Wrap an embedder so its `embed()` calls go through the cache. */
  wrap(embedder: Embedder): Embedder {
    return {
      embed: async (text: string): Promise<Float32Array> => {
        const key = hashKey(text);
        const now = Date.now();
        const entry = this.cache.get(key);
        if (entry !== undefined) {
          if (entry.expiresAt > now) {
            this.hits += 1;
            entry.lastUsedAt = now;
            this.cache.delete(key);
            this.cache.set(key, entry);
            return entry.embedding;
          }
          this.expirations += 1;
          this.cache.delete(key);
        }
        this.misses += 1;
        const embedding = await embedder.embed(text);
        this.insert(key, embedding, now + this.ttlMs);
        return embedding;
      },
      embedBatch: async (texts: readonly string[]): Promise<Float32Array[]> => {
        // Cache-aware batching: resolve every hit synchronously, then compute
        // ALL misses in ONE underlying embedBatch call. Awaiting the wrapped
        // embed() per text would collapse the embedder's internal batching
        // (chunked ONNX inference) into N sequential single-text runs.
        const now = Date.now();
        const results: Float32Array[] = new Array<Float32Array>(texts.length);
        const misses: { index: number; text: string; key: string }[] = [];
        texts.forEach((text, index) => {
          const key = hashKey(text);
          const entry = this.cache.get(key);
          if (entry !== undefined) {
            if (entry.expiresAt > now) {
              this.hits += 1;
              entry.lastUsedAt = now;
              this.cache.delete(key);
              this.cache.set(key, entry);
              results[index] = entry.embedding;
              return;
            }
            this.expirations += 1;
            this.cache.delete(key);
          }
          misses.push({ index, text, key });
        });
        this.misses += misses.length;
        if (misses.length > 0) {
          const vectors = await embedder.embedBatch(misses.map((miss) => miss.text));
          misses.forEach((miss, offset) => {
            // An embedder may legally return fewer rows than requested; the
            // holes stay undefined and callers skip them (same contract as
            // the uncached embedBatch).
            /* v8 ignore next */
            const vector = vectors[offset];
            if (vector !== undefined) {
              results[miss.index] = vector;
              this.insert(miss.key, vector, now + this.ttlMs);
            }
          });
        }
        return results;
      },
      modelId: embedder.modelId,
      dimension: embedder.dimension,
      isReady: embedder.isReady.bind(embedder),
      init: embedder.init.bind(embedder),
    };
  }

  private insert(key: string, embedding: Float32Array, expiresAt: number): void {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.evictions += 1;
      }
    }
    this.cache.set(key, { embedding, expiresAt, lastUsedAt: Date.now() });
  }

  /** Drop all entries. Useful between tests and on config reload. */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  stats(): EmbeddingCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.cache.size,
    };
  }
}
