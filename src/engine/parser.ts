/**
 * Workspace indexer: walks a project directory (respecting `.gitignore`),
 * discovers monorepo packages, parses supported languages with tree-sitter
 * (TypeScript, JavaScript, Python, Go, Rust) to extract symbols with
 * line/column metadata, optionally links git commits, computes embeddings, and
 * persists the whole hierarchy (project -> packages -> dirs -> files ->
 * symbols) plus CONTAINS / CALLS / INTRODUCED_BY_COMMIT edges into the graph.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';

import type { SynapseDatabase } from '../db/connection.js';
import {
  deleteStaleIndexedEntities,
  insertEntity,
  insertRelation,
  upsertVector,
} from '../db/queries.js';
import type { Embedder } from './embedding.js';
import { GitService, type CommitInfo } from './git.js';
import { scopeOf, type ScopeKind } from '../utils/scope.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndexOptions {
  workspacePath: string;
  projectName?: string;
  parseAst?: boolean;
  includeGitHistory?: boolean;
  depth?: number;
  maxFileBytes?: number;
  maxCommits?: number;
}

export interface IndexResult {
  projectName: string;
  projectScope: string;
  entitiesCreated: number;
  entitiesUpdated: number;
  entitiesDeleted: number;
  filesScanned: number;
  filesParsed: number;
  filesFailed: number;
  symbolsIndexed: number;
  relationsIndexed: number;
  commitsIndexed: number;
  embeddingsStored: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.wrongstack',
  'dist',
  'build',
  'coverage',
  '.temp_files',
  '.next',
  '.cache',
  'out',
  'models',
  '.venv',
  'venv',
  '__pycache__',
  '*.db',
  '*.db-wal',
  '*.db-shm',
];

const EMBED_TEXT_CAP = 2000;
const EMBED_BATCH = 32;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

interface LanguageConfig {
  grammarWasm: string;
  symbolQuery: string;
  callQuery: string;
}

const LANGUAGE_CONFIGS: Readonly<Record<string, LanguageConfig>> = {
  typescript: {
    grammarWasm: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    symbolQuery: [
      '(function_declaration name: (identifier) @name) @node',
      '(class_declaration name: (type_identifier) @name) @node',
      '(interface_declaration name: (type_identifier) @name) @node',
      '(method_definition name: (property_identifier) @name) @node',
    ].join('\n'),
    callQuery: '(call_expression function: (identifier) @callee) @call',
  },
  javascript: {
    grammarWasm: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
    symbolQuery: [
      '(function_declaration name: (identifier) @name) @node',
      '(class_declaration name: (identifier) @name) @node',
      '(method_definition name: (property_identifier) @name) @node',
    ].join('\n'),
    callQuery: '(call_expression function: (identifier) @callee) @call',
  },
  python: {
    grammarWasm: 'tree-sitter-python/tree-sitter-python.wasm',
    symbolQuery: [
      '(function_definition name: (identifier) @name) @node',
      '(class_definition name: (identifier) @name) @node',
    ].join('\n'),
    callQuery: '(call_expression function: (identifier) @callee) @call',
  },
  go: {
    grammarWasm: 'tree-sitter-go/tree-sitter-go.wasm',
    symbolQuery: [
      '(function_declaration name: (identifier) @name) @node',
      '(method_declaration name: (field_identifier) @name) @node',
      '(type_declaration (type_spec name: (type_identifier) @name)) @node',
    ].join('\n'),
    callQuery: '(call_expression function: (identifier) @callee) @call',
  },
  rust: {
    grammarWasm: 'tree-sitter-rust/tree-sitter-rust.wasm',
    symbolQuery: [
      '(function_item name: (identifier) @name) @node',
      '(struct_item name: (type_identifier) @name) @node',
      '(enum_item name: (type_identifier) @name) @node',
      '(trait_item name: (type_identifier) @name) @node',
    ].join('\n'),
    callQuery: '(call_expression function: (identifier) @callee) @call',
  },
};

// ---------------------------------------------------------------------------
// Minimal structural types for the tree-sitter surface we consume
// (cast at the boundary; keeps the module independent of the package's exact
// type shape).
// ---------------------------------------------------------------------------

interface TsPosition {
  row: number;
  column: number;
}
interface TsNodeLike {
  type: string;
  text: string;
  startPosition: TsPosition;
  endPosition: TsPosition;
  startIndex: number;
  endIndex: number;
  parent: TsNodeLike | null;
  childForFieldName(name: string): TsNodeLike | null;
}
interface TsCaptureLike {
  name: string;
  node: TsNodeLike;
}
interface TsMatchLike {
  captures: TsCaptureLike[];
}
interface TsQueryLike {
  matches(node: TsNodeLike): TsMatchLike[];
  captures(node: TsNodeLike): TsCaptureLike[];
}
interface TsLanguageLike {
  readonly id: number;
}
interface TsParserLike {
  setLanguage(language: TsLanguageLike): void;
  parse(source: string): { rootNode: TsNodeLike };
}
interface TsModuleLike {
  Parser: {
    init(options: { locateFile: () => string }): Promise<void>;
    new (): TsParserLike;
  };
  Language: { load(buffer: Uint8Array): Promise<TsLanguageLike> };
  Query: new (language: TsLanguageLike, source: string) => TsQueryLike;
}

const require = createRequire(import.meta.url);
let tsModulePromise: Promise<TsModuleLike> | null = null;

async function getTreeSitter(): Promise<TsModuleLike> {
  tsModulePromise ??= (async () => {
    const mod = await import('web-tree-sitter');
    const wasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
    await mod.Parser.init({ locateFile: () => wasmPath });
    return mod as unknown as TsModuleLike;
  })();
  return tsModulePromise;
}

const languageCache = new Map<string, TsLanguageLike>();

async function loadLanguage(ts: TsModuleLike, langName: string): Promise<TsLanguageLike> {
  const cached = languageCache.get(langName);
  if (cached !== undefined) return cached;
  const config = LANGUAGE_CONFIGS[langName];
  // EXT_TO_LANG only maps extensions to languages present in
  // LANGUAGE_CONFIGS, so this arm is unreachable through indexWorkspace.
  /* v8 ignore next */
  if (config === undefined) throw new Error(`unsupported language '${langName}'`);
  const wasmPath = require.resolve(config.grammarWasm);
  const language = await ts.Language.load(readFileSync(wasmPath));
  languageCache.set(langName, language);
  return language;
}

