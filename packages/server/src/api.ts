/**
 * The HTTP API implemented: every endpoint of `@clave/contract/api` handled
 * through the framework's CQRS bridge, so the bus validates, authorizes and
 * traces a call the same way whatever transport brought it.
 */
import { Layer } from 'effect'
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { Health, HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import { ListClients, RegisterClient, UnregisterClient } from '@clave/contract/clients'
import { GetSession, ListSessions, WriteSession } from '@clave/contract/sessions'

export const SessionsLive = HttpApiBuilder.group(ClaveApi, 'sessions', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListSessions))
    .handle('get', HttpCqrs.query(GetSession))
    .handle('write', HttpCqrs.command(WriteSession))
)

export const ClientsLive = HttpApiBuilder.group(ClaveApi, 'clients', (handlers) =>
  handlers
    .handle('register', HttpCqrs.command(RegisterClient))
    .handle('list', HttpCqrs.query(ListClients))
    .handle('unregister', HttpCqrs.command(UnregisterClient))
)

export const HealthLive = Health.layer(ClaveApi)

export const ApiLive = HttpApiBuilder.api(ClaveApi).pipe(
  Layer.provide(Layer.mergeAll(SessionsLive, ClientsLive, HealthLive))
)
