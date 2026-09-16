import simpleGit, { type StatusResult } from 'simple-git'
import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getLoginShellEnv } from './pty-manager'
import type {
  GitBatchOp,
  GitBatchPhase,
  GitBatchProgress,
  GitBatchProgressFn
} from '../shared/git-batch'
import {
  STATUS_BATCH_CONCURRENCY,
  FETCH_BATCH_CONCURRENCY,
  PULL_BATCH_CONCURRENCY,
  GIT_NETWORK_TIMEOUT_MS
} from './constants'
import type { GitRangeDirection } from '../shared/git-range'

/**
 * The branch a worktree was cut from, read off its own reflog. `git worktree
 * add -b lane origin/dev` and `git checkout -b lane dev` both open the
 * branch's reflog with `branch: Created from <ref>`; that oldest entry is the
 * LAST line of `git reflog show`. `Created from HEAD` names nothing (a branch
 * cut from a detached position), so it reads as no base and the caller falls
 * through to its next source.
 */
export function parseCreatedFrom(reflog: string): string | null {
  const lines = reflog.trim().split('\n').filter(Boolean)
  const oldest = (lines[lines.length - 1] ?? '').trim()
  const match = /^branch: Created from (.+)$/.exec(oldest)
  if (!match) return null
  const from = match[1].trim()
  return from === 'HEAD' || from === '' ? null : from
}

/**
 * The commit a branch was created AT, from the same oldest reflog entry when
 * it is a creation, given as `<sha>\t<subject>` lines (`%H%x09%gs`). It is
 * what tells a worktree that has done nothing yet (its head still that
 * commit) from one whose commits the base took with a merge commit (its head
 * moved on, yet nothing of it is outside the base). Null when the reflog
 * opens with anything else.
 */
export function parseCreatedAt(reflog: string): string | null {
  const lines = reflog.trim().split('\n').filter(Boolean)
  const oldest = (lines[lines.length - 1] ?? '').trim()
  const match = /^([0-9a-f]{7,40})\tbranch: Created from /.exec(oldest)
  return match ? match[1] : null
}

/**
 * The branch's creation, sha and moment, from the same oldest entry given as
 * `<sha>\t<branch>@{<unix seconds>}\t<subject>` lines (`%H%x09%gd%x09%gs`
 * under `--date=unix`): the moment orders a repo's worktrees (PRDCT-2360),
 * the sha tells a fresh worktree from a merged one. The moment is the ENTRY's
 * (`%gd`), not the commit's (`%ct`, which on a creation is the date of the
 * commit the branch was cut at, the same for every branch cut there). Null
 * when the reflog opens with anything but a creation.
 */
export function parseCreation(reflog: string): { sha: string; at: number } | null {
  const lines = reflog.trim().split('\n').filter(Boolean)
  const oldest = (lines[lines.length - 1] ?? '').trim()
  const match = /^([0-9a-f]{7,40})\t[^\t]*@\{(\d+)\}\tbranch: Created from /.exec(oldest)
  return match ? { sha: match[1], at: parseInt(match[2], 10) * 1000 } : null
}

/**
 * A git instance for a call that talks to a REMOTE, and can therefore hang
 * forever on someone else's server.
 *
 * `timeout.block` is an IDLE timer, not a deadline: any byte on stdout or
 * stderr resets it, so a slow-but-progressing fetch of a large repo is left
 * alone and only a genuinely stalled connection is killed. `GIT_TERMINAL_PROMPT=0`
 * covers the other half — a remote that wants credentials would otherwise sit
 * waiting on a stdin no one is attached to, producing no output at all, which
 * is a hang the user can neither see nor answer.
 */
function networkGit(cwd: string): ReturnType<typeof simpleGit> {
  return simpleGit(cwd, { timeout: { block: GIT_NETWORK_TIMEOUT_MS } }).env({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0'
  })
}

/** Past this many base commits since the merge-base, the squash reading is not attempted. */
const SQUASH_SCAN_LIMIT = 500

/**
 * `git patch-id --stable` over the output of another git command in `cwd`:
 * one `{ id, commit }` per patch, in the order the input listed them (`git
 * log -p` newest first; a plain `git diff` yields one entry with an all-zero
 * commit). An empty diff yields none. Two processes, the diff piped into
 * the hasher, nothing written anywhere.
 */