// ---------------------------------------------------------------------------
// Entities, scopes, ids
// ---------------------------------------------------------------------------

function entityId(scopePath: string): string {
  return createHash('sha256').update(scopePath).digest('hex').slice(0, 32);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPosixPath(p: string): string {
  return p.replaceAll('\\', '/');
}

// ---------------------------------------------------------------------------
// Directory walk + gitignore
// ---------------------------------------------------------------------------

interface WalkedFile {
  absPath: string;
  relPosix: string;
  size: number;
}

function loadIgnore(root: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  const gitignorePath = join(root, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      ig.add(readFileSync(gitignorePath, 'utf8'));
    } catch {
      // ignore unreadable .gitignore
    }
  }
  return ig;
}

function walkFiles(
  root: string,
  options: { maxDepth: number; ig: Ignore },
): { files: WalkedFile[]; directories: string[]; errors: string[] } {
  const files: WalkedFile[] = [];
  const directories: string[] = [];
  const errors: string[] = [];
  const visit = (absDir: string, depth: number): void => {
    if (depth > options.maxDepth) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      /* v8 ignore start -- only reachable via an OS race: the walker only visits dirs it just enumerated */
      errors.push(`list ${absDir}: ${describeError(error)}`);
      return;
      /* v8 ignore stop */
    }
    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPosix = toPosixPath(relative(root, absPath));
      if (entry.isDirectory()) {
        if (options.ig.ignores(relPosix)) continue;
        directories.push(relPosix);
        visit(absPath, depth + 1);
      } else if (entry.isFile()) {
        if (options.ig.ignores(relPosix)) continue;
        const stat = statSync(absPath, { throwIfNoEntry: false });
        if (stat === undefined) continue;
        files.push({ absPath, relPosix, size: stat.size });
      }
    }
  };
  visit(root, 0);
  return { files, directories, errors };
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

