/**
 * connection.ts — combined-failure diagnostic when both drivers are unusable.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => ({
  default: () => {
    throw new Error('better native broken');
  },
}));

vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() {
      throw new Error('node sqlite broken');
    }
  },
}));

import { openDatabase } from './connection.js';

describe('openDatabase (both drivers fail)', () => {
  it('throws a combined diagnostic naming both failures', async () => {
    await expect(openDatabase(':memory:')).rejects.toThrow(
      /better-sqlite3 failed: better native broken; node:sqlite failed: node sqlite broken/,
    );
  });
});
