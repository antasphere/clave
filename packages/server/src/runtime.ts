/**
 * The server composed, runtime-agnostic: the buses over the handlers, the
 * event store, the client registry, readiness, the API and the push hub,
 * served by whatever `HttpServer` the entry provides. `embedded.ts` gives it
 * Node's server for the in-process shape of this wave; a standalone entry
 * gives it Bun's and nothing else changes.
 */
import { Effect, Layer } from 'effect'
import type * as HttpApi from '@effect/platform/HttpApi'
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import type * as HttpApp from '@effect/platform/HttpApp'
import type * as HttpServer from '@effect/platform/HttpServer'
import type * as HttpRouter from '@effect/platform/HttpRouter'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { type EventStore, InMemoryAll } from '@structure-ai/eventsourcing'
import { Middleware } from '@structure-ai/http'
import { Readiness } from '@structure-ai/runtime'
import { ApiLive } from './api'
import { bearerAuth } from './auth'
import { corsForLoopback } from './cors'
import { ClientRegistry, clientHandlers } from './clients'
import { ServerEvents } from './events'
import { SessionSource, type SessionSourceService } from './ports'
import { PushHubService, pushRoute } from './push/route'
import { sessionHandlers } from './sessions'

export interface ServerOptions {
  /** The bearer token every request and every push hello must present. */
  readonly token: string
  /** Names this server in the `welcome` frame and in its event stream. */
  readonly serverId: string
  readonly sessions: SessionSourceService
  /** How long a push peer has to say hello. The contract's default otherwise. */
  readonly helloTimeoutMs?: number
}

export type ServerServices =
  | ServerEvents
  | ClientRegistry
  | Readiness
  | SessionSource
  | PushHubService
  | EventStore

/** Everything but the listener. */
export const ServicesLive = (options: ServerOptions): Layer.Layer<ServerServices> => {
  const foundations = Layer.mergeAll(
    SessionSource.layer(options.sessions),
    ClientRegistry.layer,
    Readiness.layer,
    InMemoryAll
  )
  const events = ServerEvents.layer(options.serverId).pipe(Layer.provide(foundations))
  const services = Layer.mergeAll(foundations, events)
  const hub = PushHubService.layer(options).pipe(Layer.provide(services))
  return Layer.mergeAll(services, hub)
}

/** The buses, with every handler of every domain registered once. */
export const BusesLive = busesLayer.pipe(
  Layer.provide(HandlerRegistry.layer(...sessionHandlers, ...clientHandlers))
)

/** The middleware outside the router, outermost first: the loopback CORS
 *  answer, the push upgrade, then the token check. */
const outer =
  (token: string) =>
  (app: HttpApp.Default): HttpApp.Default<never, PushHubService> =>
    Effect.flatMap(PushHubService, (hub) => corsForLoopback(pushRoute(hub)(bearerAuth(token)(app))))

/**
 * The served API over the services, needing only an `HttpServer` (and the
 * platform services that come with one). The services stay in the output so
 * an entry can reach readiness, the events and the hub.
 */
export const ServerLive = (
  options: ServerOptions
): Layer.Layer<
  ServerServices,
  never,
  HttpServer.HttpServer | HttpRouter.HttpRouter.DefaultServices
> => {
  const services = ServicesLive(options)
  const api: Layer.Layer<HttpApi.Api, never, ServerServices> = ApiLive.pipe(
    Layer.provide(BusesLive.pipe(Layer.provide(services)))
  )
  return HttpApiBuilder.serve(outer(options.token)).pipe(
    Layer.provide(Middleware.layer),
    Layer.provide(api),
    Layer.provideMerge(services)
  )
}
