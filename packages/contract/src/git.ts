/**
 * The git domain (wave wcs1023, lane C, #242): the git panel's calls, served
 * by the server that holds the checkout. Paths are always server-local; the
 * desktop routes a call to the owner of the repository and keeps every path
 * the server answers under that owner's key, so a folder that exists on two
 * machines is two repositories to the panel. The DTOs mirror the Mac's own
 * implementation (`src/main/git-manager.ts`) field by field: local and
 * server behave the same because the same code runs behind both.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

const Path = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.pattern(/^[^\0]+$/)
)
const Paths = Schema.Array(Path).pipe(Schema.maxItems(1000))
const Cwd = Schema.Struct({ cwd: Path })

export const GitFileStatus = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal(
    'staged',
    'modified',
    'deleted',
    'untracked',
    'staged-modified',
    'staged-deleted',
    'renamed'
  ),
  staged: Schema.Boolean
})
export type GitFileStatus = typeof GitFileStatus.Type

export const GitWorktreeInfo = Schema.Struct({
  of: Schema.String,
  base: Schema.NullOr(Schema.String),
  baseLabel: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
  merged: Schema.Boolean,
  createdAt: Schema.NullOr(Schema.Number),
  lastCommit: Schema.NullOr(Schema.Struct({ at: Schema.Number, subject: Schema.String }))
})
export type GitWorktreeInfo = typeof GitWorktreeInfo.Type

export const GitStatusResult = Schema.Struct({
  isRepo: Schema.Boolean,
  branch: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
  hasUpstream: Schema.Boolean,
  files: Schema.Array(GitFileStatus),
  repoRoot: Schema.String,
  worktree: Schema.optional(GitWorktreeInfo)
})
export type GitStatusResult = typeof GitStatusResult.Type

export const GitStatusEntry = Schema.Struct({ path: Schema.String, status: GitStatusResult })
export type GitStatusEntry = typeof GitStatusEntry.Type

export const GitCommitResult = Schema.Struct({ hash: Schema.String, branch: Schema.String })
export type GitCommitResult = typeof GitCommitResult.Type

export const GitLogEntry = Schema.Struct({
  hash: Schema.String,
  shortHash: Schema.String,
  message: Schema.String,
  author: Schema.String,
  date: Schema.String,
  refs: Schema.Array(Schema.String)
})
export type GitLogEntry = typeof GitLogEntry.Type

export const GitCommitFileStatus = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal('A', 'M', 'D', 'R', 'C', 'T'),
  insertions: Schema.Number,
  deletions: Schema.Number
})
export type GitCommitFileStatus = typeof GitCommitFileStatus.Type

export const GitPushGroup = Schema.Struct({
  id: Schema.String,
  pushedAt: Schema.String,
  commits: Schema.Array(GitLogEntry),
  summary: Schema.optional(Schema.Struct({ title: Schema.String, description: Schema.String }))
})
export type GitPushGroup = typeof GitPushGroup.Type

export const GitJourneyResult = Schema.Struct({
  local: Schema.Array(GitLogEntry),
  pushGroups: Schema.Array(GitPushGroup),
  fallbackMode: Schema.Boolean,
  branch: Schema.String,
  hasMore: Schema.Boolean
})
export type GitJourneyResult = typeof GitJourneyResult.Type

export const GitRepoInfo = Schema.Struct({ name: Schema.String, path: Schema.String })
export type GitRepoInfo = typeof GitRepoInfo.Type
export const GitDiscoverResult = Schema.Struct({
  repos: Schema.Array(GitRepoInfo),
  truncated: Schema.Boolean
})
export type GitDiscoverResult = typeof GitDiscoverResult.Type

export const GitRangeDirection = Schema.Literal('incoming', 'outgoing', 'worktree', 'base')
export type GitRangeDirection = typeof GitRangeDirection.Type
export const GitPullStrategy = Schema.Literal('auto', 'merge', 'rebase', 'ff-only')
export type GitPullStrategy = typeof GitPullStrategy.Type

export const GitDiscardFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  staged: Schema.Boolean
})
export type GitDiscardFile = typeof GitDiscardFile.Type

export const MagicSyncResult = Schema.Struct({
  repoPath: Schema.String,
  actions: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String)
})
export type MagicSyncResult = typeof MagicSyncResult.Type
/** One repo of the refresh sweep: reached, or not and why. */
export const GitRefreshResult = Schema.Struct({
  repoPath: Schema.String,
  error: Schema.NullOr(Schema.String)
})
export type GitRefreshResult = typeof GitRefreshResult.Type
export const MagicPullResult = Schema.Struct({
  repoPath: Schema.String,
  pulled: Schema.Boolean,
  error: Schema.NullOr(Schema.String)
})
export type MagicPullResult = typeof MagicPullResult.Type

