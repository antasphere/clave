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
  StartSession,
  StopSession,
  WriteSession
} from '@clave/contract/sessions'
import { SettingsLive } from './settings/api'

// ── Lane A: sessions ──
export const SessionsLive = HttpApiBuilder.group(ClaveApi, 'sessions', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListSessions))
    .handle('get', HttpCqrs.query(GetSession))
    .handle('start', HttpCqrs.command(StartSession))
    .handle('stop', HttpCqrs.command(StopSession))
    .handle('write', HttpCqrs.command(WriteSession))
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

// ── Lane B: terminals · Lane C: sidebar ──

export const HealthLive = Health.layer(ClaveApi)

export const ApiLive = HttpApiBuilder.api(ClaveApi).pipe(
  Layer.provide(Layer.mergeAll(SessionsLive, ClientsLive, SettingsLive, HealthLive))
)
