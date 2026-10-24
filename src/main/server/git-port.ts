/**
 * The git port of a Clave server (wave wcs1023, lane C, #242): the app's own
 * git implementation (`git-manager.ts`, `repo-index.ts`, `git-watch.ts`)
 * behind `@clave/server`'s `GitPort`, so a checkout on the server behaves in
 * the panel exactly as one on the Mac does. `ipc-handlers/git-handlers.ts`
 * is the same wiring for the Mac's own windows; this file is the one the
 * standalone entry gives its server, and it imports no Electron.
 *
 * Three things differ from the IPC arm. The repo watcher's bursts and a batch's
 * progress go out as server events (`git.repos_changed`, `git.batch_progress`)
 * to every attached client, instead of to one window; the client that runs
 * the batch is the one drawing it. A Mac names what it watches as one
 * complete map per window, replaced as a whole under a generation, never as
 * single watches and unwatches. And a commit message or a push summary is
 * written by THIS machine's `claude`, on this machine's login: when it has
 * none, the sentence says so, named for the server, rather than git's "spawn
 * claude ENOENT" or the CLI's sign-in refusal reaching the panel as it is.
 */
import * as fs from 'fs'
import type { GitEvent, GitService } from '@clave/server'
import type { GitWatchSubscription } from '@clave/contract/git'
import type { Unsubscribe } from '@clave/server'
import { gitManager, type MagicSyncResult } from '../git-manager'
import { GitRepoWatcher } from '../git-watch'
import { repoIndexManager } from '../repo-index'
import { logPullFailures } from '../pull-log'
import { GIT_WATCH_DEBOUNCE_MS, GIT_WATCH_MAX_WAIT_MS } from '../constants'
import type { GitBatchProgress } from '../../shared/git-batch'

export interface ServerGitPortOptions {
  /** Where a failed pull of Pull all is logged, with its reason. stderr by default. */
  readonly log?: (line: string) => void
  /** Quiet time after the last change before a burst is reported. */
  readonly debounceMs?: number
  /** Longest a burst is held while changes keep arriving. */
  readonly maxWaitMs?: number
}

export interface ServerGitPort extends GitService {
  /** Close every watch; the port answers nothing after this. */
  dispose(): void
}

const NO_CLAUDE_BINARY =
  'This server has no "claude" command: install Claude Code on the server and sign in to generate commit messages.'
const CLAUDE_NOT_SIGNED_IN =
  'This server\'s Claude is not signed in: run "claude login" on the server to generate commit messages.'

/**
 * What the panel reads when the server's `claude` could not write: the two
 * ways a server has no Claude login, named; anything else as the CLI said it.
 */
export function describeClaudeFailure(message: string): string {
  if (/spawn claude ENOENT|claude: command not found|claude: not found/i.test(message))
    return NO_CLAUDE_BINARY
  if (
    /not logged in|invalid api key|please run \/login|please log in|authentication_error|unauthorized|OAuth token has expired/i.test(
      message
    )
  )
    return CLAUDE_NOT_SIGNED_IN
  return message
}

const noop = (): void => {}

