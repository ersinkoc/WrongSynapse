import { describe, expect, it } from 'vitest';

import { bufferToEmbedding, cosineSimilarity, embeddingToBuffer, l2Norm, meanPool, normalizeInPlace } from './vector-math.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3, -4]);
    expect(cosineSimilarity(a, new Float32Array([1, 2, 3, -4]))).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it('returns cos(45°) = 1/sqrt(2) for [1,0]·[1,1]', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 1]))).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity(new Float32Array(3), new Float32Array([1, 2, 3]))).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array(2), new Float32Array(3))).toThrow();
  });
});

describe('normalizeInPlace', () => {
  it('normalizes to unit length', () => {
    const v = normalizeInPlace(new Float32Array([3, 4]));
    expect(l2Norm(v)).toBeCloseTo(1, 6);
  });

  it('is a no-op on zero vectors', () => {
    const v = normalizeInPlace(new Float32Array(4));
    expect(l2Norm(v)).toBe(0);
  });
});

describe('embedding buffer roundtrip', () => {
  it('preserves values exactly', () => {
    const a = new Float32Array([0.1, -0.2, 3.14159, 1e-8]);
    const b = bufferToEmbedding(embeddingToBuffer(a));
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe('meanPool', () => {
  it('averages rows of a flat [seq*dim] hidden state', () => {
    const hidden = new Float32Array([1, 2, 3, 4, 5, 6]); // seq=2, dim=3
    expect(Array.from(meanPool(hidden, 2, 3))).toEqual([2.5, 3.5, 4.5]);
  });

  it('throws on size mismatch', () => {
    expect(() => meanPool(new Float32Array(4), 2, 3)).toThrow();
  });
});
