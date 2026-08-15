/**
 * Deterministic fake embedder for tests: bigram-shingle vectors. Similar texts
 * (shared character bigrams) yield higher cosine similarity, so semantic
 * ranking is meaningful without downloading a real model.
 */

import type { Embedder } from '../../src/engine/embedding.js';
import { normalizeInPlace } from '../../src/engine/vector-math.js';

export class FakeEmbedder implements Embedder {
  readonly modelId = 'fake-bigram';
  readonly dimension = 16;
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  async init(): Promise<void> {
    this.ready = true;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.vectorFor(text);
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): Float32Array {
    const vec = new Float32Array(this.dimension);
    const normalized = text.toLowerCase().replace(/[^a-z]/g, '');
    for (let i = 0; i + 1 < normalized.length; i++) {
      const bigram = normalized.slice(i, i + 2);
      let hash = 0;
      for (const ch of bigram) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      vec[hash % this.dimension] = (vec[hash % this.dimension] ?? 0) + 1;
    }
    return normalizeInPlace(vec);
  }
}

export class FailingEmbedder implements Embedder {
  readonly modelId = 'broken';
  readonly dimension = 16;

  isReady(): boolean {
    return false;
  }

  async init(): Promise<void> {
    throw new Error('model not available offline (simulated)');
  }

  async embed(_text: string): Promise<Float32Array> {
    throw new Error('not initialized');
  }

  async embedBatch(_texts: readonly string[]): Promise<Float32Array[]> {
    throw new Error('not initialized');
  }
}
