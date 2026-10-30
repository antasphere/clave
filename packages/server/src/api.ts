/**
 * The HTTP API implemented: every endpoint of `@clave/contract/api` handled
 * through the framework's CQRS bridge, so the bus validates, authorizes and
 * traces a call the same way whatever transport brought it. One `<Domain>Live`
 * group per domain, one line each in `ApiLive`; a lane adds its own.
 */
import { GetSessionTimeline } from '@clave/contract/timeline'
import { Layer } from 'effect'
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { Health, HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import {
  ListClients,
  RegisterClient,
  UnregisterClient,
  ReserveClientRegistration,
  ConfirmClientRegistration,
  ReleaseClientRegistration
} from '@clave/contract/clients'
import {
  GetSession,
  GetSessionCapabilities,
  GetSessionCommands,
  ControlSession,
  GetSessionHistory,
  GetSessionModels,
  ListSessions,
  SetSessionView,
  ResizeSession,
  StartSession,
  StopSession,
  WriteSession,
  // ── Wave 4, lane C: the session records and a session's release ──
  DiscardSessionRecord,
  ListAdoptableRecords,
  ReleaseSessions,
  // ── Wave 4, lane D: the last agent tools ──
  ReadSessionScreen,
  RenameSession,
  KeepOnSessionRecord,
  RestartSession,
  SetSessionPage,
  TypeIntoSession,
  // ── The mobile wave, lane B: whether a client's message landed ──
  GetSessionWriteStatus
} from '@clave/contract/sessions'
import { AnswerViewRequest, RequestView } from '@clave/contract/views'
import { AnnounceAgentTools, ResolveAgentToken } from '@clave/contract/agent-tools'
// ── Wave 5, lane C: the plugins ──
import {
  DisablePlugin,
  EnablePlugin,
  GetPluginPanel,
  LeasePluginView,
  LinkPlugin,
  ListPluginSecretRequests,
  ListPlugins,
  RemovePlugin,
  ReplyPluginSecret,
  ReportPluginContext,
  RequestPluginView,
  RevokePluginView,
  RunPluginCommand
} from '@clave/contract/plugins'
import { SettingsLive } from './settings/api'
import { WorkspaceFilesLive } from './workspace-files/api'
import { FilesLive } from './files/api'
// ── Wave wcs1023, lane C: the git domain (`git/api.ts`) ──
import { GitLive } from './git/api'
// ── Issue #266: the server's version and its self-upgrade ──
import { GetServerInfo, RequestServerUpgrade } from '@clave/contract/server-info'
// ── Mobile wave, lane A: the devices (`devices/api.ts`) ──
import { DevicesLive } from './devices/api'
// ── The mobile wave, lane B: the push notifications ──
import { GetNotifyStatus, SendTestNotification } from '@clave/contract/notify'
import { ListPendingRequests, ResolvePendingRequest } from '../../contract/src/requests'

export const RequestsLive = HttpApiBuilder.group(ClaveApi, 'requests', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListPendingRequests))
    .handle('resolve', HttpCqrs.command(ResolvePendingRequest))
)
import {
  AbsorbLayout,
  AddGroupTerminal,
  CreateGroup,
  DeleteGroup,
  GetWindowLayout,
  ListWindowLayouts,
  MoveGroupToWindow,
  MoveItems,
  MoveSessionsToWindow,
  PlaceSession,
  RemoveGroupTerminal,
  RemoveSession,
  RenameGroup,
  SaveWindowLayout,
  SetGroupCollapsed,
  SetGroupColor,
  SetGroupPrompt,
  SetGroupView,
  UpdateGroupTerminal
} from '@clave/contract/sidebar'

// ── Lane A: sessions ──
export const SessionsLive = HttpApiBuilder.group(ClaveApi, 'sessions', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListSessions))
    .handle('get', HttpCqrs.query(GetSession))
    .handle('start', HttpCqrs.command(StartSession))
    .handle('stop', HttpCqrs.command(StopSession))
    .handle('write', HttpCqrs.command(WriteSession))
    .handle('resize', HttpCqrs.command(ResizeSession))
    .handle('setView', HttpCqrs.command(SetSessionView))
    .handle('models', HttpCqrs.query(GetSessionModels))
    .handle('commands', HttpCqrs.query(GetSessionCommands))
    .handle('control', HttpCqrs.command(ControlSession))
    .handle('capabilities', HttpCqrs.query(GetSessionCapabilities))
    .handle('history', HttpCqrs.query(GetSessionHistory))
    // ── Wave 4, lane C: the records a window brings back, their discard, a release for a move ──
    .handle('listAdoptable', HttpCqrs.query(ListAdoptableRecords))
    .handle('discardRecord', HttpCqrs.command(DiscardSessionRecord))
    .handle('release', HttpCqrs.command(ReleaseSessions))
    // ── Wave 4, lane D: the last agent tools ──
    .handle('rename', HttpCqrs.command(RenameSession))
    .handle('keepOnRecord', HttpCqrs.command(KeepOnSessionRecord))
    .handle('setPage', HttpCqrs.command(SetSessionPage))
    .handle('screen', HttpCqrs.query(ReadSessionScreen))
    .handle('type', HttpCqrs.command(TypeIntoSession))
    .handle('restart', HttpCqrs.command(RestartSession))
    // ── The mobile wave, lane B: whether a message a client minted an id for landed ──
    .handle('writeStatus', HttpCqrs.query(GetSessionWriteStatus))
    .handle('timeline', HttpCqrs.query(GetSessionTimeline))
)

