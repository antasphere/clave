/**
 * The HTTP API, one group per domain, declared once and shared: the server
 * implements it with `HttpApiBuilder`, the client derives its calls from the
 * type, and a drift between the two is a type error, not a runtime surprise.
 * Commands are POST endpoints and queries GET endpoints through the
 * framework's CQRS bridge, so the bus validates, authorizes and traces every
 * call the same way whatever transport brought it.
 *
 * The pattern, per domain: one `<domain>Group` built from that domain's
 * module and nothing else, added to `ClaveApi` as one line. A lane adds its
 * group and its line; nobody edits another lane's group.
 */
import { Api, ApiGroup, Health, HttpCqrs, annotate } from '@structure-ai/http'
import { ListClients, RegisterClient, UnregisterClient } from './clients'
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
} from './sessions'

// ── Sessions (lane A) ──
export const sessionsGroup = ApiGroup.make('sessions')
  .add(HttpCqrs.queryEndpoint('list', '/sessions', ListSessions))
  .add(HttpCqrs.queryEndpoint('get', '/sessions/by-id', GetSession))
  .add(HttpCqrs.commandEndpoint('start', '/sessions/start', StartSession))
  .add(HttpCqrs.commandEndpoint('stop', '/sessions/stop', StopSession))
  .add(HttpCqrs.commandEndpoint('write', '/sessions/write', WriteSession))
  .add(HttpCqrs.commandEndpoint('setView', '/sessions/view', SetSessionView))
  .add(HttpCqrs.queryEndpoint('models', '/sessions/models', GetSessionModels))
  .add(HttpCqrs.queryEndpoint('commands', '/sessions/commands', GetSessionCommands))
  .add(HttpCqrs.queryEndpoint('capabilities', '/sessions/capabilities', GetSessionCapabilities))
  .add(HttpCqrs.queryEndpoint('history', '/sessions/history', GetSessionHistory))

// ── Clients (lane A, for the shell) ──
export const clientsGroup = ApiGroup.make('clients')
  .add(HttpCqrs.commandEndpoint('register', '/clients', RegisterClient))
  .add(HttpCqrs.queryEndpoint('list', '/clients', ListClients))
  .add(HttpCqrs.commandEndpoint('unregister', '/clients/unregister', UnregisterClient))

// ── Lane B: terminals · Lane C: sidebar · Lane D: settings ──

export const ClaveApi = Api.make('clave')
  .add(sessionsGroup)
  .add(clientsGroup)
  .add(Health.group)
  .pipe(annotate({ title: 'Clave', version: '1', description: "Clave's server API" }))
export type ClaveApi = typeof ClaveApi
