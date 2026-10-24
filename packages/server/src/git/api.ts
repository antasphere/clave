import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
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
  GitSyncWatches
} from '@clave/contract/git'

export const GitLive = HttpApiBuilder.group(ClaveApi, 'git', (handlers) =>
  handlers
    .handle('status', HttpCqrs.query(GetGitStatus))
    .handle('statusBatch', HttpCqrs.command(GetGitStatusBatch))
    .handle('discover', HttpCqrs.query(DiscoverGitRepos))
    .handle('checkIgnored', HttpCqrs.command(GitCheckIgnored))
    .handle('fetch', HttpCqrs.command(GitFetch))
    .handle('fetchBatch', HttpCqrs.command(GitFetchBatch))
    .handle('refreshRemotes', HttpCqrs.command(GitRefreshRemotes))
    .handle('watches', HttpCqrs.command(GitSyncWatches))
    .handle('stage', HttpCqrs.command(GitStage))
    .handle('unstage', HttpCqrs.command(GitUnstage))
    .handle('discard', HttpCqrs.command(GitDiscard))
    .handle('commit', HttpCqrs.command(GitCommit))
    .handle('push', HttpCqrs.command(GitPush))
    .handle('publishBranch', HttpCqrs.command(GitPublishBranch))
    .handle('pull', HttpCqrs.command(GitPull))
    .handle('diff', HttpCqrs.query(GitDiff))
    .handle('rangeFiles', HttpCqrs.query(GitRangeFiles))
    .handle('rangeDiff', HttpCqrs.query(GitRangeDiff))
    .handle('commitFiles', HttpCqrs.query(GitCommitFiles))
    .handle('commitDiff', HttpCqrs.query(GitCommitDiff))
    .handle('log', HttpCqrs.query(GitLog))
    .handle('outgoing', HttpCqrs.query(GitOutgoingCommits))
    .handle('incoming', HttpCqrs.query(GitIncomingCommits))
    .handle('journey', HttpCqrs.query(GitJourney))
    .handle('generateCommitMessage', HttpCqrs.command(GitGenerateCommitMessage))
    .handle('summarizePush', HttpCqrs.command(GitSummarizePush))
    .handle('magicSync', HttpCqrs.command(GitMagicSync))
    .handle('magicPull', HttpCqrs.command(GitMagicPull))
)