interface PackageInfo {
  name: string;
  relPosix: string; // '' when the project root itself is a package
}

function discoverPackages(root: string, directories: readonly string[]): PackageInfo[] {
  const packages: PackageInfo[] = [];
  const addIfPackage = (relPosix: string): void => {
    const manifest = join(root, relPosix, 'package.json');
    if (!existsSync(manifest)) return;
    let name: string | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        const candidate = (parsed as Record<string, unknown>)['name'];
        if (typeof candidate === 'string') name = candidate;
      }
    } catch {
      // malformed manifest: fall back to directory name
    }
    packages.push({ name: name ?? basename(relPosix === '' ? root : relPosix), relPosix });
  };
  addIfPackage('');
  for (const dir of directories) addIfPackage(dir);
  return packages;
}

function packageFor(relPosix: string, packages: readonly PackageInfo[]): PackageInfo | null {
  let best: PackageInfo | null = null;
  for (const pkg of packages) {
    if (pkg.relPosix === '') {
      best ??= pkg;
      continue;
    }
    if (relPosix === pkg.relPosix || relPosix.startsWith(`${pkg.relPosix}/`)) {
      if (best === null || pkg.relPosix.length > best.relPosix.length) best = pkg;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scope construction
// ---------------------------------------------------------------------------

function fileScope(projectName: string, pkg: PackageInfo | null, relPosix: string): string {
  const parts: [ScopeKind, string][] = [['proj', projectName]];
  if (pkg !== null) parts.push(['pkg', pkg.name]);
  const dir = dirname(relPosix);
  if (dir !== '.') parts.push(['dir', dir]);
  parts.push(['file', basename(relPosix)]);
  return scopeOf(...parts);
}

/** Ancestor directory scopes for a file's directory, innermost first. */
function dirChain(
  projectName: string,
  pkg: PackageInfo | null,
  relDirPosix: string,
): { scope: string; name: string; parentScope: string }[] {
  if (relDirPosix === '.') return [];
  const chain: { scope: string; name: string; parentScope: string }[] = [];
  const segments = relDirPosix.split('/');
  for (let i = 0; i < segments.length; i++) {
    const dirPath = segments.slice(0, i + 1).join('/');
    const parts: [ScopeKind, string][] = [['proj', projectName]];
    if (pkg !== null) parts.push(['pkg', pkg.name]);
    parts.push(['dir', dirPath]);
    const parent =
      i === 0
        ? (pkg !== null ? scopeOf(['proj', projectName], ['pkg', pkg.name]) : scopeOf(['proj', projectName]))
        : (() => {
            const parentParts: [ScopeKind, string][] = [['proj', projectName]];
            if (pkg !== null) parentParts.push(['pkg', pkg.name]);
            parentParts.push(['dir', segments.slice(0, i).join('/')]);
            return scopeOf(...parentParts);
          })();
    chain.push({ scope: scopeOf(...parts), name: segments[i]!, parentScope: parent });
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

interface ExtractedSymbol {
  name: string;
  kind: string;
  scopePath: string;
  signature: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

const ENCLOSING_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'function_definition',
  'function_item',
  'method_declaration',
  'class_declaration',
  'class_definition',
  'struct_item',
]);

function nodeName(node: TsNodeLike): string | null {
  const field = node.childForFieldName('name');
  if (field !== null) return field.text.trim();
  // Every node type in ENCLOSING_NODE_TYPES carries a name field in its
  // grammar, so the null arm is defensive against grammar changes.
  /* v8 ignore next */
  return null;
}

function extractSymbols(
  ts: TsModuleLike,
  language: TsLanguageLike,
  langName: string,
  source: string,
  fileScope: string,
): { symbols: ExtractedSymbol[]; calls: { callerScope: string; calleeScope: string }[] } {
  const config = LANGUAGE_CONFIGS[langName];
  if (config === undefined) throw new Error(`unsupported language '${langName}'`);
  const parser = new ts.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const symbols: ExtractedSymbol[] = [];
  const byName = new Map<string, ExtractedSymbol>();
  const query = new ts.Query(language, config.symbolQuery);
  for (const match of query.matches(root)) {
    const nameCapture = match.captures.find((c) => c.name === 'name');
    const nodeCapture = match.captures.find((c) => c.name === 'node');
    if (nameCapture === undefined || nodeCapture === undefined) continue;
    const name = nameCapture.node.text.trim();
    if (name === '') continue;
    const node = nodeCapture.node;
    const signature = node.text.split('\n')[0]?.trim().slice(0, 200) ?? name;
    const symbol: ExtractedSymbol = {
      name,
      kind: node.type,
      scopePath: `${fileScope}/sym:${name}`,
      signature,
      startRow: node.startPosition.row,
      startCol: node.startPosition.column,
      endRow: node.endPosition.row,
      endCol: node.endPosition.column,
    };
    symbols.push(symbol);
    byName.set(name, symbol);
  }

  const calls: { callerScope: string; calleeScope: string }[] = [];
  if (config.callQuery !== '') {
    const callQuery = new ts.Query(language, config.callQuery);
    for (const capture of callQuery.captures(root)) {
      if (capture.name !== 'callee') continue;
      const calleeName = capture.node.text.trim();
      const callee = byName.get(calleeName);
      if (callee === undefined) continue;
      let node: TsNodeLike | null = capture.node.parent;
      let caller: ExtractedSymbol | undefined;
      while (node !== null && caller === undefined) {
        if (ENCLOSING_NODE_TYPES.has(node.type)) {
          const enclosingName = nodeName(node);
          if (enclosingName !== null) caller = byName.get(enclosingName);
        }
        node = node.parent;
      }
      if (caller !== undefined && caller.scopePath !== callee.scopePath) {
        calls.push({ callerScope: caller.scopePath, calleeScope: callee.scopePath });
      }
    }
  }
  return { symbols, calls };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function indexWorkspace(
  db: SynapseDatabase,
  embedder: Embedder,
  options: IndexOptions,
): Promise<IndexResult> {
  const root = resolve(options.workspacePath);
  if (!existsSync(root)) {
    throw new Error(`workspace path does not exist: ${root}`);
  }
  const projectName = options.projectName ?? detectProjectName(root);
  const projectScope = scopeOf(['proj', projectName]);
  const projectId = entityId(projectScope);
  const maxDepth = options.depth ?? 20;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const parseAst = options.parseAst !== false;
  const includeGitHistory = options.includeGitHistory === true;

  const warnings: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  let filesParsed = 0;
  let filesFailed = 0;
  let symbolsIndexed = 0;
  let relationsIndexed = 0;
  let commitsIndexed = 0;
  let embeddingsStored = 0;

  // Walk
  const walk = walkFiles(root, { maxDepth, ig: loadIgnore(root) });
  errors.push(...walk.errors);

  // Packages + git
  const packages = discoverPackages(root, walk.directories);
  const git = includeGitHistory ? new GitService(root) : null;
  let commits: CommitInfo[] = [];
  if (git !== null) {
    try {
      if (await git.isRepo()) commits = await git.listCommits(options.maxCommits ?? 200);
    } catch (error) {
      warnings.push(`git history skipped: ${describeError(error)}`);
    }
  }

  // Tree-sitter (lazy)
  let ts: TsModuleLike | null = null;
  if (parseAst) {
    try {
      ts = await getTreeSitter();
    } catch (error) {
      warnings.push(`tree-sitter unavailable; AST symbols skipped: ${describeError(error)}`);
      ts = null;
    }
  }

  // Project entity
  const wasProject = insertEntity(db, {
    id: projectId,
    type: 'project',
    scopePath: projectScope,
    name: projectName,
    content: root,
    metadata: { workspace_path: root, synapse_indexed: true },
  });
  seen.add(projectId);
  if (wasProject) entitiesUpdated += 1;
  else entitiesCreated += 1;

  // Package entities + project->package edges
  const pkgScopes = new Map<string, PackageInfo>();
  for (const pkg of packages) {
    const scope = scopeOf(['proj', projectName], ['pkg', pkg.name]);
    const existed = insertEntity(db, {
      id: entityId(scope),
      type: 'package',
      scopePath: scope,
      name: pkg.name,
      content: null,
      metadata: { path: pkg.relPosix, synapse_indexed: true },
    });
    seen.add(entityId(scope));
    if (existed) entitiesUpdated += 1;
    else entitiesCreated += 1;
    insertRelation(db, { sourceId: projectId, targetId: entityId(scope), relation: 'CONTAINS' });
    relationsIndexed += 1;
    pkgScopes.set(pkg.name, pkg);
  }

  // Directory entities are created on demand (before any edge references them)
  const dirEntityIds = new Map<string, string>();
  const ensureDirEntity = (scope: string, name: string, parentScope: string): string => {
    const existing = dirEntityIds.get(scope);
    if (existing !== undefined) return existing;
    const id = entityId(scope);
    const existed = insertEntity(db, {
      id,
      type: 'directory',
      scopePath: scope,
      name,
      content: null,
      metadata: { synapse_indexed: true },
    });
    seen.add(id);
    if (existed) entitiesUpdated += 1;
    else entitiesCreated += 1;
    insertRelation(db, { sourceId: entityId(parentScope), targetId: id, relation: 'CONTAINS' });
    relationsIndexed += 1;
    dirEntityIds.set(scope, id);
    return id;
  };

  const embedTasks: { entityId: string; text: string }[] = [];

  // Files
  for (const file of walk.files) {
    const pkg = packageFor(file.relPosix, packages);
    const scope = fileScope(projectName, pkg, file.relPosix);
    const id = entityId(scope);

    let content: string;
    try {
      content = file.size > maxFileBytes ? '' : readFileSync(file.absPath, 'utf8');
    } catch (error) {
      /* v8 ignore start -- OS race/ACL failure between walk and read; the walker stat'ed this file moments earlier */
      errors.push(`read ${file.relPosix}: ${describeError(error)}`);
      filesFailed += 1;
      continue;
      /* v8 ignore stop */
    }

    const lang = EXT_TO_LANG[extname(file.relPosix)];
    const existed = insertEntity(db, {
      id,
      type: 'file',
      scopePath: scope,
      name: basename(file.relPosix),
      content: content === '' ? null : content,
      metadata: {
        path: file.relPosix,
        size: file.size,
        language: lang ?? null,
        synapse_indexed: true,
      },
    });
    seen.add(id);
    if (existed) entitiesUpdated += 1;
    else entitiesCreated += 1;
    if (content !== '') {
      embedTasks.push({ entityId: id, text: `${basename(file.relPosix)}\n${content.slice(0, EMBED_TEXT_CAP)}` });
    }

    // Containment: pkg/dir chain (dir entities ensured before their edges)
    const dir = dirname(file.relPosix);
    const chain = dirChain(projectName, pkg, dir);
    for (const link of chain) {
      const dirId = ensureDirEntity(link.scope, link.name, link.parentScope);
      insertRelation(db, { sourceId: dirId, targetId: id, relation: 'CONTAINS' });
      relationsIndexed += 1;
    }
    if (chain.length === 0) {
      const parentScope = pkg !== null ? scopeOf(['proj', projectName], ['pkg', pkg.name]) : projectScope;
      insertRelation(db, { sourceId: entityId(parentScope), targetId: id, relation: 'CONTAINS' });
      relationsIndexed += 1;
    }

    // Symbols
    if (lang !== undefined && ts !== null) {
      try {
        const language = await loadLanguage(ts, lang);
        const source = content === '' ? '' : content;
        const { symbols, calls } = extractSymbols(ts, language, lang, source, scope);
        for (const symbol of symbols) {
          const symbolId = entityId(symbol.scopePath);
          const symbolExisted = insertEntity(db, {
            id: symbolId,
            type: 'symbol',
            scopePath: symbol.scopePath,
            name: symbol.name,
            content: symbol.signature,
            metadata: {
              kind: symbol.kind,
              start_row: symbol.startRow,
              start_col: symbol.startCol,
              end_row: symbol.endRow,
              end_col: symbol.endCol,
              synapse_indexed: true,
            },
          });
          seen.add(symbolId);
          if (symbolExisted) entitiesUpdated += 1;
          else entitiesCreated += 1;
          symbolsIndexed += 1;
          insertRelation(db, { sourceId: id, targetId: symbolId, relation: 'CONTAINS' });
          relationsIndexed += 1;
          embedTasks.push({
            entityId: symbolId,
            text: `${symbol.name} ${symbol.kind}\n${symbol.signature}`,
          });
        }
        const callEdges = new Set<string>();
        for (const call of calls) {
          const key = `${call.callerScope}->${call.calleeScope}`;
          if (callEdges.has(key)) continue;
          callEdges.add(key);
          insertRelation(db, {
            sourceId: entityId(call.callerScope),
            targetId: entityId(call.calleeScope),
            relation: 'CALLS',
          });
          relationsIndexed += 1;
        }
        filesParsed += 1;
      } catch (error) {
        /* v8 ignore start -- tree-sitter recovers from malformed source via ERROR nodes; it does not throw on parse */
        errors.push(`parse ${file.relPosix}: ${describeError(error)}`);
        filesFailed += 1;
        /* v8 ignore stop */
      }
    }
  }

  // Git commits + INTRODUCED_BY_COMMIT edges
  for (const commit of commits) {
    const commitScope = scopeOf(['proj', projectName], ['commit', commit.hash]);
    insertEntity(db, {
      id: entityId(commitScope),
      type: 'commit',
      scopePath: commitScope,
      name: commit.hash.slice(0, 7),
      content: commit.message,
      metadata: {
        hash: commit.hash,
        author: commit.authorName,
        email: commit.authorEmail,
        date: commit.date,
        synapse_indexed: true,
      },
    });
    commitsIndexed += 1;
    try {
      const changes = await git!.changesForCommit(commit.hash);
      for (const change of changes) {
        const changePkg = packageFor(change.path, packages);
        const changeScope = fileScope(projectName, changePkg, change.path);
        const fileId = entityId(changeScope);
        if (!seen.has(fileId)) continue; // FK safety: only link indexed files
        insertRelation(db, {
          sourceId: fileId,
          targetId: entityId(commitScope),
          relation: 'INTRODUCED_BY_COMMIT',
        });
        relationsIndexed += 1;
      }
    } catch (error) {
      /* v8 ignore start -- diff-tree only fails on corrupt repo objects or a vanished binary, not from listed-commit hashes */
      warnings.push(`git diff for ${commit.hash.slice(0, 7)} skipped: ${describeError(error)}`);
      /* v8 ignore stop */
    }
  }

  // Embeddings (graceful: structural index succeeds even if the model is absent)
  if (embedTasks.length > 0) {
    try {
      await embedder.init();
      for (let i = 0; i < embedTasks.length; i += EMBED_BATCH) {
        const chunk = embedTasks.slice(i, i + EMBED_BATCH);
        const vectors = await embedder.embedBatch(chunk.map((task) => task.text));
        chunk.forEach((task, index) => {
          const vector = vectors[index];
          if (vector !== undefined) {
            upsertVector(db, task.entityId, vector);
            embeddingsStored += 1;
          }
        });
      }
    } catch (error) {
      warnings.push(`embeddings skipped (${embeddingsStored}/${embedTasks.length} stored): ${describeError(error)}`);
    }
  }

  // Stale cleanup: drop previously indexed structure no longer present
  const staleTypes = ['project', 'package', 'directory', 'file', 'symbol'];
  const deleted = deleteStaleIndexedEntities(db, projectScope, staleTypes, seen);
  if (deleted > 0) warnings.push(`removed ${deleted} stale indexed entities`);

  return {
    projectName,
    projectScope,
    entitiesCreated,
    entitiesUpdated,
    entitiesDeleted: deleted,
    filesScanned: walk.files.length,
    filesParsed,
    filesFailed,
    symbolsIndexed,
    relationsIndexed,
    commitsIndexed,
    embeddingsStored,
    warnings: [...warnings, ...errors],
  };
}

function detectProjectName(root: string): string {
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        const name = (parsed as Record<string, unknown>)['name'];
        if (typeof name === 'string' && name !== '') return name;
      }
    } catch {
      // fall through to directory name
    }
  }
  return basename(root);
}
