/**
 * Scope URI builder, parser, and matcher.
 *
 * Scope URIs are hierarchical, colon-separated path segments with a canonical
 * grammar of the form:
 *
 *   proj:<project>[/pkg:<package>][/dir:<relativeDir>][/file:<fileName>][/sym:<symbol>]
 *   proj:<project>[/commit:<hash>]
 *
 * Examples (from the system spec):
 *   proj:app/pkg:core/dir:src/file:auth.ts/sym:validateToken
 *   proj:backend/file:src/auth/Token.ts
 *
 * The pair separator is `/` before each kind marker; the kind/value separator
 * is `:`. Values may themselves contain `/` (file paths, nested dirs).
 */

export type ScopeKind = 'proj' | 'pkg' | 'dir' | 'file' | 'sym' | 'commit';

export interface ScopeSegment {
  kind: ScopeKind;
  value: string;
}

export interface ParsedScope {
  raw: string;
  segments: ScopeSegment[];
}

/** All scope kinds, in canonical hierarchy order. */
export const SCOPE_KINDS: readonly ScopeKind[] = ['proj', 'pkg', 'dir', 'file', 'sym', 'commit'];

/** Regex that finds every kind:value pair boundary in a scope string. */
const PAIR_RE = /(?:^|\/)(proj|pkg|dir|file|sym|commit):/g;

function isValidKind(kind: string): kind is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(kind);
}

/**
 * Parse a scope URI into ordered kind/value segments.
 * Throws `TypeError` for malformed input (empty, missing values, unknown kinds).
 */
export function parseScope(raw: string): ParsedScope {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('scope must be a non-empty string');
  }
  PAIR_RE.lastIndex = 0;
  const markers: { kind: ScopeKind; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = PAIR_RE.exec(raw)) !== null) {
    const kindToken = match[1]!;
    if (!isValidKind(kindToken)) {
      throw new TypeError(`unknown scope kind '${kindToken}' in '${raw}'`);
    }
    markers.push({ kind: kindToken, start: match.index, end: match.index + match[0].length });
  }
  if (markers.length === 0) {
    throw new TypeError(`'${raw}' is not a valid scope (no proj/pkg/dir/file/sym/commit segment)`);
  }
  if (markers[0]!.kind !== 'proj' || markers[0]!.start !== 0) {
    throw new TypeError(`scope '${raw}' must start with a proj: segment`);
  }
  const segments: ScopeSegment[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const next = markers[i + 1];
    const valueStart = marker.end;
    // The next marker starts at its leading '/', which is not part of the
    // value; slice up to (excluding) that position.
    const valueEnd = next === undefined ? raw.length : next.start;
    if (valueEnd < valueStart) {
      throw new TypeError(`scope segment '${marker.kind}:<empty>' has no value in '${raw}'`);
    }
    const value = raw.slice(valueStart, valueEnd);
    if (value === '' || value.endsWith('/')) {
      throw new TypeError(`scope segment '${marker.kind}:<empty>' has no value in '${raw}'`);
    }
    // A ':' inside a value would mean a stray kind token (values are
    // slash-separated paths and names, never colon-containing).
    if (value.includes(':')) {
      throw new TypeError(`scope segment '${marker.kind}' contains a stray ':' in '${raw}'`);
    }
    segments.push({ kind: marker.kind, value });
  }
  return { raw, segments };
}

/** Rebuild a canonical scope string from segments. */
export function buildScope(segments: readonly ScopeSegment[]): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.value.length === 0) {
      throw new TypeError(`scope segment ${seg.kind} has an empty value`);
    }
    if (out.length === 0) {
      out.push(`${seg.kind}:${seg.value}`);
    } else {
      out.push(`${seg.kind}:${seg.value}`);
    }
  }
  return out.join('/');
}

/** Construct a scope from ordered pairs of kind/value. */
export function scopeOf(...parts: readonly (readonly [ScopeKind, string])[]): string {
  return buildScope(parts.map(([kind, value]) => ({ kind, value })));
}

/**
 * Match a full scope against a scope prefix.
 *
 * Rules:
 * - Non-`file` pairs must be exact string matches (kind + value).
 * - A `file` prefix pair matches when the target file value equals the prefix
 *   value, or starts with `prefix + "/"` (i.e. directory prefix semantics).
 * - The prefix must not be longer than the target's segment list.
 */
export function scopeMatchesPrefix(target: string | ParsedScope, prefix: string | ParsedScope): boolean {
  const t = typeof target === 'string' ? parseScope(target) : target;
  const p = typeof prefix === 'string' ? parseScope(prefix) : prefix;
  if (p.segments.length > t.segments.length) return false;
  for (let i = 0; i < p.segments.length; i++) {
    const ps = p.segments[i]!;
    const ts = t.segments[i]!;
    if (ps.kind !== ts.kind) return false;
    if (ps.kind === 'file') {
      if (ps.value === ts.value) continue;
      if (ts.value.startsWith(`${ps.value}/`)) continue;
      return false;
    }
    if (ps.value !== ts.value) return false;
  }
  return true;
}

/** True when `scope` is inside any of the given prefixes (OR semantics). */
export function scopeMatchesAnyPrefix(scope: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  const parsed = parseScope(scope);
  for (const prefix of prefixes) {
    if (scopeMatchesPrefix(parsed, prefix)) return true;
  }
  return false;
}

/** Extract the file segment of a parsed scope, if present. */
export function getFileSegment(scope: ParsedScope): ScopeSegment | undefined {
  return scope.segments.find((s) => s.kind === 'file');
}

/** Extract the symbol segment of a parsed scope, if present. */
export function getSymbolSegment(scope: ParsedScope): ScopeSegment | undefined {
  return scope.segments.find((s) => s.kind === 'sym');
}

/** Strip trailing segments from a parsed scope (used to compute parent scopes). */
export function parentScope(scope: string): string | undefined {
  const parsed = parseScope(scope);
  if (parsed.segments.length <= 1) return undefined;
  return buildScope(parsed.segments.slice(0, -1));
}