export const GitBatchOp = Schema.Literal('pull', 'sync', 'fetch')
export type GitBatchOp = typeof GitBatchOp.Type
export const GitBatchPhase = Schema.Literal(
  'checking',
  'fetching',
  'pulling',
  'staging',
  'generating',
  'committing',
  'pushing'
)
export type GitBatchPhase = typeof GitBatchPhase.Type
/** One progress event of a batch (`src/shared/git-batch.ts`), published to
 *  every attached client; a client draws only the op it is running. */
export const GitBatchProgress = Schema.Struct({
  op: GitBatchOp,
  phase: GitBatchPhase,
  repoPath: Schema.String,
  repoName: Schema.String,
  done: Schema.Number,
  total: Schema.Number
})
export type GitBatchProgress = typeof GitBatchProgress.Type

export const GitPushSummary = Schema.Struct({ title: Schema.String, description: Schema.String })
export type GitPushSummary = typeof GitPushSummary.Type

/** Git said no, or the server could not run it: the sentence is git's own
 *  (or the server's about its Claude login), shown as the panel shows the
 *  Mac's. */
export class GitOperationFailed extends Schema.TaggedError<GitOperationFailed>()(
  'GitOperationFailed',
  { message: Schema.String }
) {}
const Failure = Schema.Union(GitOperationFailed, CapabilityUnavailable)

/** The two events of the domain, members of `ServerEvent`. */
export const GitEvent = Schema.Union(
  /** Repositories the server watches changed on its disk; the panel re-reads them. */
  Schema.TaggedStruct('git.repos_changed', { repos: Schema.Array(Schema.String) }),
  /** A repo moved inside a batch (Pull all, Magic sync, the refresh sweep). */
  Schema.TaggedStruct('git.batch_progress', GitBatchProgress.fields)
)
export type GitEvent = typeof GitEvent.Type

// ── Status and discovery ──
export const GetGitStatus = Query.define('GetGitStatus', {
  payload: Cwd,
  success: GitStatusResult,
  failure: Failure
})
/** A list of repositories in one read: a POST, its list in the body (a GET
 *  carries one string per key, and a hundred paths do not fit a URL). */
