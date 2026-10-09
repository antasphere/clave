/**
 * The HTTP API implemented: every endpoint of `@clave/contract/api` handled
 * through the framework's CQRS bridge, so the bus validates, authorizes and
 * traces a call the same way whatever transport brought it. One `<Domain>Live`
 * group per domain, one line each in `ApiLive`; a lane adds its own.
 */
import { Layer } from 'effect'
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { Health, HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import { ListClients, RegisterClient, UnregisterClient } from '@clave/contract/clients'
import {
  GetSession,
  GetSessionCapabilities,
  GetSessionCommands,
  GetSessionHistory,
  GetSessionModels,
  ListSessions,
  SetSessionView,
  ResizeSession,
  StartSession,
  StopSession,
  WriteSession
} from '@clave/contract/sessions'
import { SettingsLive } from './settings/api'
import { WorkspaceFilesLive } from './workspace-files/api'
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
    .handle('capabilities', HttpCqrs.query(GetSessionCapabilities))
    .handle('history', HttpCqrs.query(GetSessionHistory))
)

// ── Lane A: the clients the shell registers as ──
export const ClientsLive = HttpApiBuilder.group(ClaveApi, 'clients', (handlers) =>
  handlers
    .handle('register', HttpCqrs.command(RegisterClient))
    .handle('list', HttpCqrs.query(ListClients))
    .handle('unregister', HttpCqrs.command(UnregisterClient))
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
      HealthLive
    )
  )
)