export function serverGitPort(options: ServerGitPortOptions = {}): ServerGitPort {
  const log = options.log ?? ((line: string) => console.warn(line))
  const listeners = new Set<(event: GitEvent) => void>()
  const publish = (event: GitEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[clave-server] git listener failed', error)
      }
    }
  }
  // Each batch's events carry the id its client gave it, so that client
  // draws its own batch and no other Mac's (verifier round 2).
  const progress =
    (batchId?: string) =>
    (p: GitBatchProgress): void =>
      publish({ _tag: 'git.batch_progress', ...p, ...(batchId !== undefined && { batchId }) })
  const watcher = new GitRepoWatcher({
    watch: (dir, onEvent) => {
      const watch = fs.watch(dir, { recursive: true }, (_type, filename) =>
        onEvent(filename ? filename.toString() : null)
      )
      // A watch that errors later (the folder deleted) is closed rather than
      // left to throw; the panel's slow poll still covers that repo.
      watch.on('error', () => {
        try {
          watch.close()
        } catch {
          /* already closed */
        }
      })
      return watch
    },
    resolve: (repo) => gitManager.repoDirs(repo),
    onChange: (repos) => publish({ _tag: 'git.repos_changed', repos }),
    debounceMs: options.debounceMs ?? GIT_WATCH_DEBOUNCE_MS,
    maxWaitMs: options.maxWaitMs ?? GIT_WATCH_MAX_WAIT_MS
  })
  /**
   * The watch namespaces: one per Mac window, holding the generation of the
   * last map applied and the subscription ids it named. A map is applied as
   * a whole (the ids it no longer names dropped, the named ones set to
   * exactly their paths), only if its generation is not older than the
   * applied one, and maps of one namespace are applied in the order they
   * arrive, one at a time, so a slow map can never finish after a newer one
   * and undo it (`lane-c/watch-rule.md`).
   */
  const namespaces = new Map<string, { generation: number; ids: Set<string> }>()
  const namespaceChains = new Map<string, Promise<unknown>>()
  const applyMap = async (
    namespace: string,
    generation: number,
    subscriptions: ReadonlyArray<GitWatchSubscription>
  ): Promise<ReadonlyArray<GitWatchSubscription>> => {
    const current = namespaces.get(namespace)
    if (current && generation < current.generation) return []
    const ids = new Set(subscriptions.map((s) => s.id))
    namespaces.set(namespace, { generation, ids })
    for (const id of current?.ids ?? []) if (!ids.has(id)) watcher.drop(`${namespace}:${id}`)
    const answered: GitWatchSubscription[] = []
    for (const subscription of subscriptions) {
      const paths = await watcher.setRepos(`${namespace}:${subscription.id}`, [
        ...subscription.paths
      ])
      answered.push({ id: subscription.id, paths })
    }
    return answered
  }
  const withClaudeReason = (results: MagicSyncResult[]): MagicSyncResult[] =>
    results.map((r) => (r.error ? { ...r, error: describeClaudeFailure(r.error) } : r))
  const claude = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(describeClaudeFailure(message))
    }
  }
  return {
    status: (cwd) => gitManager.getStatus(cwd),
    statusBatch: (paths) => gitManager.getStatusBatch([...paths]),
    discover: (cwd, force) => repoIndexManager.discover(cwd, force),
    checkIgnored: (cwd, paths) => gitManager.checkIgnored(cwd, [...paths]),
    fetch: (cwd) => gitManager.fetch(cwd),
    fetchBatch: (paths) => gitManager.fetchBatch([...paths]),
    refreshRemotes: (paths, batchId) => gitManager.refreshRemotes([...paths], progress(batchId)),
    syncWatches: (namespace, generation, subscriptions) => {
      const run = (namespaceChains.get(namespace) ?? Promise.resolve())
        .catch(noop)
        .then(() => applyMap(namespace, generation, subscriptions))
      namespaceChains.set(namespace, run)
      void run
        .finally(() => {
          if (namespaceChains.get(namespace) === run) namespaceChains.delete(namespace)
        })
        .catch(noop)
      return run
    },
    stage: (cwd, files) => gitManager.stage(cwd, [...files]),
    unstage: (cwd, files) => gitManager.unstage(cwd, [...files]),
    discard: (cwd, files) => gitManager.discard(cwd, [...files]),
    commit: (cwd, message) => gitManager.commit(cwd, message),
    push: (cwd) => gitManager.push(cwd),
    publishBranch: (cwd) => gitManager.publishBranch(cwd),
    pull: (cwd, strategy) => gitManager.pull(cwd, strategy),
    diff: (cwd, filePath, staged, isUntracked) =>
      gitManager.getDiff(cwd, filePath, staged, isUntracked),
    rangeFiles: (cwd, direction) => gitManager.getRangeFiles(cwd, direction),
    rangeDiff: (cwd, direction, filePath) => gitManager.getRangeDiff(cwd, direction, filePath),
    commitFiles: (cwd, hash) => gitManager.getCommitFiles(cwd, hash),
    commitDiff: (cwd, hash, filePath) => gitManager.getCommitDiff(cwd, hash, filePath),
    log: (cwd, maxCount) => gitManager.getLog(cwd, maxCount),
    outgoing: (cwd) => gitManager.getOutgoingCommits(cwd),
    incoming: (cwd) => gitManager.getIncomingCommits(cwd),
    journey: (cwd, maxCount) => gitManager.getJourney(cwd, maxCount),
    generateCommitMessage: (cwd) => claude(() => gitManager.generateCommitMessage(cwd)),
    summarizePush: (cwd, commitMessages, diffStats) =>
      claude(() => gitManager.summarizePushGroup(cwd, [...commitMessages], diffStats)),
    magicSync: async (paths, batchId) =>
      withClaudeReason(await gitManager.magicSync([...paths], progress(batchId))),
    // Each repo Pull all could not bring level goes to the server's log with
    // its reason: the bar names them, but only until it is dismissed.
    magicPull: async (paths, batchId) => {
      const results = await gitManager.magicPull([...paths], progress(batchId))
      logPullFailures(results, log)
      return results
    },
    subscribe: (listener): Unsubscribe => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => watcher.dispose()
  }
}
