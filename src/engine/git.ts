/**
 * Git integration via `simple-git` (native git CLI under the hood): commit
 * listing, per-commit file changes, and line-level blame (best effort).
 */

import { simpleGit, type SimpleGit } from 'simple-git';

export interface CommitInfo {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: string;
  message: string;
}

export interface FileChange {
  status: string; // A/M/D/R/C
  path: string;
}

export interface BlameLine {
  line: number;
  commitHash: string;
}

/** Parse `git diff-tree --name-status` output: "M\tpath" / "R100\told\tnew". */
function parseNameStatus(output: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    // Real `--name-status` output is always "STATUS\tpath" (or three tab
    // fields for renames); the empty-field guards are defensive only.
    /* v8 ignore start */
    const status = parts[0] ?? '';
    const path = parts.length >= 2 ? parts[parts.length - 1]! : '';
    if (status === '' || path === '') continue;
    /* v8 ignore stop */
    changes.push({ status, path });
  }
  return changes;
}

/** Parse `git blame --line-porcelain` output into line -> commit mappings. */
function parseBlamePorcelain(output: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const headerRe = /^([0-9a-f]{7,64})\s+\d+\s+(\d+)\s+\d+/;
  for (const line of output.split('\n')) {
    const match = headerRe.exec(line);
    if (match !== null) {
      const commitHash = match[1]!;
      const finalLine = Number(match[2]);
      // The all-zero boundary hash marks not-yet-committed lines (present in
      // `git blame` output whenever the worktree has unstaged changes).
      if (commitHash !== '0000000000000000000000000000000000000000') {
        lines.push({ line: finalLine, commitHash });
      }
    }
  }
  return lines;
}

export class GitService {
  readonly workspacePath: string;
  private readonly git: SimpleGit;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.git = simpleGit({ baseDir: workspacePath, binary: 'git', maxConcurrentProcesses: 1 });
  }

  /** True when `workspacePath` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    try {
      const out = await this.git.revparse(['--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** List the most recent commits, newest first. */
  async listCommits(maxCount = 200): Promise<CommitInfo[]> {
    const log = await this.git.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      // simple-git always populates author fields; the ?? fallbacks guard
      // against parser changes and cannot be produced by a real repo.
      /* v8 ignore start */
      authorName: entry.author_name ?? '',
      authorEmail: entry.author_email ?? '',
      /* v8 ignore stop */
      date: entry.date,
      message: entry.message,
    }));
  }

  /** Files changed by a commit (including root commits, via diff-tree). */
  async changesForCommit(hash: string): Promise<FileChange[]> {
    // `--root` makes diff-tree show the diff of a root commit (no parent),
    // which otherwise reports no changes for the very first commit.
    const out = await this.git.raw(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', hash]);
    return parseNameStatus(out);
  }

  /** Line-level blame for a repository-relative path. */
  async blameFile(relativePath: string): Promise<BlameLine[]> {
    const out = await this.git.raw(['blame', '--line-porcelain', '--', relativePath]);
    return parseBlamePorcelain(out);
  }
}