// ── Lane A: the clients the shell registers as ──
export const ClientsLive = HttpApiBuilder.group(ClaveApi, 'clients', (handlers) =>
  handlers
    .handle('register', HttpCqrs.command(RegisterClient))
    .handle('list', HttpCqrs.query(ListClients))
    .handle('unregister', HttpCqrs.command(UnregisterClient))
    .handle('reserveRegistration', HttpCqrs.command(ReserveClientRegistration))
    .handle('confirmRegistration', HttpCqrs.command(ConfirmClientRegistration))
    .handle('releaseRegistration', HttpCqrs.command(ReleaseClientRegistration))
)

// ── Lane D: settings (`settings/api.ts`) ──
export { SettingsLive }

// ── Lane C: the sidebar ──
export const SidebarLive = HttpApiBuilder.group(ClaveApi, 'sidebar', (handlers) =>
  handlers
    .handle('getLayout', HttpCqrs.query(GetWindowLayout))
    .handle('listLayouts', HttpCqrs.query(ListWindowLayouts))
    .handle('saveLayout', HttpCqrs.command(SaveWindowLayout))
    .handle('createGroup', HttpCqrs.command(CreateGroup))
    .handle('renameGroup', HttpCqrs.command(RenameGroup))
    .handle('setGroupView', HttpCqrs.command(SetGroupView))
    .handle('setGroupColor', HttpCqrs.command(SetGroupColor))
    .handle('setGroupPrompt', HttpCqrs.command(SetGroupPrompt))
    .handle('setGroupCollapsed', HttpCqrs.command(SetGroupCollapsed))
    .handle('deleteGroup', HttpCqrs.command(DeleteGroup))
    .handle('addTerminal', HttpCqrs.command(AddGroupTerminal))
    .handle('updateTerminal', HttpCqrs.command(UpdateGroupTerminal))
    .handle('removeTerminal', HttpCqrs.command(RemoveGroupTerminal))
    .handle('moveItems', HttpCqrs.command(MoveItems))
    .handle('placeSession', HttpCqrs.command(PlaceSession))
    .handle('removeSession', HttpCqrs.command(RemoveSession))
    .handle('absorbLayout', HttpCqrs.command(AbsorbLayout))
    .handle('moveSessions', HttpCqrs.command(MoveSessionsToWindow))
    .handle('moveGroup', HttpCqrs.command(MoveGroupToWindow))
)

// ── Wave 3, lane A: the workspace files (`workspace-files/api.ts`) ──
export { WorkspaceFilesLive }
// ── Lane D (wave 3): the view requests ──
export const ViewsLive = HttpApiBuilder.group(ClaveApi, 'views', (handlers) =>
  handlers
    .handle('request', HttpCqrs.command(RequestView))
    .handle('answer', HttpCqrs.command(AnswerViewRequest))
)

// ── Wave 4, lane C: the agent tools' address and tokens ──
export const AgentToolsLive = HttpApiBuilder.group(ClaveApi, 'agentTools', (handlers) =>
  handlers
    .handle('announce', HttpCqrs.command(AnnounceAgentTools))
    .handle('resolveToken', HttpCqrs.command(ResolveAgentToken))
)

// ── Wave 5, lane C: the plugins ──
export const PluginsLive = HttpApiBuilder.group(ClaveApi, 'plugins', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListPlugins))
    .handle('panel', HttpCqrs.query(GetPluginPanel))
    .handle('secrets', HttpCqrs.query(ListPluginSecretRequests))
    .handle('enable', HttpCqrs.command(EnablePlugin))
    .handle('disable', HttpCqrs.command(DisablePlugin))
    .handle('link', HttpCqrs.command(LinkPlugin))
    .handle('remove', HttpCqrs.command(RemovePlugin))
    .handle('command', HttpCqrs.command(RunPluginCommand))
    .handle('context', HttpCqrs.command(ReportPluginContext))
    .handle('leaseView', HttpCqrs.command(LeasePluginView))
    .handle('requestView', HttpCqrs.command(RequestPluginView))
    .handle('revokeView', HttpCqrs.command(RevokePluginView))
    .handle('replySecret', HttpCqrs.command(ReplyPluginSecret))
)

// ── Wave wcs1023, lane C: the git domain ──
export { GitLive }

// ── Issue #266: the server domain, under the bearer token like every route ──
export const ServerInfoLive = HttpApiBuilder.group(ClaveApi, 'server', (handlers) =>
  handlers
    .handle('info', HttpCqrs.query(GetServerInfo))
    .handle('upgrade', HttpCqrs.command(RequestServerUpgrade))
)

// ── Mobile wave, lane A: the devices, a phone paired with this server ──
export { DevicesLive }
// ── The mobile wave, lane B: the notify domain, the owner's two routes ──
export const NotifyLive = HttpApiBuilder.group(ClaveApi, 'notify', (handlers) =>
  handlers
    .handle('status', HttpCqrs.query(GetNotifyStatus))
    .handle('test', HttpCqrs.command(SendTestNotification))
)

// ── Lane B: terminals ──

export const HealthLive = Health.layer(ClaveApi)

export const ApiLive = HttpApiBuilder.api(ClaveApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      SessionsLive,
      ClientsLive,
      SettingsLive,
      SidebarLive,
      WorkspaceFilesLive,
      FilesLive,
      RequestsLive,
      // ── Lane D (wave 3): the view requests ──
      ViewsLive,
      // ── Wave 4, lane C: the agent tools ──
      AgentToolsLive,
      // ── Wave 5, lane C: the plugins ──
      PluginsLive,
      // ── Wave wcs1023, lane C: the git domain ──
      GitLive,
      // ── Issue #266: the server domain ──
      ServerInfoLive,
      // ── Mobile wave, lane A: the devices ──
      DevicesLive,
      // ── The mobile wave, lane B: the notify domain ──
      NotifyLive,
      HealthLive
    )
  )
)
