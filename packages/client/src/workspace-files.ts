/**
 * The workspace files calls of the typed client, wave 3 lane A's module:
 * every command and query of `@clave/contract/workspace-files` as a promise,
 * derived from the shared API the way the other domains are. A read's
 * `requestId` is the caller's mark on the review event the server may
 * publish before it answers; the caller answers with `answerReview`.
 */
import type { Effect } from 'effect'
import type * as W from '@clave/contract/workspace-files'
import type { Call, DerivedClient } from './call'

export type ClaveFileReadResult = typeof W.ClaveFileReadResult.Type
export type ClaveFileWriteData = typeof W.ClaveFileWriteData.Type
export type DiscoveredFile = typeof W.DiscoveredFile.Type
export type DiscoveredProjectFile = typeof W.DiscoveredProjectFile.Type
export type AutoDiscoverConfig = typeof W.AutoDiscoverConfig.Type
export type ReviewAnswer = typeof W.ReviewAnswer.Type

export interface RecursiveDiscoveryConfig {
  readonly patterns?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly maxDepth?: number
  readonly workspaceId?: string
}

export interface WorkspaceFilesClient {
  readonly read: (
    path: string,
    options?: { rootDir?: string; requestId?: string }
  ) => Promise<ClaveFileReadResult | null>
  readonly write: (path: string, data: ClaveFileWriteData, rootDir?: string) => Promise<void>
  readonly watch: (path: string) => Promise<void>
  readonly unwatch: (path: string) => Promise<void>
  readonly exists: (path: string) => Promise<boolean>
  readonly discover: (folder: string) => Promise<ReadonlyArray<DiscoveredFile>>
  readonly discoverRecursive: (
    rootDir: string,
    config?: RecursiveDiscoveryConfig
  ) => Promise<ReadonlyArray<DiscoveredProjectFile>>
  readonly autoDiscover: (path: string) => Promise<AutoDiscoverConfig | null>
  readonly image: (path: string) => Promise<string | null>
  readonly trustRoot: (root: string) => Promise<void>
  readonly untrustRoot: (root: string) => Promise<void>
  readonly trustedRoots: () => Promise<ReadonlyArray<string>>
  readonly answerReview: (reviewId: string, answer: ReviewAnswer) => Promise<void>
}

export type WorkspaceFilesGroup = DerivedClient['workspaceFiles']
type GroupCall = <A>(run: (group: WorkspaceFilesGroup) => Effect.Effect<A, unknown>) => Promise<A>

export function workspaceFilesClient(callApi: Call): WorkspaceFilesClient {
  const call: GroupCall = (run) => callApi((c) => run(c.workspaceFiles))
  const done = (): undefined => undefined
  return {
    read: (path, options) =>
      call((g) =>
        g.read({
          payload: {
            path,
            ...(options?.rootDir !== undefined && { rootDir: options.rootDir }),
            ...(options?.requestId !== undefined && { requestId: options.requestId })
          }
        })
      ),
    write: (path, data, rootDir) =>
      call((g) =>
        g.write({ payload: { path, data, ...(rootDir !== undefined && { rootDir }) } })
      ).then(done),
    watch: (path) => call((g) => g.watch({ payload: { path } })).then(done),
    unwatch: (path) => call((g) => g.unwatch({ payload: { path } })).then(done),
    exists: (path) => call((g) => g.exists({ payload: { path } })),
    discover: (folder) => call((g) => g.discover({ payload: { folder } })),
    // A GET's parameters: only what is set, as the strings the wire carries.
    discoverRecursive: (rootDir, config) =>
      call((g) =>
        g.discoverRecursive({
          payload: {
            rootDir,
            ...(config?.patterns !== undefined && { patterns: config.patterns }),
            ...(config?.exclude !== undefined && { exclude: config.exclude }),
            ...(config?.maxDepth !== undefined && { maxDepth: String(config.maxDepth) }),
            ...(config?.workspaceId !== undefined && { workspaceId: config.workspaceId })
          }
        })
      ),
    autoDiscover: (path) => call((g) => g.autoDiscover({ payload: { path } })),
    image: (path) => call((g) => g.image({ payload: { path } })),
    trustRoot: (root) => call((g) => g.trustRoot({ payload: { root } })).then(done),
    untrustRoot: (root) => call((g) => g.untrustRoot({ payload: { root } })).then(done),
    trustedRoots: () => call((g) => g.trustedRoots({ payload: {} })),
    answerReview: (reviewId, answer) =>
      call((g) => g.answerReview({ payload: { reviewId, ...answer } })).then(done)
  }
}
