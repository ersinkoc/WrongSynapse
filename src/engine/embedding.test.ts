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
    cacheDir: undefined as string | undefined,
  };
  const pipelineMock = vi.fn();
  return { envMock, pipelineMock };
});

vi.mock('@huggingface/transformers', () => ({
  env: mocks.envMock,
  pipeline: mocks.pipelineMock,
}));

const { envMock, pipelineMock } = mocks;

import { createEmbedder, getSharedEmbedder, resolveRemoteMode, DEFAULT_EMBEDDING_MODEL } from './embedding.js';

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
    envMock.cacheDir = undefined;
    pipelineMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies constructor options to the transformers env', () => {
    createEmbedder({ modelId: 'custom/model', allowRemoteModels: true, localModelDir: '/tmp/models' });
    expect(envMock.allowRemoteModels).toBe(true);
    // localModelPath/cacheDir are resolved to absolute paths by the embedder
    expect(envMock.localModelPath).toBe(resolve('/tmp/models'));
    expect(envMock.cacheDir).toBe(resolve('/tmp/models'));
  });

  it('starts local-only in the default auto mode (no ambient remote fetches)', () => {
    createEmbedder();
    expect(envMock.allowRemoteModels).toBe(false);
  });

  it('stays local-only when strict offline is requested', () => {
    createEmbedder({ noRemoteModels: true });
    expect(envMock.allowRemoteModels).toBe(false);
  });

  it('defaults to the canonical model id', () => {
    expect(createEmbedder().modelId).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(createEmbedder().dimension).toBe(384);
  });

  it('reads env vars when no options are given', () => {
    vi.stubEnv('SYNAPSE_EMBEDDING_MODEL', 'env/model');
    // POSIX absolute: resolves identically through path.resolve on every OS.
    // A Windows drive-letter path ('C:\models') is treated as a relative
    // FILENAME on Linux and gets cwd prepended — that broke CI (run #5).
    vi.stubEnv('SYNAPSE_MODEL_DIR', '/tmp/env-models');
    vi.stubEnv('SYNAPSE_ALLOW_REMOTE_MODEL', '1');
    const embedder = createEmbedder();
    expect(embedder.modelId).toBe('env/model');
    expect(envMock.allowRemoteModels).toBe(true);
    expect(envMock.localModelPath).toBe(resolve('/tmp/env-models'));
    expect(envMock.cacheDir).toBe(resolve('/tmp/env-models'));
  });

  it('defaults the model cache to a per-user directory when no model dir is given', () => {
    // Global installs: transformers.js would otherwise root its download
    // cache (env.cacheDir) and local-model read path (env.localModelPath)
    // inside the global install tree. Both home vars stubbed identically so
    // the test is deterministic on Windows (USERPROFILE) and POSIX (HOME).
    // Ambient SYNAPSE_MODEL_DIR is deleted so the default branch is truly
    // reached even when the dev box exports it.
    vi.stubEnv('SYNAPSE_MODEL_DIR', undefined);
    vi.stubEnv('HOME', '/home/agent');
    vi.stubEnv('USERPROFILE', '/home/agent');
    createEmbedder();
    expect(envMock.localModelPath).toBe(resolve('/home/agent', '.cache', 'wrongsynapse'));
    expect(envMock.cacheDir).toBe(resolve('/home/agent', '.cache', 'wrongsynapse'));
  });

  it('falls back to a local .cache when no home directory is known', () => {
    // vi.stubEnv(key, undefined) deletes the variable.
    vi.stubEnv('SYNAPSE_MODEL_DIR', undefined);
    vi.stubEnv('HOME', undefined);
    vi.stubEnv('USERPROFILE', undefined);
    createEmbedder();
    expect(envMock.localModelPath).toBe(resolve('./.cache'));
    expect(envMock.cacheDir).toBe(resolve('./.cache'));
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

  it('wraps pipeline load failures with a descriptive error (strict offline, single attempt)', async () => {
    pipelineMock.mockRejectedValue(new Error('network offline'));
    const embedder = createEmbedder({ noRemoteModels: true });
    await expect(embedder.init()).rejects.toThrow(
      /Failed to load embedding model.*Strict-offline mode is on.*network offline/s,
    );
    expect(embedder.isReady()).toBe(false);
    // 'never' must not retry: exactly one pipeline attempt.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('downloads the model once on a cache miss in the default auto mode', async () => {
    // First attempt (local-only) misses the cache; the auto retry downloads
    // and succeeds — after which the process returns to local-only.
    pipelineMock.mockRejectedValueOnce(new Error('local file was not found'));
    installPipeline('vector');
    const embedder = createEmbedder();
    await embedder.init();
    expect(embedder.isReady()).toBe(true);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(envMock.allowRemoteModels).toBe(false);
  });

  it('reports a failed auto download (offline) and returns to local-only', async () => {
    pipelineMock.mockRejectedValue(new Error('fetch failed'));
    const embedder = createEmbedder();
    await expect(embedder.init()).rejects.toThrow(
      /automatic one-time model download failed.*fetch failed/s,
    );
    expect(envMock.allowRemoteModels).toBe(false);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry in legacy allow mode (remote was already enabled)', async () => {
    pipelineMock.mockRejectedValue(new Error('connection refused'));
    const embedder = createEmbedder({ allowRemoteModels: true });
    await expect(embedder.init()).rejects.toThrow(/Remote fetching was allowed.*connection refused/s);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('stringifies non-Error pipeline failures (both auto attempts)', async () => {
    pipelineMock.mockRejectedValue('raw string failure');
    const embedder = createEmbedder();
    await expect(embedder.init()).rejects.toThrow(/raw string failure/);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
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
    // Strict offline so a failing load is exactly one attempt (the auto
    // mode would consume the mockRejectedValueOnce on its download retry).
    pipelineMock.mockRejectedValueOnce(new Error('first fail'));
    const embedder = createEmbedder({ noRemoteModels: true });
    await expect(embedder.init()).rejects.toThrow();
    installPipeline('vector');
    await expect(embedder.init()).resolves.toBeUndefined();
    expect(embedder.isReady()).toBe(true);
  });

  it('throws when embedding before a successful init', async () => {
    pipelineMock.mockRejectedValue(new Error('offline'));
    const embedder = createEmbedder({ noRemoteModels: true });
    await expect(embedder.embed('x')).rejects.toThrow();
  });
});

describe('getSharedEmbedder', () => {
  it('returns the same singleton instance', () => {
    expect(getSharedEmbedder()).toBe(getSharedEmbedder());
  });
});

describe('resolveRemoteMode', () => {
  /** Explicit env map so ambient variables never leak into the matrix. */
  const vars = (over: Record<string, string> = {}): Record<string, string | undefined> => ({
    SYNAPSE_ALLOW_REMOTE_MODEL: undefined,
    SYNAPSE_NO_REMOTE_MODEL: undefined,
    ...over,
  });

  it('defaults to auto (local-first, one-time download on a cache miss)', () => {
    expect(resolveRemoteMode({}, vars())).toBe('auto');
  });

  it('treats an explicit allowRemoteModels:false as a deliberate offline opt-out', () => {
    expect(resolveRemoteMode({ allowRemoteModels: true }, vars())).toBe('allow');
    expect(resolveRemoteMode({ allowRemoteModels: false }, vars())).toBe('never');
  });

  it('maps noRemoteModels:true to strict offline', () => {
    expect(resolveRemoteMode({ noRemoteModels: true }, vars())).toBe('never');
  });

  it('maps the environment variables when no options are given', () => {
    expect(resolveRemoteMode({}, vars({ SYNAPSE_ALLOW_REMOTE_MODEL: '1' }))).toBe('allow');
    expect(resolveRemoteMode({}, vars({ SYNAPSE_NO_REMOTE_MODEL: '1' }))).toBe('never');
  });

  it('lets options win over the environment', () => {
    expect(resolveRemoteMode({ noRemoteModels: true }, vars({ SYNAPSE_ALLOW_REMOTE_MODEL: '1' }))).toBe('never');
    expect(resolveRemoteMode({ allowRemoteModels: true }, vars({ SYNAPSE_NO_REMOTE_MODEL: '1' }))).toBe('allow');
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
