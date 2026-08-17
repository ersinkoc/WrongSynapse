/**
 * tryLoadVecExtension failure arm: when the sqlite-vec package cannot be
 * imported/loaded, openDatabase must still succeed on better-sqlite3, mark
 * the extension as unavailable, and SAY so on stderr (the degradation was
 * previously completely silent).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('sqlite-vec', () => {
  throw new Error('sqlite-vec platform binary missing');
});

describe('openDatabase with a broken sqlite-vec install', () => {
  it('degrades to extension-free operation with a diagnostic log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { openDatabase } = await import('./connection.js');
      const db = await openDatabase(':memory:');
      expect(db.backend).toBe('better-sqlite3');
      expect(db.vec.extensionLoaded).toBe(false);
      expect(db.vec.indexReady).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('sqlite-vec extension unavailable'));
      db.close();
    } finally {
      error.mockRestore();
    }
  });
});
