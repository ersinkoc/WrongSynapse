/**
 * Local embedding engine backed by transformers.js (`@huggingface/transformers`
 * v4, the maintained successor of `@xenova/transformers`).
 *
 * Model: `Xenova/all-MiniLM-L6-v2` (384-dim, mean-pooled, L2-normalized).
 *
 * Run-and-use: the model is read from the local filesystem cache, and when it
 * is not cached yet it is downloaded ONCE automatically (≈ 25 MB from the
 * HuggingFace CDN) — after that everything runs offline. Strict-offline
 * deployments can forbid the download with `noRemoteModels` /
 * `SYNAPSE_NO_REMOTE_MODEL=1`; `SYNAPSE_ALLOW_REMOTE_MODEL=1` keeps the older
 * always-allow semantics. `SYNAPSE_MODEL_DIR` / `SYNAPSE_EMBEDDING_MODEL`
 * override the model location and id.
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
  /** Always allow remote model fetches (legacy opt-in; the default already
   * downloads once on a cache miss). */
  allowRemoteModels?: boolean;
  /** Never touch the network: load from cache or fail (strict offline). */
  noRemoteModels?: boolean;
  maxBatchSize?: number;
}

/**
 * How the embedder may reach the model:
 * - 'auto'  (default) local cache first; on a miss, download once, then
 *   return to local-only for the rest of the process.
 * - 'allow' remote fetching enabled up front (SYNAPSE_ALLOW_REMOTE_MODEL=1).
 * - 'never' strict offline (SYNAPSE_NO_REMOTE_MODEL=1 / noRemoteModels).
 */
export type RemoteModelMode = 'auto' | 'allow' | 'never';

/** Pure resolution of options + environment into a {@link RemoteModelMode}. */
export function resolveRemoteMode(
  options: Pick<EmbeddingOptions, 'allowRemoteModels' | 'noRemoteModels'>,
  envVars: Record<string, string | undefined> = process.env,
): RemoteModelMode {
  if (options.allowRemoteModels === true) return 'allow';
  // An explicit false is a deliberate opt-out (pre-'auto' callers passed it
  // to mean "never fetch") — honor it as strict offline.
  if (options.noRemoteModels === true || options.allowRemoteModels === false) return 'never';
  if (envVars['SYNAPSE_ALLOW_REMOTE_MODEL'] === '1') return 'allow';
  if (envVars['SYNAPSE_NO_REMOTE_MODEL'] === '1') return 'never';
  return 'auto';
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
  private readonly remoteMode: RemoteModelMode;
  private extractor: FeatureExtractionPipelineLike | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: EmbeddingOptions = {}) {
    this.modelId = options.modelId ?? process.env['SYNAPSE_EMBEDDING_MODEL'] ?? DEFAULT_EMBEDDING_MODEL;
    this.maxBatchSize = options.maxBatchSize ?? 32;
    this.remoteMode = resolveRemoteMode(options);
    // `env` is a process-global singleton; configure it at construction time.
    // 'auto' and 'never' start local-only — the 'auto' download happens as a
    // single explicit retry in load(), never as an ambient fetch.
    env.allowRemoteModels = this.remoteMode === 'allow';
    env.allowLocalModels = true;
    const modelDir = options.localModelDir ?? process.env['SYNAPSE_MODEL_DIR'];
    if (modelDir !== undefined) {
      env.localModelPath = resolve(modelDir);
      env.cacheDir = resolve(modelDir);
    } else {
      // Default cache resolution: transformers.js roots BOTH its download
      // cache (env.cacheDir, used by FileCache) and its local-model read
      // path (env.localModelPath) inside node_modules of the package —
      // which for a global `npm i -g wrongsynapse` install is the global
      // install tree. Point both at a per-user directory so one downloaded
      // model serves every project and survives reinstalls; fall back to a
      // local .cache when HOME is unavailable. Setting only ONE of the two
      // splits reads from writes (downloads would still land in the
      // install tree).
      const home = process.env['HOME'] ?? process.env['USERPROFILE'];
      const cache = home !== undefined ? resolve(home, '.cache', 'wrongsynapse') : resolve('./.cache');
      env.localModelPath = cache;
      env.cacheDir = cache;
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
      await this.tryLoadPipeline();
      return;
    } catch (error) {
      // 'auto': the local-only attempt missed the cache — retry exactly once
      // with remote fetching enabled so the model downloads into the cache.
      // 'allow' already fetched remote in tryLoadPipeline; 'never' must stay
      // offline. Both surface the ORIGINAL error with a mode-specific hint.
      if (this.remoteMode !== 'auto') {
        const context =
          this.remoteMode === 'never'
            ? 'Strict-offline mode is on, so no download was attempted. '
            : 'Remote fetching was allowed but the model still could not be loaded (no network?). ';
        throw this.describeLoadFailure(error, context);
      }
    }
    try {
      env.allowRemoteModels = true;
      await this.tryLoadPipeline();
    } catch (error) {
      throw this.describeLoadFailure(error, 'The automatic one-time model download failed (no network?). ');
    } finally {
      // Back to local-only: the one-time download is the only network this
      // process ever performs.
      env.allowRemoteModels = false;
    }
  }

  private async tryLoadPipeline(): Promise<void> {
    const factory = await pipeline('feature-extraction', this.modelId, { dtype: 'q8' });
    this.extractor = factory as unknown as FeatureExtractionPipelineLike;
  }

  private describeLoadFailure(error: unknown, context: string): Error {
    return new Error(
      `Failed to load embedding model '${this.modelId}'. ${context}` +
        `Connect once so the ≈25 MB model can be cached automatically, or point SYNAPSE_MODEL_DIR at a ` +
        `directory containing the model files. Underlying error: ${describeError(error)}`,
    );
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
