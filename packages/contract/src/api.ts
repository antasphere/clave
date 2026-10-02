/**
 * The HTTP API, one group per domain, declared once and shared: the server
 * implements it with `HttpApiBuilder`, the client derives its calls from the
 * type, and a drift between the two is a type error, not a runtime surprise.
 * Commands are POST endpoints and queries GET endpoints through the
 * framework's CQRS bridge, so the bus validates, authorizes and traces every
 * call the same way whatever transport brought it.
 *
 * A lane adds its domain as one more group here, built from the definitions
 * of its own module file; nobody edits another lane's module.
 */
import { Api, ApiGroup, Health, HttpCqrs, annotate } from '@structure-ai/http'
import { ListClients, RegisterClient, UnregisterClient } from './clients'
import { GetSession, ListSessions, WriteSession } from './sessions'

export const sessionsGroup = ApiGroup.make('sessions')
  .add(HttpCqrs.queryEndpoint('list', '/sessions', ListSessions))
  .add(HttpCqrs.queryEndpoint('get', '/sessions/by-id', GetSession))
  .add(HttpCqrs.commandEndpoint('write', '/sessions/write', WriteSession))

export const clientsGroup = ApiGroup.make('clients')
  .add(HttpCqrs.commandEndpoint('register', '/clients', RegisterClient))
  .add(HttpCqrs.queryEndpoint('list', '/clients', ListClients))
  .add(HttpCqrs.commandEndpoint('unregister', '/clients/unregister', UnregisterClient))

export const ClaveApi = Api.make('clave')
  .add(sessionsGroup)
  .add(clientsGroup)
  .add(Health.group)
  .pipe(annotate({ title: 'Clave', version: '1', description: "Clave's server API" }))
export type ClaveApi = typeof ClaveApi
