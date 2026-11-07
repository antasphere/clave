import * as path from 'path'
import { IGNORED_DIRECTORIES_SET } from './constants'

/**
 * The repo watcher (PRDCT-3775): how the git panel learns that a repo changed,
 * instead of re-reading every repo every five seconds to find out.
 *
 * A panel names the repos it shows; each one is watched recursively, its work
 * tree and, for a linked worktree, the git directories that live elsewhere.
 * A change that can move the repo's status (a file edited, staged, committed,
 * a branch moved, a fetch landed) is reported once per burst, and only for
 * that repo; the panel then reads that repo again, through the queue. What
 * cannot move a status is dropped here: git's object store, its reflogs and
 * lock files, the directories the file tree ignores, and a nested repo's
 * changes, which are the nested repo's to report.
 *
 * Nothing here imports Electron or git: the watch function and the resolver
 * of a repo's git directories are given, so the rules are tested on their own.
 */

export interface RepoDirs {
  /** The repo's top level: what is watched. The panel may name the repo by a
   *  folder inside it; changes are reported under the panel's name. */
  root: string
  gitDir: string
  commonDir: string
}

export interface DirWatch {
  close(): void
}

/** Watch `dir` recursively; `filename` is relative to `dir`, null when the
 *  platform did not say. Throws when the directory cannot be watched. */
export type WatchFn = (dir: string, onEvent: (filename: string | null) => void) => DirWatch

/** Inside a git directory, what never changes a status: the object store
 *  (every commit and fetch writes there, AND moves a ref, which is what is
 *  read), the reflogs, hooks and LFS, and the lock files git takes and drops. */
const GIT_DIR_NOISE = new Set(['objects', 'logs', 'hooks', 'lfs'])

function isUnder(parent: string, child: string): boolean {
  if (child === parent) return true
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(base)
}

/**
 * Whether a change at `abs` can move `repo`'s status. `otherRoots` are the
 * other repos being watched: a change inside one of them nested under this
 * repo is that repo's to report.
 */
export function isRelevantChange(repo: RepoDirs, abs: string, otherRoots: string[]): boolean {
  if (abs.endsWith('.lock')) return false

  if (isUnder(repo.gitDir, abs)) {
    if (abs === repo.gitDir) return true
    const first = path.relative(repo.gitDir, abs).split(path.sep)[0]
    if (GIT_DIR_NOISE.has(first)) return false
    // A main checkout's `worktrees/` holds its linked worktrees' HEADs and
    // indexes: theirs, not its own.
    if (first === 'worktrees' && repo.gitDir === repo.commonDir) return false
    return true
  }

  if (isUnder(repo.commonDir, abs)) {
    // A linked worktree shares its main checkout's refs; the rest of the
    // common dir (the main checkout's HEAD and index, the other worktrees) is
    // not this checkout's status.
    const rel = path.relative(repo.commonDir, abs)
    const first = rel.split(path.sep)[0]
    // `config` carries the upstreams, which a linked worktree reads there too.
    return (
      first === 'refs' ||
      rel === 'packed-refs' ||
      rel === 'FETCH_HEAD' ||
      rel === 'config' ||
      rel === ''
    )
  }

  if (!isUnder(repo.root, abs)) return false
  for (const other of otherRoots) {
    if (other !== repo.root && isUnder(repo.root, other) && isUnder(other, abs)) return false
  }
  const segments = path.relative(repo.root, abs).split(path.sep)
  // A `.git` met here is not this repo's own git dir (handled above): it is
  // a nested repo's, or a linked worktree's pointer file.
  return !segments.some((s) => IGNORED_DIRECTORIES_SET.has(s))
}

interface WatchedRepo {
  /** The repo as the subscribers named it. */
  name: string
  dirs: RepoDirs
  /** The directories watched for it (one, two or three) and their watches. */
  watches: DirWatch[]
  subscribers: Set<string>
}

export interface GitRepoWatcherOptions {
  watch: WatchFn
  /** The repo's git directories, or null when it is not a repo. */
  resolve: (repo: string) => Promise<RepoDirs | null>
  /** Called once per burst with the repos that changed. */
  onChange: (repos: string[]) => void
  /** Quiet time after the last change before a burst is reported. */
  debounceMs: number
  /** Longest a burst is held while changes keep arriving. */
  maxWaitMs: number
}

export class GitRepoWatcher {
  private readonly repos = new Map<string, WatchedRepo>()
  private readonly subscriptions = new Map<string, Set<string>>()
  private readonly pending = new Set<string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private firstPendingAt = 0

  constructor(private readonly opts: GitRepoWatcherOptions) {}

