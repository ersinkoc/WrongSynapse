import { describe, expect, it } from 'vitest';

import { buildScope, parseScope, scopeMatchesAnyPrefix, scopeMatchesPrefix, scopeOf } from './scope.js';

describe('parseScope', () => {
  it('parses the canonical spec example', () => {
    const parsed = parseScope('proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken');
    expect(parsed.segments.map((s) => [s.kind, s.value])).toEqual([
      ['proj', 'app'],
      ['pkg', 'core'],
      ['dir', 'src'],
      ['file', 'auth.ts'],
      ['sym', 'validateToken'],
    ]);
  });

  it('parses nested directory paths', () => {
    const parsed = parseScope('proj:backend/dir:src/components/file:index.ts');
    expect(parsed.segments.map((s) => [s.kind, s.value])).toEqual([
      ['proj', 'backend'],
      ['dir', 'src/components'],
      ['file', 'index.ts'],
    ]);
  });

  it('parses commit scopes', () => {
    const parsed = parseScope('proj:app/commit:abc123def');
    expect(parsed.segments.map((s) => [s.kind, s.value])).toEqual([
      ['proj', 'app'],
      ['commit', 'abc123def'],
    ]);
  });

  it('parses file-prefix style scopes (no sym segment)', () => {
    const parsed = parseScope('proj:backend/file:src/auth/Token.ts');
    expect(parsed.segments.map((s) => [s.kind, s.value])).toEqual([
      ['proj', 'backend'],
      ['file', 'src/auth/Token.ts'],
    ]);
  });

  it('rejects malformed scopes', () => {
    expect(() => parseScope('')).toThrow();
    expect(() => parseScope('pkg:core')).toThrow(); // must start with proj
    expect(() => parseScope('proj:app/xyz:foo')).toThrow(); // unknown kind
    expect(() => parseScope('proj:')).toThrow(); // empty value
    expect(() => parseScope('garbage')).toThrow(); // no segments
    expect(() => parseScope('proj:app/')).toThrow(); // trailing slash
  });
});

describe('buildScope / scopeOf', () => {
  it('roundtrips through parse', () => {
    const raw = 'proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken';
    expect(buildScope(parseScope(raw).segments)).toBe(raw);
  });

  it('scopeOf builds canonical strings from pairs', () => {
    expect(scopeOf(['proj', 'app'], ['file', 'auth.ts'])).toBe('proj:app/file:auth.ts');
    expect(scopeOf(['proj', 'app'], ['pkg', 'core'], ['dir', 'src'], ['file', 'auth.ts'], ['sym', 'validateToken'])).toBe(
      'proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken',
    );
  });
});

describe('scopeMatchesPrefix', () => {
  it('matches directory-prefix semantics for file values', () => {
    expect(scopeMatchesPrefix('proj:backend/file:src/auth/Token.ts/sym:validate', 'proj:backend/file:src/auth')).toBe(true);
    expect(scopeMatchesPrefix('proj:backend/file:src/auth/Token.ts', 'proj:backend/file:src/auth')).toBe(true);
  });

  it('matches exact scopes', () => {
    expect(scopeMatchesPrefix('proj:app/pkg:core/file:a.ts', 'proj:app/pkg:core/file:a.ts')).toBe(true);
  });

  it('rejects partial-name prefix matches', () => {
    expect(scopeMatchesPrefix('proj:backend/file:src/authx.ts', 'proj:backend/file:src/auth')).toBe(false);
  });

  it('rejects different projects or kinds', () => {
    expect(scopeMatchesPrefix('proj:other/file:a.ts', 'proj:backend')).toBe(false);
    expect(scopeMatchesPrefix('proj:app/file:a.ts', 'proj:app/dir:src')).toBe(false);
  });

  it('scopeMatchesAnyPrefix ORs prefixes and is unbounded when empty', () => {
    expect(scopeMatchesAnyPrefix('proj:app/file:a.ts', ['proj:zzz', 'proj:app'])).toBe(true);
    expect(scopeMatchesAnyPrefix('proj:app/file:a.ts', ['proj:zzz'])).toBe(false);
    expect(scopeMatchesAnyPrefix('proj:app/file:a.ts', [])).toBe(true);
  });
});
