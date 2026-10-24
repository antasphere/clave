/**
 * The git domain on the server (wave wcs1023, lane C, #242): every command
 * and query of `@clave/contract/git`, answered from the port. Each handler is
 * one call on it; the bus has validated the payload.
 *
 * A thrown `CapabilityUnavailable` is that declared failure; any other
 * `Error` is git's refusal (or the server's, about its Claude login) and
 * becomes `GitOperationFailed` with the sentence as it was, which is what
 * the panel shows for the Mac's own git; anything else is a defect.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  DiscoverGitRepos,
  GetGitStatus,
  GetGitStatusBatch,
  GitCheckIgnored,
  GitCommit,
  GitCommitDiff,
  GitCommitFiles,
  GitDiff,
  GitDiscard,
  GitFetch,
  GitFetchBatch,
  GitGenerateCommitMessage,
  GitIncomingCommits,
  GitJourney,
  GitLog,
  GitMagicPull,
  GitMagicSync,
  GitOperationFailed,
  GitOutgoingCommits,
  GitPublishBranch,
  GitPull,
  GitPush,
  GitRangeDiff,
  GitRangeFiles,
  GitRefreshRemotes,
  GitStage,
  GitSummarizePush,
  GitUnstage,
  GitUnwatchRepos,
  GitWatchRepos
} from '@clave/contract/git'
import { GitPort, type GitService } from './port'

const asUnavailable = (error: unknown): CapabilityUnavailable | null => {
  if (error instanceof CapabilityUnavailable) return error
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    typeof (error as { capability?: unknown }).capability === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const { capability, message } = error as { capability: string; message: string }
    return new CapabilityUnavailable({ capability, message })
  }
  return null
}

/** Git's own refusal, or the implementation's: the message travels as it
 *  is. Paths in it are the server's, which the caller asked about. */
const asFailed = (error: unknown): GitOperationFailed | null =>
  error instanceof Error ? new GitOperationFailed({ message: error.message }) : null

const call = <A>(
  run: (git: GitService) => Promise<A>
): Effect.Effect<A, CapabilityUnavailable | GitOperationFailed, GitPort> =>
  Effect.flatMap(GitPort, (git) =>
    Effect.tryPromise({ try: () => run(git), catch: (error) => error }).pipe(
      Effect.catchAll((error) => {
        const failure = asUnavailable(error) ?? asFailed(error)
        return failure ? Effect.fail(failure) : Effect.die(error)
      })
    )
  )

export const gitHandlers = [
  // Status and discovery
  QueryHandler.make(GetGitStatus, (p) => call((g) => g.status(p.cwd))),
  CommandHandler.make(GetGitStatusBatch, (p) => call((g) => g.statusBatch(p.paths))),
  QueryHandler.make(DiscoverGitRepos, (p) => call((g) => g.discover(p.cwd, p.force))),
  CommandHandler.make(GitCheckIgnored, (p) => call((g) => g.checkIgnored(p.cwd, p.paths))),
  // The remotes
  CommandHandler.make(GitFetch, (p) => call((g) => g.fetch(p.cwd))),
  CommandHandler.make(GitFetchBatch, (p) => call((g) => g.fetchBatch(p.paths))),
  CommandHandler.make(GitRefreshRemotes, (p) => call((g) => g.refreshRemotes(p.paths, p.batchId))),
  // Watching
  CommandHandler.make(GitWatchRepos, (p) => call((g) => g.watch(p.subscriberId, p.paths))),
  CommandHandler.make(GitUnwatchRepos, (p) => call((g) => g.unwatch(p.subscriberId))),
  // Writes
  CommandHandler.make(GitStage, (p) => call((g) => g.stage(p.cwd, p.files))),
  CommandHandler.make(GitUnstage, (p) => call((g) => g.unstage(p.cwd, p.files))),
  CommandHandler.make(GitDiscard, (p) => call((g) => g.discard(p.cwd, p.files))),
  CommandHandler.make(GitCommit, (p) => call((g) => g.commit(p.cwd, p.message))),
  CommandHandler.make(GitPush, (p) => call((g) => g.push(p.cwd))),
  CommandHandler.make(GitPublishBranch, (p) => call((g) => g.publishBranch(p.cwd))),
  CommandHandler.make(GitPull, (p) => call((g) => g.pull(p.cwd, p.strategy))),
  // Diffs
  QueryHandler.make(GitDiff, (p) =>
    call((g) => g.diff(p.cwd, p.filePath, p.staged, p.isUntracked))
  ),
  QueryHandler.make(GitRangeFiles, (p) => call((g) => g.rangeFiles(p.cwd, p.direction))),
  QueryHandler.make(GitRangeDiff, (p) => call((g) => g.rangeDiff(p.cwd, p.direction, p.filePath))),
  QueryHandler.make(GitCommitFiles, (p) => call((g) => g.commitFiles(p.cwd, p.hash))),
  QueryHandler.make(GitCommitDiff, (p) => call((g) => g.commitDiff(p.cwd, p.hash, p.filePath))),
  // History
  QueryHandler.make(GitLog, (p) => call((g) => g.log(p.cwd, p.maxCount))),
  QueryHandler.make(GitOutgoingCommits, (p) => call((g) => g.outgoing(p.cwd))),
  QueryHandler.make(GitIncomingCommits, (p) => call((g) => g.incoming(p.cwd))),
  QueryHandler.make(GitJourney, (p) => call((g) => g.journey(p.cwd, p.maxCount))),
  // The server's Claude
  CommandHandler.make(GitGenerateCommitMessage, (p) => call((g) => g.generateCommitMessage(p.cwd))),
  CommandHandler.make(GitSummarizePush, (p) =>
    call((g) => g.summarizePush(p.cwd, p.commitMessages, p.diffStats))
  ),
  // Batches
  CommandHandler.make(GitMagicSync, (p) => call((g) => g.magicSync(p.paths, p.batchId))),
  CommandHandler.make(GitMagicPull, (p) => call((g) => g.magicPull(p.paths, p.batchId)))
] as const
