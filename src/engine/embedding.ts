/**
 * Local embedding engine backed by transformers.js (`@huggingface/transformers`
 * v4, the maintained successor of `@xenova/transformers`).
 *
 * Model: `Xenova/all-MiniLM-L6-v2` (384-dim, mean-pooled, L2-normalized).
 *
 * Zero cloud: model files are read from the local filesystem cache. Remote
 * fetching is disabled by default; set `SYNAPSE_ALLOW_REMOTE_MODEL=1` once to
 * download the model into the cache, after which everything runs offline.
 * `SYNAPSE_MODEL_DIR` / `SYNAPSE_EMBEDDING_MODEL` override the model location
 * and id.
 */

import { env, pipeline, type Tensor } from '@huggingface/transformers';
import { resolve } from 'node:path';

import { EMBEDDING_DIMENSION, meanPool, normalizeInPlace } from './vector-math.js';

export interface Embedder {
  readonly modelId: string;
  readonly dimension: number;
  isReady(): boolean;
  init(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface EmbeddingOptions {
  modelId?: string;
  localModelDir?: string;
  allowRemoteModels?: boolean;
  maxBatchSize?: number;
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Narrow structural type for the feature-extraction pipeline we consume. */
interface FeatureExtractionPipelineLike {
  (texts: string | string[], options?: { pooling?: 'mean'; normalize?: boolean }): Promise<Tensor>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flattenNumbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) {
    const out: number[] = [];
    for (const item of value) out.push(...flattenNumbers(item));
    return out;
  }
  return [];
}

function tensorData(tensor: Tensor): Float32Array {
  const data = tensor.data;
  if (data instanceof Float32Array) return data;
  return Float32Array.from(flattenNumbers(data));
}

/**
 * Convert a feature-extraction output tensor into `expected` row vectors.
 * Handles `[dim]`, `[n, dim]` (pooled) and `[n, seq, dim]` (per-token, with a
 * mean-pool fallback) shapes. Every returned vector is L2-normalized.
 */
function vectorsFromTensor(tensor: Tensor, expected: number): Float32Array[] {
  const data = tensorData(tensor);
  const dims = tensor.dims;
  if (dims.length <= 1) return [normalizeInPlace(data.slice())];
  // dims.length >= 2 here, so index 0 is always present.
  /* v8 ignore next */
  const n = dims[0] ?? 1;
  const rest = dims.slice(1);
  const per = rest.reduce((a, b) => a * b, 1);
  const out: Float32Array[] = [];
  const count = Math.min(n, expected);
  for (let i = 0; i < count; i++) {
    const row = data.slice(i * per, (i + 1) * per);
    if (rest.length === 1) {
      out.push(normalizeInPlace(row));
    } else {
      // rest.length >= 2 here, so the last dimension always exists; the
      // fallback is defensive against shape-shifting backends.
      /* v8 ignore next */
      const dim = rest[rest.length - 1] ?? EMBEDDING_DIMENSION;
      out.push(normalizeInPlace(meanPool(row, per / dim, dim)));
    }
  }
  return out;
}

class TransformersEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension = EMBEDDING_DIMENSION;
  readonly maxBatchSize: number;
  private extractor: FeatureExtractionPipelineLike | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: EmbeddingOptions = {}) {
    this.modelId = options.modelId ?? process.env['SYNAPSE_EMBEDDING_MODEL'] ?? DEFAULT_EMBEDDING_MODEL;
    this.maxBatchSize = options.maxBatchSize ?? 32;
    // `env` is a process-global singleton; configure it at construction time.
    env.allowRemoteModels = options.allowRemoteModels ?? process.env['SYNAPSE_ALLOW_REMOTE_MODEL'] === '1';
    env.allowLocalModels = true;
    const modelDir = options.localModelDir ?? process.env['SYNAPSE_MODEL_DIR'];
    if (modelDir !== undefined) {
      env.localModelPath = resolve(modelDir);
    }
  }

  isReady(): boolean {
    return this.extractor !== null;
  }

  init(): Promise<void> {
    if (this.extractor !== null) return Promise.resolve();
    if (this.initPromise === null) {
      this.initPromise = this.load().catch((error: unknown) => {
        this.initPromise = null; // allow a later retry
        throw error;
      });
    }
    return this.initPromise;
  }

  private async load(): Promise<void> {
    try {
      const factory = await pipeline('feature-extraction', this.modelId, { dtype: 'q8' });
      this.extractor = factory as unknown as FeatureExtractionPipelineLike;
    } catch (error) {
      throw new Error(
        `Failed to load embedding model '${this.modelId}'. If it is not cached locally and you are ` +
          `offline, run once with SYNAPSE_ALLOW_REMOTE_MODEL=1 to download it (one-time bootstrap), or point ` +
          `SYNAPSE_MODEL_DIR at a directory containing the model files. Underlying error: ${describeError(error)}`,
      );
    }
  }

  /* v8 ignore start -- unreachable via the public API: embed()/embedBatch() always await init() first, which either sets the extractor or throws */
  private requireExtractor(): FeatureExtractionPipelineLike {
    if (this.extractor === null) {
      throw new Error(`Embedding engine not initialized for model '${this.modelId}'. Call init() first.`);
    }
    return this.extractor;
  }
  /* v8 ignore stop */

  async embed(text: string): Promise<Float32Array> {
    await this.init();
    const tensor = await this.requireExtractor()(text, { pooling: 'mean', normalize: true });
    const vectors = vectorsFromTensor(tensor, 1);
    // vectorsFromTensor always returns at least one row for 1-D output; the
    // fallback guards against shape-shifting ONNX backends.
    /* v8 ignore next */
    return vectors[0] ?? new Float32Array(this.dimension);
  }

  async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const extractor = this.requireExtractor();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const chunk = texts.slice(i, i + this.maxBatchSize);
      const tensor = await extractor(chunk, { pooling: 'mean', normalize: true });
      out.push(...vectorsFromTensor(tensor, chunk.length));
    }
    return out;
  }
}

/** Create a fresh embedder (mostly for tests and custom configuration). */
export function createEmbedder(options?: EmbeddingOptions): Embedder {
  return new TransformersEmbedder(options);
}

let sharedEmbedder: Embedder | null = null;

/** Process-wide singleton embedder (lazy; never touches the network unless allowed). */
export function getSharedEmbedder(options?: EmbeddingOptions): Embedder {
  sharedEmbedder ??= new TransformersEmbedder(options);
  return sharedEmbedder;
}
