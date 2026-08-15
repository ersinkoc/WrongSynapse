/**
 * Vector math: L2 normalization and cosine similarity over Float32Array
 * embeddings, plus BLOB serialization helpers for the SQLite vector store.
 */

/** Dimensionality of `Xenova/all-MiniLM-L6-v2` mean-pooled embeddings. */
export const EMBEDDING_DIMENSION = 384;

/** Euclidean (L2) norm of a vector. */
export function l2Norm(vec: Float32Array): number {
  let sum = 0;
  // Indices are loop-bounded, so access is always in bounds (asserted under
  // noUncheckedIndexedAccess instead of branching on a dead `?? 0`).
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

/** Normalize a vector in place (no-op for zero vectors). Returns the vector. */
export function normalizeInPlace(vec: Float32Array): Float32Array {
  const norm = l2Norm(vec);
  if (norm > 0 && norm !== 1) {
    const inv = 1 / norm;
    for (let i = 0; i < vec.length; i++) {
      vec[i] = vec[i]! * inv;
    }
  }
  return vec;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when either vector is zero (undefined direction).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new TypeError(`embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Serialize a Float32Array into a raw little-endian float32 BLOB (byte-exact). */
export function embeddingToBuffer(vec: Float32Array): Buffer {
  // View the underlying bytes (NOT Buffer.from(vec), which treats the typed
  // array as an array-like and truncates each float to one byte).
  return Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength);
}

/** Deserialize a raw float32 BLOB into a Float32Array. */
export function bufferToEmbedding(buf: Uint8Array): Float32Array {
  const bytes = buf.byteLength - (buf.byteLength % 4);
  return new Float32Array(buf.buffer, buf.byteOffset, bytes / 4);
}

/**
 * Mean-pool a flat `[seq_len * dim]` hidden state into a single `[dim]` vector.
 * Used when a model returns per-token states instead of pooled embeddings.
 */
export function meanPool(hidden: Float32Array, seqLen: number, dim: number): Float32Array {
  if (seqLen <= 0 || dim <= 0 || hidden.length !== seqLen * dim) {
    throw new TypeError(`hidden state size mismatch: ${hidden.length} != ${seqLen} * ${dim}`);
  }
  const out = new Float32Array(dim);
  for (let s = 0; s < seqLen; s++) {
    const offset = s * dim;
    for (let d = 0; d < dim; d++) {
      out[d] = out[d]! + hidden[offset + d]!;
    }
  }
  const inv = 1 / seqLen;
  for (let d = 0; d < dim; d++) {
    out[d] = out[d]! * inv;
  }
  return out;
}
