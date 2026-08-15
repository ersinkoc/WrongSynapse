/**
 * embedding.ts — exercised without a real model by mocking the transformers.js
 * pipeline. Covers tensor-shape handling ([dim], [n,dim], [n,seq,dim]),
 * constructor env configuration, init/retry semantics, and the singleton.
 */

import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const envMock = {
    allowRemoteModels: false,
    allowLocalModels: true,
    localModelPath: undefined as string | undefined,
  };
  const pipelineMock = vi.fn();
  return { envMock, pipelineMock };
});

vi.mock('@huggingface/transformers', () => ({
  env: mocks.envMock,
  pipeline: mocks.pipelineMock,
}));

const { envMock, pipelineMock } = mocks;

import { createEmbedder, getSharedEmbedder, DEFAULT_EMBEDDING_MODEL } from './embedding.js';

class FakeTensor {
  readonly data: Float32Array;
  readonly dims: number[];
  constructor(data: number[], dims: number[]) {
    this.data = new Float32Array(data);
    this.dims = dims;
  }
}

function installPipeline(shape: 'vector' | 'batch' | 'tokens'): void {
  pipelineMock.mockResolvedValue(async (texts: string | string[], options?: { pooling?: string }) => {
    void options;
    const n = typeof texts === 'string' ? 1 : texts.length;
    if (shape === 'vector') return new FakeTensor([1, 0, 0, 0], [4]);
    if (shape === 'batch') return new FakeTensor([1, 0, 0, 0, 0, 1, 0, 0], [n, 4]);
    // tokens: [n, seq, dim] -> 2 rows * 2 seq * 4 dim = 16 values
    return new FakeTensor([1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0], [n, 2, 4]);
  });
}

describe('createEmbedder / configuration', () => {
  beforeEach(() => {
    envMock.allowRemoteModels = false;
    envMock.localModelPath = undefined;
    pipelineMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies constructor options to the transformers env', () => {
    createEmbedder({ modelId: 'custom/model', allowRemoteModels: true, localModelDir: '/tmp/models' });
    expect(envMock.allowRemoteModels).toBe(true);
    // localModelPath is resolved to an absolute path by the embedder
    expect(envMock.localModelPath).toBe(resolve('/tmp/models'));
  });

  it('defaults to the canonical model id', () => {
    expect(createEmbedder().modelId).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(createEmbedder().dimension).toBe(384);
  });

  it('reads env vars when no options are given', () => {
    vi.stubEnv('SYNAPSE_EMBEDDING_MODEL', 'env/model');
    vi.stubEnv('SYNAPSE_MODEL_DIR', 'C:\\models');
    vi.stubEnv('SYNAPSE_ALLOW_REMOTE_MODEL', '1');
    const embedder = createEmbedder();
    expect(embedder.modelId).toBe('env/model');
    expect(envMock.allowRemoteModels).toBe(true);
    expect(envMock.localModelPath).toBe('C:\\models');
  });
});

describe('TransformersEmbedder lifecycle', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('is not ready before init, loads lazily, and is ready after', async () => {
    installPipeline('vector');
    const embedder = createEmbedder();
    expect(embedder.isReady()).toBe(false);
    await embedder.init();
    expect(embedder.isReady()).toBe(true);
    // a second init resolves without reloading
    await embedder.init();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('embeds a single [dim] output', async () => {
    installPipeline('vector');
    const vec = await createEmbedder().embed('hello');
    expect(vec.length).toBe(4);
    expect(vec[0]).toBeCloseTo(1, 6); // normalized [1,0,0,0]
  });

  it('embeds a batch of [n, dim] outputs', async () => {
    installPipeline('batch');
    const out = await createEmbedder().embedBatch(['a', 'b']);
    expect(out.length).toBe(2);
    expect(out[0]!.length).toBe(4);
  });

  it('mean-pools [n, seq, dim] outputs', async () => {
    installPipeline('tokens');
    const out = await createEmbedder().embedBatch(['a', 'b']);
    expect(out.length).toBe(2);
    // rows [1,0,0,0] and [0,1,0,0] pooled + normalized -> length 4
    expect(out[0]!.length).toBe(4);
  });

  it('returns an empty array for an empty batch without loading', async () => {
    const embedder = createEmbedder();
    await expect(embedder.embedBatch([])).resolves.toEqual([]);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('wraps pipeline load failures with a descriptive error', async () => {
    pipelineMock.mockRejectedValue(new Error('network offline'));
    const embedder = createEmbedder({ allowRemoteModels: false });
    await expect(embedder.init()).rejects.toThrow(/Failed to load embedding model/);
    expect(embedder.isReady()).toBe(false);
  });

  it('stringifies non-Error pipeline failures', async () => {
    pipelineMock.mockRejectedValue('raw string failure');
    const embedder = createEmbedder();
    await expect(embedder.init()).rejects.toThrow(/raw string failure/);
  });

  it('shares one in-flight init promise between concurrent callers', async () => {
    installPipeline('vector');
    const embedder = createEmbedder();
    // Second init() arrives while the first is still pending: it must reuse
    // initPromise, not spawn a second pipeline load.
    const first = embedder.init();
    const second = embedder.init();
    await Promise.all([first, second]);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed load', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('first fail'));
    const embedder = createEmbedder();
    await expect(embedder.init()).rejects.toThrow();
    installPipeline('vector');
    await expect(embedder.init()).resolves.toBeUndefined();
    expect(embedder.isReady()).toBe(true);
  });

  it('throws when embedding before a successful init', async () => {
    pipelineMock.mockRejectedValue(new Error('offline'));
    const embedder = createEmbedder();
    await expect(embedder.embed('x')).rejects.toThrow();
  });
});

describe('getSharedEmbedder', () => {
  it('returns the same singleton instance', () => {
    expect(getSharedEmbedder()).toBe(getSharedEmbedder());
  });
});

describe('tensor data coercion (non-Float32Array pipeline outputs)', () => {
  /** A pipeline output whose `.data` is not a Float32Array (some ONNX backends
   * hand back plain or nested arrays); tensorData must flatten it. */
  function rawTensor(data: unknown, dims: number[]): object {
    return { data, dims };
  }

  it('flattens a plain number array', async () => {
    pipelineMock.mockResolvedValue(async () => rawTensor([1, 0, 0, 0], [4]));
    const vec = await createEmbedder().embed('hello');
    expect(vec.length).toBe(4);
    expect(vec[0]).toBeCloseTo(1, 6);
  });

  it('flattens nested number arrays', async () => {
    pipelineMock.mockResolvedValue(async () => rawTensor([[1, 0], [0, 0]], [4]));
    const vec = await createEmbedder().embed('hello');
    expect(vec.length).toBe(4);
    expect(vec[0]).toBeCloseTo(1, 6);
  });

  it('coerces a tensor with no numeric data to an empty vector', async () => {
    pipelineMock.mockResolvedValue(async () => rawTensor(['a', 'b'], [4]));
    const vec = await createEmbedder().embed('hello');
    // flattenNumbers drops non-numbers entirely: nothing survives, so the
    // vector is empty (documented degradation, not a crash).
    expect(vec.length).toBe(0);
  });
});