export const GetGitStatusBatch = Command.define('GetGitStatusBatch', {
  payload: Schema.Struct({ paths: Paths }),
  success: Schema.Array(GitStatusEntry),
  failure: Failure
})
/** A GET carries its flags as strings, so they are decoded from strings here. */
export const DiscoverGitRepos = Query.define('DiscoverGitRepos', {
  payload: Schema.Struct({ cwd: Path, force: Schema.optional(Schema.BooleanFromString) }),
  success: GitDiscoverResult,
  failure: Failure
})
export const GitCheckIgnored = Command.define('GitCheckIgnored', {
  payload: Schema.Struct({ cwd: Path, paths: Schema.Array(Schema.String) }),
  success: Schema.Array(Schema.String),
  failure: Failure
})
// ── The remotes ──
export const GitFetch = Command.define('GitFetch', {
  payload: Cwd,
  success: Schema.Void,
  failure: Failure
})
export const GitFetchBatch = Command.define('GitFetchBatch', {
  payload: Schema.Struct({ paths: Paths }),
  success: Schema.Void,
  failure: Failure
})
export const GitRefreshRemotes = Command.define('GitRefreshRemotes', {
  payload: Schema.Struct({ paths: Paths }),
  success: Schema.Array(GitRefreshResult),
  failure: Failure
})
// ── Watching ──
export const GitWatchRepos = Command.define('GitWatchRepos', {
  payload: Schema.Struct({
    subscriberId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
    paths: Paths
  }),
  success: Schema.Array(Schema.String),
  failure: Failure
})
export const GitUnwatchRepos = Command.define('GitUnwatchRepos', {
  payload: Schema.Struct({
    subscriberId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
  }),
  success: Schema.Void,
  failure: Failure
})
// ── Writes ──
export const GitStage = Command.define('GitStage', {
  payload: Schema.Struct({ cwd: Path, files: Schema.Array(Schema.String) }),
  success: Schema.Void,
  failure: Failure
})
export const GitUnstage = Command.define('GitUnstage', {
  payload: Schema.Struct({ cwd: Path, files: Schema.Array(Schema.String) }),
  success: Schema.Void,
  failure: Failure
})
export const GitDiscard = Command.define('GitDiscard', {
  payload: Schema.Struct({ cwd: Path, files: Schema.Array(GitDiscardFile) }),
  success: Schema.Void,
  failure: Failure
})
export const GitCommit = Command.define('GitCommit', {
  payload: Schema.Struct({ cwd: Path, message: Schema.String }),
  success: GitCommitResult,
  failure: Failure
})
export const GitPush = Command.define('GitPush', {
  payload: Cwd,
  success: Schema.Void,
  failure: Failure
})
export const GitPublishBranch = Command.define('GitPublishBranch', {
  payload: Cwd,
  success: Schema.Void,
  failure: Failure
})
export const GitPull = Command.define('GitPull', {
  payload: Schema.Struct({ cwd: Path, strategy: Schema.optional(GitPullStrategy) }),
  success: Schema.Void,
  failure: Failure
})
// ── Diffs ──
export const GitDiff = Query.define('GitDiff', {
  payload: Schema.Struct({
    cwd: Path,
    filePath: Schema.String,
    staged: Schema.BooleanFromString,
    isUntracked: Schema.BooleanFromString
  }),
  success: Schema.String,
  failure: Failure
})
export const GitRangeFiles = Query.define('GitRangeFiles', {
  payload: Schema.Struct({ cwd: Path, direction: GitRangeDirection }),
  success: Schema.Array(GitCommitFileStatus),
  failure: Failure
})
export const GitRangeDiff = Query.define('GitRangeDiff', {
  payload: Schema.Struct({ cwd: Path, direction: GitRangeDirection, filePath: Schema.String }),
  success: Schema.String,
  failure: Failure
})
export const GitCommitFiles = Query.define('GitCommitFiles', {
  payload: Schema.Struct({ cwd: Path, hash: Schema.String }),
  success: Schema.Array(GitCommitFileStatus),
  failure: Failure
})
export const GitCommitDiff = Query.define('GitCommitDiff', {
  payload: Schema.Struct({ cwd: Path, hash: Schema.String, filePath: Schema.String }),
  success: Schema.String,
  failure: Failure
})
// ── History ──
const MaxCount = Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.positive()))
export const GitLog = Query.define('GitLog', {
  payload: Schema.Struct({ cwd: Path, maxCount: MaxCount }),
  success: Schema.Array(GitLogEntry),
  failure: Failure
})
export const GitOutgoingCommits = Query.define('GitOutgoingCommits', {
  payload: Cwd,
  success: Schema.Array(GitLogEntry),
  failure: Failure
})
export const GitIncomingCommits = Query.define('GitIncomingCommits', {
  payload: Cwd,
  success: Schema.Array(GitLogEntry),
  failure: Failure
})
export const GitJourney = Query.define('GitJourney', {
  payload: Schema.Struct({ cwd: Path, maxCount: MaxCount }),
  success: GitJourneyResult,
  failure: Failure
})
// ── The server's Claude: a commit message, a push summary ──
export const GitGenerateCommitMessage = Command.define('GitGenerateCommitMessage', {
  payload: Cwd,
  success: Schema.String,
  failure: Failure
})
export const GitSummarizePush = Command.define('GitSummarizePush', {
  payload: Schema.Struct({
    cwd: Path,
    commitMessages: Schema.Array(Schema.String),
    diffStats: Schema.String
  }),
  success: GitPushSummary,
  failure: Failure
})
// ── Batches ──
export const GitMagicSync = Command.define('GitMagicSync', {
  payload: Schema.Struct({ paths: Paths }),
  success: Schema.Array(MagicSyncResult),
  failure: Failure
})
export const GitMagicPull = Command.define('GitMagicPull', {
  payload: Schema.Struct({ paths: Paths }),
  success: Schema.Array(MagicPullResult),
  failure: Failure
})