function patchIds(cwd: string, diffArgs: string[]): Promise<Array<{ id: string; commit: string }>> {
  return new Promise((resolve, reject) => {
    const producer = spawn('git', diffArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const hasher = spawn('git', ['patch-id', '--stable'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    producer.stdout.pipe(hasher.stdin)
    let out = ''
    let err = ''
    hasher.stdout.on('data', (d: Buffer) => (out += d.toString()))
    hasher.stderr.on('data', (d: Buffer) => (err += d.toString()))
    producer.on('error', reject)
    hasher.on('error', reject)
    hasher.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git patch-id exited ${code}: ${err.trim()}`))
      resolve(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [id, commit = ''] = l.split(/\s+/)
            return { id, commit }
          })
      )
    })
  })
}

/** Run an async op over items with a bounded number of concurrent workers. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export interface GitFileStatus {
  path: string
  status:
    | 'staged'
    | 'modified'
    | 'deleted'
    | 'untracked'
    | 'staged-modified'
    | 'staged-deleted'
    | 'renamed'
  staged: boolean
}

/**
 * The worktree reading of a checkout (PRDCT-2356): present only on a linked
 * worktree, absent on a repo that is its own checkout.
 */
export interface GitWorktreeInfo {
  /** Absolute path of the main checkout this worktree belongs to. */
  of: string
  /**
   * The ref the worktree's branch was cut from (`origin/dev`, `dev`), or null
   * when it cannot be named — the row then carries no base badge.
   */
  base: string | null
  /** `base` as the badge shows it: the remote prefix dropped (`dev`). */
  baseLabel: string
  /** Commits the worktree has that the base does not — the `+N` badge. */
  ahead: number
  /** Commits the base gained that the worktree lacks — the `−N` on the base badge. */
  behind: number
  /**
   * The worktree's work is already in the base: its head is an ancestor of
   * the base (a merge or a fast-forward), or the base carries its whole net
   * diff as one commit (a squash-merge, how a lane lands). The dot on the
   * row says so. False when the base cannot be named.
   */
  merged: boolean
  /**
   * When the worktree's branch was created (its reflog's creation entry), in
   * epoch milliseconds; a detached checkout takes its directory's birth time.
   * Null when neither is known. Orders a repo's worktrees (PRDCT-2360).
   */
  createdAt: number | null
  /** The head commit's moment and subject, for the dot's popover. */
  lastCommit: { at: number; subject: string } | null
}

export interface GitStatusResult {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  files: GitFileStatus[]
  repoRoot: string
  worktree?: GitWorktreeInfo
}

export interface GitCommitResult {
  hash: string
  branch: string
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs: string[]
}

export interface GitCommitFileStatus {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  insertions: number
  deletions: number
}

export interface GitPushGroup {
  id: string
  pushedAt: string
  commits: GitLogEntry[]
  summary?: {
    title: string
    description: string
  }
}

export interface GitJourneyResult {
  local: GitLogEntry[]
  pushGroups: GitPushGroup[]
  fallbackMode: boolean
  branch: string
  hasMore: boolean
}


/**
 * The counter behind a batch. Every repo moves it exactly once, at the end of
 * its own pipeline, whatever happened to it — a batch where failures never
 * counted would stall the bar short of full and read as a hang, which is the
 * bug this whole change exists to remove.
 */
class BatchProgress {
  private done = 0

  constructor(
    private readonly op: GitBatchOp,
    private readonly total: number,
    private readonly emit?: GitBatchProgressFn
  ) {}

  /** A repo entered a phase. The counter does not move. */
  step(repoPath: string, phase: GitBatchPhase): void {
    this.send(repoPath, phase)
  }

  /** A repo's pipeline ended. The counter moves, once. */
  complete(repoPath: string, phase: GitBatchPhase): void {
    this.done++
    this.send(repoPath, phase)
  }

  private send(repoPath: string, phase: GitBatchPhase): void {
    this.emit?.({
      op: this.op,
      phase,
      repoPath,
      repoName: path.basename(repoPath) || repoPath,
      done: this.done,
      total: this.total
    })
  }
}

export type { GitBatchOp, GitBatchPhase, GitBatchProgress, GitBatchProgressFn }

export interface MagicSyncResult {
  repoPath: string
  actions: string[]
  error: string | null
}

export interface MagicPullResult {
  repoPath: string
  pulled: boolean
  error: string | null
}

/** Format object for simple-git log calls */
const GIT_LOG_FORMAT = {
  hash: '%H',
  shortHash: '%h',
  message: '%s',
  author: '%an',
  date: '%aI',
  refs: '%D'
}

/** Parse raw log entries from simple-git into GitLogEntry[] */
function parseLogEntries(
  entries: ReadonlyArray<{ hash: string; shortHash: string; message: string; author: string; date: string; refs: string }>
): GitLogEntry[] {
  return entries.map((entry) => ({
    hash: entry.hash,
    shortHash: entry.shortHash,
    message: entry.message,
    author: entry.author,
    date: entry.date,
    refs: entry.refs ? entry.refs.split(', ').filter(Boolean) : []
  }))
}

function mapFiles(status: StatusResult): GitFileStatus[] {
  const files: GitFileStatus[] = []

  for (const file of status.files) {
    const index = file.index
    const working = file.working_dir

    // Staged changes
    if (index === 'A') {
      files.push({ path: file.path, status: 'staged', staged: true })
    } else if (index === 'M') {
      if (working === 'M') {
        files.push({ path: file.path, status: 'staged-modified', staged: true })
      } else {
        files.push({ path: file.path, status: 'staged', staged: true })
      }
    } else if (index === 'D') {
      files.push({ path: file.path, status: 'staged-deleted', staged: true })
    } else if (index === 'R') {
      files.push({ path: file.path, status: 'renamed', staged: true })
    }

    // Unstaged changes (only if not already covered by staged)
    if (index === ' ' || index === '?') {
      if (working === 'M') {
        files.push({ path: file.path, status: 'modified', staged: false })
      } else if (working === 'D') {
        files.push({ path: file.path, status: 'deleted', staged: false })
      } else if (working === '?') {
        files.push({ path: file.path, status: 'untracked', staged: false })
      }
    }

    // Unstaged modification on top of staged change
    if ((index === 'A' || index === 'R') && working === 'M') {
      files.push({ path: file.path, status: 'modified', staged: false })
    }
  }

  return files
}

class GitManager {
  /** Git status for many repos at once, with bounded concurrency. */
  async getStatusBatch(
    paths: string[]
  ): Promise<Array<{ path: string; status: GitStatusResult }>> {
    return mapWithConcurrency(paths, STATUS_BATCH_CONCURRENCY, async (p) => ({
      path: p,
      status: await this.getStatus(p)
    }))
  }

  /** Git fetch for many repos at once, with bounded concurrency. */
  async fetchBatch(paths: string[]): Promise<void> {
    await mapWithConcurrency(paths, FETCH_BATCH_CONCURRENCY, (p) => this.fetch(p))
  }

  async getDiff(
    cwd: string,
    filePath: string,
    staged: boolean,
    isUntracked: boolean
  ): Promise<string> {
    if (isUntracked) {
      const fullPath = path.join(cwd, filePath)
      return await fs.promises.readFile(fullPath, 'utf-8')
    }
    const git = simpleGit(cwd)
    if (staged) {
      return await git.diff(['--cached', '--', filePath])
    }
    return await git.diff(['--', filePath])
  }

  async stage(cwd: string, files: string[]): Promise<void> {
    const git = simpleGit(cwd)
    await git.add(files)
  }

  async unstage(cwd: string, files: string[]): Promise<void> {
    const git = simpleGit(cwd)
    await git.raw(['reset', 'HEAD', '--', ...files])
  }

  async commit(cwd: string, message: string): Promise<GitCommitResult> {
    const git = simpleGit(cwd)
    const result = await git.commit(message)
    return { hash: result.commit, branch: result.branch }
  }

  async push(cwd: string): Promise<void> {
    const git = networkGit(cwd)
    await git.push()
  }

  async publishBranch(cwd: string): Promise<void> {
    const git = networkGit(cwd)
    const status = await git.status()
    const branch = status.current
    if (!branch) throw new Error('Could not determine current branch')
    await git.push(['-u', 'origin', branch])
  }

  async pull(cwd: string, strategy: 'auto' | 'merge' | 'rebase' | 'ff-only' = 'auto'): Promise<void> {
    const git = networkGit(cwd)

    if (strategy === 'ff-only') {
      await git.pull(['--ff-only'])
      return
    }

    if (strategy === 'merge') {
      await git.pull(['--no-rebase', '--autostash'])
      return
    }

    if (strategy === 'rebase') {
      try {
        await git.pull(['--rebase', '--autostash'])
      } catch (err) {
        try { await git.rebase(['--abort']) } catch { /* expected: abort may fail if rebase didn't start */ }
        throw err
      }
      return
    }

    // strategy === 'auto': try ff-only, then fall back to rebase
    try {
      await git.pull(['--ff-only'])
    } catch {
      try {
        await git.pull(['--rebase', '--autostash'])
      } catch (err) {
        try { await git.rebase(['--abort']) } catch { /* abort may fail if rebase didn't start */ }
        throw err
      }
    }
  }

  async discard(
    cwd: string,
    files: Array<{ path: string; status: string; staged: boolean }>
  ): Promise<void> {
    const git = simpleGit(cwd)

    const stagedTracked: string[] = []
    const trackedOnly: string[] = []
    const untrackedPaths: string[] = []

    for (const f of files) {
      if (f.status === 'untracked') {
        untrackedPaths.push(f.path)
      } else if (f.staged) {
        stagedTracked.push(f.path)
      } else {
        trackedOnly.push(f.path)
      }
    }

    // Unstage staged files first, then revert
    if (stagedTracked.length > 0) {
      await git.raw(['reset', 'HEAD', '--', ...stagedTracked])
      await git.raw(['checkout', '--', ...stagedTracked])
    }

    // Revert unstaged tracked files
    if (trackedOnly.length > 0) {
      await git.raw(['checkout', '--', ...trackedOnly])
    }

    // Delete untracked files from filesystem
    for (const filePath of untrackedPaths) {
      await fs.promises.unlink(path.join(cwd, filePath)).catch((err) => {
        console.warn('[git] Failed to delete untracked file:', filePath, err.message)
      })
    }
  }

  /** The lenient fetch: the background poller's, which must never surface a
   *  transient network failure as an error the user has to dismiss. */
  async fetch(cwd: string): Promise<void> {
    try {
      await this.fetchOrThrow(cwd)
    } catch (err) {
      console.warn('[git] Fetch skipped:', (err as Error).message)
    }
  }

  /** The same fetch, reporting. A batch the user CLICKED has to be able to say
   *  that a remote failed — swallowed into a warning, a failed fetch made the
   *  repo report "up to date", which is the one answer that is certainly wrong. */
  async fetchOrThrow(cwd: string): Promise<void> {
    await networkGit(cwd).fetch()
  }

  async checkIgnored(cwd: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return []
    try {
      const git = simpleGit(cwd)
      const isRepo = await git.checkIsRepo()
      if (!isRepo) return []
      // git check-ignore returns the paths that ARE ignored (exit code 1 = none ignored)
      // --no-index: check purely against .gitignore rules, ignoring tracked gitlinks
      // (nested git repos tracked in the index are otherwise silently skipped)
      const result = await git.raw(['check-ignore', '--no-index', ...paths]).catch(() => '')
      if (!result.trim()) return []
      return result.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  async getLog(
    cwd: string,
    maxCount: number = 100
  ): Promise<GitLogEntry[]> {
    try {
      const git = simpleGit(cwd)
      const result = await git.log({ maxCount, format: GIT_LOG_FORMAT })
      return parseLogEntries(result.all)
    } catch (err) {
      console.warn('[git] getLog failed:', (err as Error).message)
      return []
    }
  }

  async getOutgoingCommits(cwd: string): Promise<GitLogEntry[]> {
    try {
      const git = simpleGit(cwd)
      const branch = (await git.status()).current
      if (!branch) return []
      const result = await git.log({
        from: `origin/${branch}`,
        to: 'HEAD',
        format: GIT_LOG_FORMAT
      })
      return parseLogEntries(result.all)
    } catch {
      // Expected: no remote tracking branch
      return []
    }
  }

  async getIncomingCommits(cwd: string): Promise<GitLogEntry[]> {
    try {
      const git = simpleGit(cwd)
      const branch = (await git.status()).current
      if (!branch) return []
      const result = await git.log({
        from: 'HEAD',
        to: `origin/${branch}`,
        format: GIT_LOG_FORMAT
      })
      return parseLogEntries(result.all)
    } catch {
      // Expected: no remote tracking branch
      return []
    }
  }

  /**
   * Aggregate file list of a sync range (PRDCT-1539 / PRDCT-1679):
   * incoming = what a pull will bring (`HEAD...origin/<branch>`, merge-base →
   * remote), outgoing = what a push will send (`origin/<branch>...HEAD`).
   * Fails soft (empty list) when there is no branch or no remote ref, like
   * getIncomingCommits.
   */
  async getRangeFiles(cwd: string, direction: GitRangeDirection): Promise<GitCommitFileStatus[]> {
    try {
      const git = simpleGit(cwd)
      const spec = await this.rangeSpec(git, direction)
      if (!spec) return []
      const numRaw = await git.raw(['diff', '--numstat', '--diff-filter=AMDRTC', spec])
      const nameRaw = await git.raw(['diff', '--name-status', '--diff-filter=AMDRTC', spec])

      const numLines = numRaw.trim().split('\n').filter(Boolean)
      const nameLines = nameRaw.trim().split('\n').filter(Boolean)

      const files: GitCommitFileStatus[] = []
      for (let i = 0; i < nameLines.length; i++) {
        const nameParts = nameLines[i].split('\t')
        const statusChar = nameParts[0].charAt(0) as GitCommitFileStatus['status']
        const filePath = nameParts[nameParts.length - 1]

        let insertions = 0
        let deletions = 0
        if (numLines[i]) {
          const numParts = numLines[i].split('\t')
          insertions = numParts[0] === '-' ? 0 : parseInt(numParts[0], 10) || 0
          deletions = numParts[1] === '-' ? 0 : parseInt(numParts[1], 10) || 0
        }

        files.push({ path: filePath, status: statusChar, insertions, deletions })
      }
      return files
    } catch {
      // Expected: no remote tracking branch
      return []
    }
  }

  /** Aggregate per-file diff of a sync range — the net effect, not per-commit. */
  async getRangeDiff(cwd: string, direction: GitRangeDirection, filePath: string): Promise<string> {
    try {
      const git = simpleGit(cwd)
      const spec = await this.rangeSpec(git, direction)
      if (!spec) return ''
      return await git.raw(['diff', spec, '--', filePath])
    } catch (err) {
      console.warn('[git] getRangeDiff failed:', direction, filePath, (err as Error).message)
      return ''
    }
  }

  /**
   * The three-dot spec of a range, or null when there is nothing to compare
   * against (no branch, no remote counterpart, no nameable base). The remote
   * ranges use the REAL tracking ref, not a guessed origin/<branch>: a branch
   * can track a differently-named upstream, and the ahead/behind badges come
   * from that tracking info — the range must agree with them. The worktree
   * ranges use the same base the status read, so the badge and its list agree
   * the same way.
   */
  private async rangeSpec(
    git: ReturnType<typeof simpleGit>,
    direction: GitRangeDirection
  ): Promise<string | null> {
    const status = await git.status()
    if (direction === 'incoming' || direction === 'outgoing') {
      const tracking = status.tracking
      if (!tracking) return null
      return direction === 'incoming' ? `HEAD...${tracking}` : `${tracking}...HEAD`
    }
    if (!status.current || status.current === 'HEAD') return null
    const base = await this.resolveWorktreeBase(git, status.current)
    if (!base) return null
    return direction === 'worktree' ? `${base}...HEAD` : `HEAD...${base}`
  }

  /**
   * The worktree reading of a checkout (PRDCT-2356): which main checkout it
   * belongs to, which branch it was cut from, and the two-sided count against
   * that base. `undefined` for a repo that is its own checkout — one
   * `rev-parse` is the whole cost there. A worktree whose base cannot be named
   * still reports where it belongs (so the panel places it under its source)
   * with `base: null`, and its row carries no base badge and no count: never
   * a base guessed from the folder name.
   */
  private async readWorktree(
    git: ReturnType<typeof simpleGit>,
    cwd: string,
    branch: string
  ): Promise<GitWorktreeInfo | undefined> {
    try {
      const dirs = (await git.raw(['rev-parse', '--git-dir', '--git-common-dir']))
        .trim()
        .split('\n')
        .map((d) => d.trim())
      if (dirs.length < 2) return undefined
      const gitDir = path.resolve(cwd, dirs[0])
      const commonDir = path.resolve(cwd, dirs[1])
      if (gitDir === commonDir) return undefined
      const of = path.dirname(commonDir)
      const onBranch = !!branch && branch !== 'HEAD'
      // The branch's creation entry: its moment orders the worktrees, its
      // sha serves the merged reading. A detached checkout has no branch;
      // its directory's birth time stands in for the moment.
      let creation: { sha: string; at: number } | null = null
      if (onBranch) {
        try {
          creation = parseCreation(
            await git.raw(['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', branch])
          )
        } catch {
          creation = null
        }
      }
      let createdAt: number | null = creation?.at ?? null
      if (createdAt === null) {
        try {
          createdAt = Math.round((await fs.promises.stat(cwd)).birthtimeMs) || null
        } catch {
          createdAt = null
        }
      }
      let lastCommit: GitWorktreeInfo['lastCommit'] = null
      try {
        const [at, ...subject] = (await git.raw(['log', '-1', '--format=%ct%x09%s'])).trim().split('\t')
        const seconds = parseInt(at, 10)
        if (seconds) lastCommit = { at: seconds * 1000, subject: subject.join('\t') }
      } catch {
        lastCommit = null
      }
      // A detached checkout was cut from nothing: no branch, no reflog to
      // name a base, and the default-branch fallback would only pin it to
      // whatever the remote's HEAD is. It hangs under its source and says
      // no more.
      const base = onBranch ? await this.resolveWorktreeBase(git, branch) : null
      if (!base) {
        return { of, base: null, baseLabel: '', ahead: 0, behind: 0, merged: false, createdAt, lastCommit }
      }
      const counts = (await git.raw(['rev-list', '--left-right', '--count', `${base}...HEAD`]))
        .trim()
        .split(/\s+/)
      const behind = parseInt(counts[0] ?? '', 10) || 0
      const ahead = parseInt(counts[1] ?? '', 10) || 0
      const merged = await this.isMergedInto(git, cwd, base, creation?.sha ?? null, ahead, behind)
      return {
        of,
        base,
        baseLabel: await this.shortRefLabel(git, base),
        ahead,
        behind,
        merged,
        createdAt,
        lastCommit
      }
    } catch {
      return undefined
    }
  }

  /**
   * Whether the checkout's work is in `base`. Two ways it can be, and both are
   * local and cheap:
   *
   * - nothing of the head is outside the base (`ahead` is 0): a merge commit
   *   or a fast-forward took the commits themselves. A worktree that has done
   *   NOTHING yet reads the same way, so this counts only when the head has
   *   moved on from the commit the branch was created at (its reflog says
   *   which); a branch with no reflog is never claimed merged this way.
   * - the base carries the branch's whole net diff as ONE commit, which is
   *   what a squash-merge leaves: none of the commits is in the base, so the
   *   count says ahead. The branch's net diff since the merge-base is hashed
   *   with `git patch-id`, forward AND reversed, and the base's commits since
   *   the merge-base are hashed the same way; the NEWEST of the base's
   *   commits carrying either id decides: the forward patch means the squash
   *   landed, the reverse one means it was reverted since, and a revert
   *   after a squash reads as not merged (review of PR #55, finding 17).
   *   Nothing is written to the object store: the earlier reading squashed
   *   the branch into a throwaway commit per status read, one unreachable
   *   object every poll (finding 21). The scan is bounded: a worktree more
   *   than SQUASH_SCAN_LIMIT commits behind its base is not claimed merged
   *   by this arm, rather than diffing hundreds of commits every five seconds.
   */
  private async isMergedInto(
    git: ReturnType<typeof simpleGit>,
    cwd: string,
    base: string,
    createdAtSha: string | null,
    ahead: number,
    behind: number
  ): Promise<boolean> {
    try {
      if (ahead === 0) {
        if (!createdAtSha) return false
        const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
        return head !== createdAtSha
      }
      if (behind === 0 || behind > SQUASH_SCAN_LIMIT) return false
      const mergeBase = (await git.raw(['merge-base', base, 'HEAD'])).trim()
      if (!mergeBase) return false
      const [forward] = await patchIds(cwd, ['diff', mergeBase, 'HEAD'])
      const [reverse] = await patchIds(cwd, ['diff', 'HEAD', mergeBase])
      if (!forward || !reverse) return false
      // Newest first, as `git log` lists them.
      const history = await patchIds(cwd, ['log', '-p', '--no-merges', `${mergeBase}..${base}`])
      const newest = history.find((h) => h.id === forward.id || h.id === reverse.id)
      return !!newest && newest.id === forward.id
    } catch {
      return false
    }
  }

  /**
   * The ref a branch was cut from, in this order: the branch's own reflog
   * (`branch: Created from <ref>`), an upstream of a DIFFERENT name (a branch
   * tracking itself says nothing about where it came from), the remote's
   * default branch. Whatever names it must still resolve to a commit — a
   * reflog naming a ref that was since deleted is no base. Never the folder
   * name.
   */
  async resolveWorktreeBase(
    git: ReturnType<typeof simpleGit>,
    branch: string
  ): Promise<string | null> {
    let candidate: string | null = null
    try {
      candidate = parseCreatedFrom(await git.raw(['reflog', 'show', '--format=%gs', branch]))
    } catch {
      candidate = null
    }
    if (!candidate) {
      try {
        const merge = (await git.raw(['config', '--get', `branch.${branch}.merge`])).trim()
        const name = merge.replace(/^refs\/heads\//, '')
        if (name && name !== branch) {
          let remote = ''
          try {
            remote = (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim()
          } catch {
            remote = ''
          }
          candidate = remote && remote !== '.' ? `${remote}/${name}` : name
        }
      } catch {
        candidate = null
      }
    }
    if (!candidate) {
      try {
        const head = (await git.raw(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim()
        if (head && head !== `origin/${branch}`) candidate = head
      } catch {
        candidate = null
      }
    }
    if (!candidate || candidate === branch) return null
    // `--verify --quiet` on a ref that is gone exits 1 with NOTHING on either
    // stream, which simple-git resolves rather than throws (review of PR #55,
    // finding 16): the answer is the output, empty when the ref is no more.
    try {
      const sha = (await git.raw(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])).trim()
      if (!sha) return null
    } catch {
      return null
    }
    return candidate
  }

  /** `origin/dev` → `dev` when `origin` is one of the repo's remotes; a local ref stays as it is. */
  private async shortRefLabel(git: ReturnType<typeof simpleGit>, ref: string): Promise<string> {
    const bare = ref.replace(/^refs\/remotes\//, '')
    const slash = bare.indexOf('/')
    if (slash <= 0) return bare
    try {
      const remotes = (await git.raw(['remote'])).split('\n').map((r) => r.trim())
      return remotes.includes(bare.slice(0, slash)) ? bare.slice(slash + 1) : bare
    } catch {
      return bare
    }
  }

  async getCommitFiles(cwd: string, hash: string): Promise<GitCommitFileStatus[]> {
    try {
      const git = simpleGit(cwd)
      const raw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--numstat', '--diff-filter=AMDRTC', hash])
      const nameRaw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', '--diff-filter=AMDRTC', hash])

      const numLines = raw.trim().split('\n').filter(Boolean)
      const nameLines = nameRaw.trim().split('\n').filter(Boolean)

      const files: GitCommitFileStatus[] = []
      for (let i = 0; i < nameLines.length; i++) {
        const nameParts = nameLines[i].split('\t')
        const statusChar = nameParts[0].charAt(0) as GitCommitFileStatus['status']
        const filePath = nameParts[nameParts.length - 1]

        let insertions = 0
        let deletions = 0
        if (numLines[i]) {
          const numParts = numLines[i].split('\t')
          insertions = numParts[0] === '-' ? 0 : parseInt(numParts[0], 10) || 0
          deletions = numParts[1] === '-' ? 0 : parseInt(numParts[1], 10) || 0
        }

        files.push({ path: filePath, status: statusChar, insertions, deletions })
      }
      return files
    } catch (err) {
      console.warn('[git] getCommitFiles failed:', hash, (err as Error).message)
      return []
    }
  }

  async getCommitDiff(cwd: string, hash: string, filePath: string): Promise<string> {
    try {
      const git = simpleGit(cwd)
      return await git.raw(['diff', `${hash}~1`, hash, '--', filePath])
    } catch {
      // Expected for initial commits (no parent) — fall back to show
      try {
        const git = simpleGit(cwd)
        return await git.raw(['show', `${hash}:${filePath}`])
      } catch (err) {
        console.warn('[git] getCommitDiff failed:', hash, filePath, (err as Error).message)
        return ''
      }
    }
  }

  async generateCommitMessage(cwd: string): Promise<string> {
    console.log('[git] generateCommitMessage called for:', cwd)
    const git = simpleGit(cwd)

    // Get staged diff (what will actually be committed)
    const diff = await git.diff(['--cached', '--stat']).then(async (stat) => {
      if (!stat.trim()) throw new Error('No staged changes — stage files first')
      const fullDiff = await git.diff(['--cached'])
      console.log('[git] Staged diff length:', fullDiff.length)
      // Truncate to ~12k chars to stay within reasonable prompt size
      return fullDiff.length > 12000 ? fullDiff.slice(0, 12000) + '\n... (diff truncated)' : fullDiff
    })

    // Get recent commit messages for style context
    const recentMessages = await this.getLog(cwd, 5).then((entries) =>
      entries.map((e) => e.message).join('\n')
    )

    const prompt = `Write a git commit message for the staged diff below.

Rules:
- First line: conventional commit prefix (feat/fix/refactor/chore/docs/style/perf/test) + concise summary, max 72 chars
- If the change is non-trivial, add a blank line then a body (1-3 bullet points) explaining WHAT was done and WHY — not which files were touched
- Maximize information density: an agent reading git log should understand the intent and scope without reading the diff
- No quotes around the message, no markdown formatting, no trailing explanation
- Match the tone and style of recent commits if provided

${recentMessages ? `Recent commits for style reference:\n${recentMessages}\n\n` : ''}Staged diff:
${diff}`

    const env = { ...getLoginShellEnv() }
    // Remove CLAUDECODE to avoid "nested session" detection
    delete env.CLAUDECODE

    console.log('[git] Spawning claude CLI for commit message generation...')
    return runClaudePrompt(prompt, env, '[git]')
  }

  /**
   * Commit and push every repo that has work in it. Serial on purpose: step 3
   * spawns the `claude` CLI to write the message, and N of those at once is a
   * different kind of expensive from N `git fetch`es.
   */
  async magicSync(
    repoPaths: string[],
    onProgress?: GitBatchProgressFn
  ): Promise<MagicSyncResult[]> {
    const progress = new BatchProgress('sync', repoPaths.length, onProgress)
    const results: MagicSyncResult[] = []

    const syncRepo = async (repoPath: string): Promise<MagicSyncResult> => {
      const result: MagicSyncResult = { repoPath, actions: [], error: null }
      try {
        progress.step(repoPath, 'checking')
        const status = await this.getStatus(repoPath)
        if (!status.isRepo) {
          result.error = 'Not a git repository'
          return result
        }

        // 1. Pull if behind
        if (status.behind > 0) {
          progress.step(repoPath, 'pulling')
          await this.pull(repoPath, 'auto')
          result.actions.push('pulled')
        }

        // Re-check status after pull (files may have changed)
        const postPullStatus = status.behind > 0 ? await this.getStatus(repoPath) : status
        const files = postPullStatus.files

        if (files.length === 0) {
          // Nothing to commit — but maybe we pulled, so check if we need to push
          if (postPullStatus.ahead > 0) {
            progress.step(repoPath, 'pushing')
            await this.push(repoPath)
            result.actions.push('pushed')
          }
          return result
        }

        // 2. Stage all files
        progress.step(repoPath, 'staging')
        const allPaths = files.map((f) => f.path)
        await this.stage(repoPath, allPaths)
        result.actions.push('staged')

        // 3. Generate commit message
        progress.step(repoPath, 'generating')
        const message = await this.generateCommitMessage(repoPath)
        result.actions.push('generated')

        // 4. Commit
        progress.step(repoPath, 'committing')
        await this.commit(repoPath, message)
        result.actions.push('committed')

        // 5. Push
        progress.step(repoPath, 'pushing')
        await this.push(repoPath)
        result.actions.push('pushed')
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
      return result
    }

    for (const repoPath of repoPaths) {
      const result = await syncRepo(repoPath)
      // The counter moves once per repo, at its end, whatever became of it.
      progress.complete(repoPath, 'pushing')
      results.push(result)
    }

    return results
  }

  /**
   * Pull the repos that have something to pull — and ONLY those.
   *
   * The caller passes the repos the panel shows as behind, and this pulls them.
   * It does not fetch, and it does not go looking: discovery is `refreshRemotes`,
   * which is what the panel's refresh runs, and the ↓ badges are its result.
   *
   * The split is the whole design. `behind` can only come from a repo's
   * remote-tracking refs, so a button that "makes sure" by fetching every repo
   * first is a button that talks to N remotes — a minute of network on a folder
   * of ninety, for a click the user made because they could see three arrows.
   * Pull all now pulls those three, in about a second, and finding the fourth is
   * the refresh's job.
   *
   * Status is still re-read here rather than trusted from the renderer: the
   * check is local and instant, and it is what stops a stale click (the repo was
   * pulled in a terminal a moment ago) turning into a pointless `git pull`. A
   * repo that turns out not to be behind is skipped, not an error.
   */
  async magicPull(
    repoPaths: string[],
    onProgress?: GitBatchProgressFn
  ): Promise<MagicPullResult[]> {
    // Deduplicated: the counter counts repos, and a path listed twice would
    // leave the bar one short of full forever.
    const unique = [...new Set(repoPaths)]
    const progress = new BatchProgress('pull', unique.length, onProgress)
    const results = new Map<string, MagicPullResult>()
    const resultFor = (repoPath: string): MagicPullResult => {
      let result = results.get(repoPath)
      if (!result) {
        result = { repoPath, pulled: false, error: null }
        results.set(repoPath, result)
      }
      return result
    }

    // Local, instant, and the last word on who is actually behind.
    for (const repoPath of unique) progress.step(repoPath, 'checking')
    const statuses = await this.getStatusBatch(unique)

    const behind: string[] = []
    for (const { path: repoPath, status } of statuses) {
      if (!status.isRepo) {
        resultFor(repoPath).error = 'Not a git repository'
        progress.complete(repoPath, 'checking')
        continue
      }
      if (status.behind > 0) {
        behind.push(repoPath)
        continue
      }
      // Nothing to bring — as far as anything knows without going to the
      // remote, which is deliberately not this operation's job.
      resultFor(repoPath)
      progress.complete(repoPath, 'checking')
    }

    await mapWithConcurrency(behind, PULL_BATCH_CONCURRENCY, async (repoPath) => {
      const result = resultFor(repoPath)
      try {
        progress.step(repoPath, 'pulling')
        await this.pull(repoPath, 'auto')
        result.pulled = true
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
      progress.complete(repoPath, 'pulling')
    })

    return repoPaths.map(resultFor)
  }

  /**
   * Update every listed repo's remote-tracking refs, in parallel, reporting as
   * it goes — the panel's refresh, and the only thing here that talks to a
   * remote for a repo the user has not pointed at.
   *
   * This is the expensive half of what Pull all used to do on every click, now
   * behind a control that says that is what it does. It reports failures per
   * repo rather than swallowing them: a remote that is unreachable is news when
   * you asked to go and look, even though it is noise on a background poll
   * (`fetchBatch`, which stays silent for exactly that reason).
   */
  async refreshRemotes(
    repoPaths: string[],
    onProgress?: GitBatchProgressFn
  ): Promise<Array<{ repoPath: string; error: string | null }>> {
    const unique = [...new Set(repoPaths)]
    const progress = new BatchProgress('fetch', unique.length, onProgress)

    const byPath = new Map<string, { repoPath: string; error: string | null }>()
    await mapWithConcurrency(unique, FETCH_BATCH_CONCURRENCY, async (repoPath) => {
      const result: { repoPath: string; error: string | null } = { repoPath, error: null }
      try {
        progress.step(repoPath, 'fetching')
        await this.fetchOrThrow(repoPath)
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
      progress.complete(repoPath, 'fetching')
      byPath.set(repoPath, result)
    })

    return repoPaths.map(
      (repoPath) => byPath.get(repoPath) ?? { repoPath, error: 'not attempted' }
    )
  }

  async getJourney(cwd: string, maxCount: number = 200): Promise<GitJourneyResult> {
    try {
      const git = simpleGit(cwd)
      const branch = (await git.status()).current
      if (!branch) return { local: [], pushGroups: [], fallbackMode: false, branch: '', hasMore: false }

      // Fetch outgoing (unpushed) commits and full log in parallel
      const [local, log] = await Promise.all([
        this.getOutgoingCommits(cwd),
        this.getLog(cwd, maxCount)
      ])

      const localHashes = new Set(local.map((c) => c.hash))
      const pushedCommits = log.filter((c) => !localHashes.has(c.hash))

      // Try reflog-based grouping
      let pushGroups: GitPushGroup[] = []
      let fallbackMode = false

      try {
        const reflogRaw = await git.raw([
          'reflog', 'show', `origin/${branch}`,
          '--format=%H|%aI|%gs',
          '-n', '200'
        ])

        const pushEvents: Array<{ hash: string; date: string }> = []
        for (const line of reflogRaw.trim().split('\n')) {
          if (!line.trim()) continue
          const parts = line.split('|')
          if (parts.length < 3) continue
          const gs = parts.slice(2).join('|')
          if (gs.includes('update by push')) {
            pushEvents.push({ hash: parts[0], date: parts[1] })
          }
        }

        if (pushEvents.length > 0) {
          const assigned = new Set<string>()

          // For each push event, walk from its tip backwards to find commits in this push
          for (let i = 0; i < pushEvents.length; i++) {
            const pushEvent = pushEvents[i]
            const nextPushHash = i + 1 < pushEvents.length ? pushEvents[i + 1].hash : null

            const groupCommits: GitLogEntry[] = []
            let collecting = false

            for (const commit of pushedCommits) {
              if (assigned.has(commit.hash)) continue

              if (commit.hash === pushEvent.hash) collecting = true

              if (collecting) {
                if (nextPushHash && commit.hash === nextPushHash) break
                groupCommits.push(commit)
                assigned.add(commit.hash)
              }
            }

            if (groupCommits.length > 0) {
              pushGroups.push({
                id: pushEvent.hash.slice(0, 12),
                pushedAt: pushEvent.date,
                commits: groupCommits
              })
            }
          }

          // Any remaining unassigned commits go into an "older" group
          const remaining = pushedCommits.filter((c) => !assigned.has(c.hash))
          if (remaining.length > 0) {
            pushGroups.push({
              id: 'older',
              pushedAt: remaining[0].date,
              commits: remaining
            })
          }
        } else {
          fallbackMode = true
        }
      } catch {
        fallbackMode = true
      }

      // Fallback: group by day
      if (fallbackMode) {
        const dayMap = new Map<string, GitLogEntry[]>()
        for (const commit of pushedCommits) {
          const day = commit.date.split('T')[0]
          if (!dayMap.has(day)) dayMap.set(day, [])
          dayMap.get(day)!.push(commit)
        }
        pushGroups = Array.from(dayMap.entries())
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([day, commits]) => ({
            id: day,
            pushedAt: commits[0].date,
            commits
          }))
      }

      const hasMore = log.length >= maxCount
      return { local, pushGroups, fallbackMode, branch, hasMore }
    } catch (err) {
      console.warn('[git] getJourney failed:', (err as Error).message)
      return { local: [], pushGroups: [], fallbackMode: false, branch: '', hasMore: false }
    }
  }

  async summarizePushGroup(
    _cwd: string,
    commitMessages: string[],
    diffStats: string
  ): Promise<{ title: string; description: string }> {
    const prompt = `Summarize this group of git commits that were pushed together.

Commit messages:
${commitMessages.map((m) => `- ${m}`).join('\n')}

Diff stats:
${diffStats}

Respond with exactly two lines:
Line 1: A short title (max 60 chars) describing what was accomplished
Line 2: A 1-2 sentence description explaining what changed and why

No quotes, no markdown, no extra formatting. Just two lines of plain text.`

    const env = { ...getLoginShellEnv() }
    delete env.CLAUDECODE

    const stdout = await runClaudePrompt(prompt, env, '[git:group-summary]')
    const lines = stdout.split('\n').filter(Boolean)
    const title = lines[0] || 'Changes'
    const description = lines.slice(1).join(' ').trim() || ''
    return { title, description }
  }

  async getStatus(cwd: string): Promise<GitStatusResult> {
    try {
      const git = simpleGit(cwd)
      const isRepo = await git.checkIsRepo()

      if (!isRepo) {
        return {
          isRepo: false,
          branch: '',
          ahead: 0,
          behind: 0,
          hasUpstream: false,
          files: [],
          repoRoot: ''
        }
      }

      const [status, repoRoot] = await Promise.all([
        git.status(),
        git.revparse(['--show-toplevel']).then((r) => r.trim())
      ])

      const hasUpstream = status.tracking != null && status.tracking !== ''
      let ahead = status.ahead
      if (!hasUpstream && status.current) {
        // Count commits on HEAD not present on any remote ref — so the user sees
        // an accurate "unpublished commits" count for an unpublished branch.
        try {
          const out = await git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes'])
          ahead = parseInt(out.trim(), 10) || 0
        } catch {
          ahead = 0
        }
      }

      const worktree = await this.readWorktree(git, cwd, status.current ?? '')

      return {
        isRepo: true,
        branch: status.current ?? '',
        ahead,
        behind: status.behind,
        hasUpstream,
        files: mapFiles(status),
        repoRoot,
        ...(worktree ? { worktree } : {})
      }
    } catch {
      return {
        isRepo: false,
        branch: '',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
        repoRoot: ''
      }
    }
  }
}

export const gitManager = new GitManager()

function runClaudeOnce(
  prompt: string,
  env: Record<string, string>,
  logPrefix: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--model', 'haiku', '--fallback-model', 'sonnet'],
      {
        env,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 60000
      },
      (err, stdout, stderr) => {
        if (err) {
          const parts = [err.message, stderr?.trim()].filter(Boolean)
          const detail = parts.join(' — ') || 'unknown error'
          console.error(`${logPrefix} claude CLI error:`, detail)
          reject(new Error(detail))
          return
        }
        const out = stdout.trim()
        if (!out) {
          reject(new Error('Empty response from Claude'))
          return
        }
        resolve(out)
      }
    )
    // Swallow stdin EPIPE — if claude exits before we finish writing, the
    // callback above will report the real error. An unhandled 'error' on
    // stdin would crash the main process.
    child.stdin?.on('error', (e) => {
      console.warn(`${logPrefix} stdin error (ignored):`, (e as Error).message)
    })
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

async function runClaudePrompt(
  prompt: string,
  env: Record<string, string>,
  logPrefix: string
): Promise<string> {
  try {
    return await runClaudeOnce(prompt, env, logPrefix)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${logPrefix} first attempt failed, retrying once:`, msg)
    return runClaudeOnce(prompt, env, logPrefix)
  }
}
