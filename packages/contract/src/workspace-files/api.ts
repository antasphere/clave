/**
 * The workspace files domain as one group of the HTTP API (`../api.ts` adds
 * it to `ClaveApi`): commands as POST endpoints, queries as GET endpoints,
 * through the framework's CQRS bridge. The paths name the files and the
 * trust; every definition is the one `model.ts` exports (`index.ts` gathers
 * both; the group is kept apart so the module and the group never import
 * each other in a cycle).
 */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  AnswerWorkspaceFileReview,
  DiscoverWorkspaceFiles,
  DiscoverWorkspaceFilesRecursive,
  ListTrustedRoots,
  ReadAutoDiscoverConfig,
  ReadWorkspaceFile,
  ReadWorkspaceImage,
  TrustWorkspaceRoot,
  UntrustWorkspaceRoot,
  UnwatchWorkspaceFile,
  WatchWorkspaceFile,
  WorkspaceFileExists,
  WriteWorkspaceFile
} from './model'

export const workspaceFilesGroup = ApiGroup.make('workspaceFiles')
  .add(HttpCqrs.commandEndpoint('read', '/workspace-files/read', ReadWorkspaceFile))
  .add(HttpCqrs.commandEndpoint('write', '/workspace-files/write', WriteWorkspaceFile))
  .add(HttpCqrs.commandEndpoint('watch', '/workspace-files/watch', WatchWorkspaceFile))
  .add(HttpCqrs.commandEndpoint('unwatch', '/workspace-files/unwatch', UnwatchWorkspaceFile))
  .add(HttpCqrs.queryEndpoint('exists', '/workspace-files/exists', WorkspaceFileExists))
  .add(HttpCqrs.queryEndpoint('discover', '/workspace-files/discover', DiscoverWorkspaceFiles))
  .add(
    HttpCqrs.queryEndpoint(
      'discoverRecursive',
      '/workspace-files/discover-recursive',
      DiscoverWorkspaceFilesRecursive
    )
  )
  .add(
    HttpCqrs.queryEndpoint('autoDiscover', '/workspace-files/auto-discover', ReadAutoDiscoverConfig)
  )
  .add(HttpCqrs.queryEndpoint('image', '/workspace-files/image', ReadWorkspaceImage))
  .add(HttpCqrs.commandEndpoint('trustRoot', '/workspace-files/trust/roots', TrustWorkspaceRoot))
  .add(
    HttpCqrs.commandEndpoint(
      'untrustRoot',
      '/workspace-files/trust/roots/remove',
      UntrustWorkspaceRoot
    )
  )
  .add(HttpCqrs.queryEndpoint('trustedRoots', '/workspace-files/trust/roots', ListTrustedRoots))
  .add(
    HttpCqrs.commandEndpoint(
      'answerReview',
      '/workspace-files/review/answer',
      AnswerWorkspaceFileReview
    )
  )