export const gitGroup = ApiGroup.make('git')
  .add(HttpCqrs.queryEndpoint('status', '/git/status', GetGitStatus))
  .add(HttpCqrs.commandEndpoint('statusBatch', '/git/status-batch', GetGitStatusBatch))
  .add(HttpCqrs.queryEndpoint('discover', '/git/discover', DiscoverGitRepos))
  .add(HttpCqrs.commandEndpoint('checkIgnored', '/git/check-ignored', GitCheckIgnored))
  .add(HttpCqrs.commandEndpoint('fetch', '/git/fetch', GitFetch))
  .add(HttpCqrs.commandEndpoint('fetchBatch', '/git/fetch-batch', GitFetchBatch))
  .add(HttpCqrs.commandEndpoint('refreshRemotes', '/git/refresh-remotes', GitRefreshRemotes))
  .add(HttpCqrs.commandEndpoint('watch', '/git/watch', GitWatchRepos))
  .add(HttpCqrs.commandEndpoint('unwatch', '/git/unwatch', GitUnwatchRepos))
  .add(HttpCqrs.commandEndpoint('stage', '/git/stage', GitStage))
  .add(HttpCqrs.commandEndpoint('unstage', '/git/unstage', GitUnstage))
  .add(HttpCqrs.commandEndpoint('discard', '/git/discard', GitDiscard))
  .add(HttpCqrs.commandEndpoint('commit', '/git/commit', GitCommit))
  .add(HttpCqrs.commandEndpoint('push', '/git/push', GitPush))
  .add(HttpCqrs.commandEndpoint('publishBranch', '/git/publish-branch', GitPublishBranch))
  .add(HttpCqrs.commandEndpoint('pull', '/git/pull', GitPull))
  .add(HttpCqrs.queryEndpoint('diff', '/git/diff', GitDiff))
  .add(HttpCqrs.queryEndpoint('rangeFiles', '/git/range-files', GitRangeFiles))
  .add(HttpCqrs.queryEndpoint('rangeDiff', '/git/range-diff', GitRangeDiff))
  .add(HttpCqrs.queryEndpoint('commitFiles', '/git/commit-files', GitCommitFiles))
  .add(HttpCqrs.queryEndpoint('commitDiff', '/git/commit-diff', GitCommitDiff))
  .add(HttpCqrs.queryEndpoint('log', '/git/log', GitLog))
  .add(HttpCqrs.queryEndpoint('outgoing', '/git/outgoing', GitOutgoingCommits))
  .add(HttpCqrs.queryEndpoint('incoming', '/git/incoming', GitIncomingCommits))
  .add(HttpCqrs.queryEndpoint('journey', '/git/journey', GitJourney))
  .add(
    HttpCqrs.commandEndpoint(
      'generateCommitMessage',
      '/git/generate-commit-message',
      GitGenerateCommitMessage
    )
  )
  .add(HttpCqrs.commandEndpoint('summarizePush', '/git/summarize-push', GitSummarizePush))
  .add(HttpCqrs.commandEndpoint('magicSync', '/git/magic-sync', GitMagicSync))
  .add(HttpCqrs.commandEndpoint('magicPull', '/git/magic-pull', GitMagicPull))

/** The promise-facing port and client share DTOs, independently of transport. */
export interface GitOperations {
  readonly status: (cwd: string) => Promise<GitStatusResult>
  readonly statusBatch: (paths: ReadonlyArray<string>) => Promise<ReadonlyArray<GitStatusEntry>>
  readonly discover: (cwd: string, force?: boolean) => Promise<GitDiscoverResult>
  readonly checkIgnored: (
    cwd: string,
    paths: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<string>>
  readonly fetch: (cwd: string) => Promise<void>
  readonly fetchBatch: (paths: ReadonlyArray<string>) => Promise<void>
  readonly refreshRemotes: (
    paths: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<GitRefreshResult>>
  readonly watch: (
    subscriberId: string,
    paths: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<string>>
  readonly unwatch: (subscriberId: string) => Promise<void>
  readonly stage: (cwd: string, files: ReadonlyArray<string>) => Promise<void>
  readonly unstage: (cwd: string, files: ReadonlyArray<string>) => Promise<void>
  readonly discard: (cwd: string, files: ReadonlyArray<GitDiscardFile>) => Promise<void>
  readonly commit: (cwd: string, message: string) => Promise<GitCommitResult>
  readonly push: (cwd: string) => Promise<void>
  readonly publishBranch: (cwd: string) => Promise<void>
  readonly pull: (cwd: string, strategy?: GitPullStrategy) => Promise<void>
  readonly diff: (
    cwd: string,
    filePath: string,
    staged: boolean,
    isUntracked: boolean
  ) => Promise<string>
  readonly rangeFiles: (
    cwd: string,
    direction: GitRangeDirection
  ) => Promise<ReadonlyArray<GitCommitFileStatus>>
  readonly rangeDiff: (
    cwd: string,
    direction: GitRangeDirection,
    filePath: string
  ) => Promise<string>
  readonly commitFiles: (cwd: string, hash: string) => Promise<ReadonlyArray<GitCommitFileStatus>>
  readonly commitDiff: (cwd: string, hash: string, filePath: string) => Promise<string>
  readonly log: (cwd: string, maxCount?: number) => Promise<ReadonlyArray<GitLogEntry>>
  readonly outgoing: (cwd: string) => Promise<ReadonlyArray<GitLogEntry>>
  readonly incoming: (cwd: string) => Promise<ReadonlyArray<GitLogEntry>>
  readonly journey: (cwd: string, maxCount?: number) => Promise<GitJourneyResult>
  readonly generateCommitMessage: (cwd: string) => Promise<string>
  readonly summarizePush: (
    cwd: string,
    commitMessages: ReadonlyArray<string>,
    diffStats: string
  ) => Promise<GitPushSummary>
  readonly magicSync: (paths: ReadonlyArray<string>) => Promise<ReadonlyArray<MagicSyncResult>>
  readonly magicPull: (paths: ReadonlyArray<string>) => Promise<ReadonlyArray<MagicPullResult>>
}
