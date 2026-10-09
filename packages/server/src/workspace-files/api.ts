/** The workspace files group of the HTTP API implemented, every endpoint of
 *  `@clave/contract/workspace-files/api` through the CQRS bridge. */
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import * as W from '@clave/contract/workspace-files'

export const WorkspaceFilesLive = HttpApiBuilder.group(ClaveApi, 'workspaceFiles', (handlers) =>
  handlers
    .handle('read', HttpCqrs.command(W.ReadWorkspaceFile))
    .handle('write', HttpCqrs.command(W.WriteWorkspaceFile))
    .handle('watch', HttpCqrs.command(W.WatchWorkspaceFile))
    .handle('unwatch', HttpCqrs.command(W.UnwatchWorkspaceFile))
    .handle('exists', HttpCqrs.query(W.WorkspaceFileExists))
    .handle('discover', HttpCqrs.query(W.DiscoverWorkspaceFiles))
    .handle('discoverRecursive', HttpCqrs.query(W.DiscoverWorkspaceFilesRecursive))
    .handle('autoDiscover', HttpCqrs.query(W.ReadAutoDiscoverConfig))
    .handle('image', HttpCqrs.query(W.ReadWorkspaceImage))
    .handle('trustRoot', HttpCqrs.command(W.TrustWorkspaceRoot))
    .handle('untrustRoot', HttpCqrs.command(W.UntrustWorkspaceRoot))
    .handle('trustedRoots', HttpCqrs.query(W.ListTrustedRoots))
    .handle('answerReview', HttpCqrs.command(W.AnswerWorkspaceFileReview))
)