  /**
   * Make `subscriber`'s set of watched repos exactly `repos`. Returns the
   * repos of that set that are watched: a repo missing from the answer could
   * not be (gone, not a repo, out of watches) and is the caller's to poll.
   */
  async setRepos(subscriber: string, repos: string[]): Promise<string[]> {
    const wanted = new Set(repos)
    const previous = this.subscriptions.get(subscriber) ?? new Set<string>()
    this.subscriptions.set(subscriber, wanted)

    for (const repo of previous) {
      if (!wanted.has(repo)) this.releaseRepo(repo, subscriber)
    }
    for (const repo of wanted) {
      // Dropped or replaced while an earlier repo resolved: this set is no
      // longer the subscriber's, and adding to it would leak a watch nobody
      // ever releases.
      if (this.subscriptions.get(subscriber) !== wanted) break
      const existing = this.repos.get(repo)
      if (existing) {
        existing.subscribers.add(subscriber)
        continue
      }
      await this.acquireRepo(repo, subscriber)
    }
    // The subscriber may have changed its set again while this one resolved.
    const current = this.subscriptions.get(subscriber)
    if (current !== wanted) return []
    return repos.filter((r) => this.repos.get(r)?.subscribers.has(subscriber))
  }

  /** Drop one subscriber's repos. */
  drop(subscriber: string): void {
    const repos = this.subscriptions.get(subscriber)
    if (!repos) return
    this.subscriptions.delete(subscriber)
    for (const repo of repos) this.releaseRepo(repo, subscriber)
  }

  /** Drop every subscriber whose key starts with `prefix` (a closed window). */
  dropPrefix(prefix: string): void {
    for (const subscriber of [...this.subscriptions.keys()]) {
      if (subscriber.startsWith(prefix)) this.drop(subscriber)
    }
  }

  watchedRepos(): string[] {
    return [...this.repos.keys()]
  }

  dispose(): void {
    for (const subscriber of [...this.subscriptions.keys()]) this.drop(subscriber)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.pending.clear()
  }

  private async acquireRepo(repo: string, subscriber: string): Promise<void> {
    let dirs: RepoDirs | null
    try {
      dirs = await this.opts.resolve(repo)
    } catch {
      dirs = null
    }
    if (!dirs) return
    // Resolved while another call acquired it, or the subscriber let go.
    const raced = this.repos.get(repo)
    if (raced) {
      if (this.subscriptions.get(subscriber)?.has(repo)) raced.subscribers.add(subscriber)
      return
    }
    if (!this.subscriptions.get(subscriber)?.has(repo)) return
    // Another subscriber's set may still hold this repo while it resolved;
    // the watch carries every current holder, so the last one releases it.
    const holders = new Set<string>()
    for (const [key, set] of this.subscriptions) if (set.has(repo)) holders.add(key)

    const watchDirs = [dirs.root]
    if (!isUnder(dirs.root, dirs.commonDir)) watchDirs.push(dirs.commonDir)
    if (!isUnder(dirs.root, dirs.gitDir) && !isUnder(dirs.commonDir, dirs.gitDir)) {
      watchDirs.push(dirs.gitDir)
    }
    const watches: DirWatch[] = []
    const entry: WatchedRepo = { name: repo, dirs, watches, subscribers: holders }
    try {
      for (const dir of watchDirs) {
        watches.push(this.opts.watch(dir, (filename) => this.onEvent(entry, dir, filename)))
      }
    } catch {
      for (const w of watches) safeClose(w)
      return
    }
    this.repos.set(repo, entry)
  }

  private releaseRepo(repo: string, subscriber: string): void {
    const entry = this.repos.get(repo)
    if (!entry) return
    entry.subscribers.delete(subscriber)
    if (entry.subscribers.size > 0) return
    for (const w of entry.watches) safeClose(w)
    this.repos.delete(repo)
    this.pending.delete(repo)
  }

  private onEvent(entry: WatchedRepo, dir: string, filename: string | null): void {
    if (this.repos.get(entry.name) !== entry) return
    // No filename: the platform coalesced the event. Something changed there.
    if (filename !== null) {
      const abs = path.resolve(dir, filename)
      const roots = [...this.repos.values()].map((r) => r.dirs.root)
      if (!isRelevantChange(entry.dirs, abs, roots)) return
    }
    this.schedule(entry.name)
  }

  private schedule(repo: string): void {
    const now = Date.now()
    if (this.pending.size === 0) this.firstPendingAt = now
    this.pending.add(repo)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const waited = now - this.firstPendingAt
    const delay = Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited))
    this.debounceTimer = setTimeout(() => this.flush(), delay)
  }

  private flush(): void {
    this.debounceTimer = null
    if (this.pending.size === 0) return
    const repos = [...this.pending]
    this.pending.clear()
    this.opts.onChange(repos)
  }
}

function safeClose(w: DirWatch): void {
  try {
    w.close()
  } catch {
    /* already closed */
  }
}
