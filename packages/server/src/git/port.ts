/**
 * The git port (wave wcs1023, lane C, #242): what the server needs from
 * whoever holds the checkouts. The daemon implements it over the app's own
 * git implementation (`src/main/server/git-port.ts`); a server with nothing
 * behind it runs on `GitPort.none`, which refuses every call as unavailable
 * rather than answer "not a repository" for a folder it never looked at.
 *
 * The methods are plain calls and promises, as the files port's are: the
 * handlers (`handlers.ts`) are where a thrown error becomes a declared
 * failure. A plain `Error` is git's refusal, carrying git's own sentence; a
 * thrown `CapabilityUnavailable` is the server saying it has no git.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { GitEvent, GitOperations } from '@clave/contract/git'
import type { Unsubscribe } from '../sessions/port'

export type { GitEvent }

export interface GitService extends GitOperations {
  /** The service's news: `git.repos_changed` once per burst of changes on a
   *  watched repository, `git.batch_progress` as a batch moves. The server
   *  publishes each one to every attached client. */
  readonly subscribe: (listener: (event: GitEvent) => void) => Unsubscribe
}

const NO_GIT = new CapabilityUnavailable({
  capability: 'git',
  message: 'This server has no git service.'
})
const refuse = (): Promise<never> => Promise.reject(NO_GIT)

export class GitPort extends Context.Tag('@clave/server/Git')<GitPort, GitService>() {
  static layer(service: GitService): Layer.Layer<GitPort> {
    return Layer.succeed(GitPort, service)
  }
  /** A server with no checkouts behind it: every call says so. */
  static readonly none: GitService = {
    status: refuse,
    statusBatch: refuse,
    discover: refuse,
    checkIgnored: refuse,
    fetch: refuse,
    fetchBatch: refuse,
    refreshRemotes: refuse,
    watch: refuse,
    unwatch: refuse,
    stage: refuse,
    unstage: refuse,
    discard: refuse,
    commit: refuse,
    push: refuse,
    publishBranch: refuse,
    pull: refuse,
    diff: refuse,
    rangeFiles: refuse,
    rangeDiff: refuse,
    commitFiles: refuse,
    commitDiff: refuse,
    log: refuse,
    outgoing: refuse,
    incoming: refuse,
    journey: refuse,
    generateCommitMessage: refuse,
    summarizePush: refuse,
    magicSync: refuse,
    magicPull: refuse,
    subscribe: () => () => {}
  }
}
