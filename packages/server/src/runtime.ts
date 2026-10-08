/**
 * The server composed, runtime-agnostic: the buses over the handlers, the
 * event store, the client registry, readiness, the API and the push hub,
 * served by whatever `HttpServer` the entry provides. `embedded.ts` gives it
 * Node's server for the in-process shape; a standalone entry gives it Bun's
 * and nothing else changes.
 *
 * The pattern, per domain: its port comes in through `ports` (`ports.ts`),
 * its handlers are one spread in `BusesLive`, its services one line in
 * `ServicesLive`. A lane adds its lines in its section and edits no other.
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
import { PortsLive, type ServerPorts, SessionHost, SettingsSource, Terminals } from './ports'
import { PushHubService, pushRoute } from './push/route'
import { fixtureRoute } from './fixtures/route'
import { sessionHandlers } from './sessions'
import { SettingsEventsLive, settingsHandlers } from './settings'
import { SidebarEventsLive, SidebarLayoutsPort, sidebarHandlers } from './sidebar'

export interface ServerOptions {
  /** The bearer token every request and every push hello must present. */
  readonly token: string
  /** Names this server in the `welcome` frame and in its event stream. */
  readonly serverId: string
  /** What the entry can do, one port per domain; a domain's `none` otherwise. */
  readonly ports: ServerPorts
  /** How long a push peer has to say hello. The contract's default otherwise. */
  readonly helloTimeoutMs?: number
  /** Lane C of wave 3: register the end-to-end fixture route (`fixtures/route.ts`),
   *  which runs code it is sent. TEST MODE ONLY: off by default, and the
   *  packaged app never turns it on. */
  readonly testFixtures?: boolean
}

export type ServerServices =
  | ServerEvents
  | ClientRegistry
  | Readiness
  | SessionHost
  | SettingsSource
  | Terminals
  | PushHubService
  | EventStore
  | SidebarLayoutsPort

/** Everything but the listener. */
export const ServicesLive = (options: ServerOptions): Layer.Layer<ServerServices> => {
  const foundations = Layer.mergeAll(
    PortsLive(options.ports),
    // ── Lane A: the clients the shell registers as ──
    ClientRegistry.layer,
    // ── Lane B: terminals · Lane C: sidebar · Lane D: settings ──
    Readiness.layer,
    InMemoryAll
  )
  const events = ServerEvents.layer(options.serverId).pipe(Layer.provide(foundations))
  const services = Layer.mergeAll(foundations, events)
  const hub = PushHubService.layer(options).pipe(Layer.provide(services))
  // ── Lane D: the settings source's changes go out as server events ──
  const settingsEvents = SettingsEventsLive.pipe(Layer.provide(services))
  // ── Lane C: every change of the layouts told to the clients ──
  const sidebarEvents = SidebarEventsLive.pipe(Layer.provide(services))
  // ── Lane B: a terminals port over a wire is a readiness check ──
  const terminalsReady = TerminalsReadyLive.pipe(Layer.provide(services))
  return Layer.mergeAll(services, hub, settingsEvents, sidebarEvents, terminalsReady)
}

/** The `terminals` check of `/health/ready`: whether the terminal process
 *  answers, when the port has one to ask (`TerminalsService.ready`); a port
 *  in this process registers nothing. */
const TerminalsReadyLive: Layer.Layer<never, never, Terminals | Readiness> = Layer.effectDiscard(
  Effect.gen(function* () {
    const terminals = yield* Terminals
    const readiness = yield* Readiness
    const ready = terminals.ready
    if (ready === undefined) return
    yield* readiness.register({ name: 'terminals', run: Effect.promise(() => ready()) })
  })
)

/** The buses, with every handler of every domain registered once. */
export const BusesLive = busesLayer.pipe(
  Layer.provide(
    HandlerRegistry.layer(
      ...sessionHandlers,
      ...clientHandlers,
      // ── Lane D: settings ──
      ...settingsHandlers,
      // ── Lane C: the sidebar ──
      ...sidebarHandlers
      // ── Lane B: ...terminalHandlers ──
    )
  )
)

/** The middleware outside the router, outermost first: the loopback CORS
 *  answer, the push upgrade, then the token check, then (test mode only)
 *  the fixture route, inside the token check so it is never open. */
const outer =
  (options: ServerOptions) =>
  (app: HttpApp.Default): HttpApp.Default<never, PushHubService> =>
    Effect.flatMap(PushHubService, (hub) =>
      corsForLoopback(
        pushRoute(hub)(bearerAuth(options.token)(fixtureRoute(options.testFixtures === true)(app)))
      )
    )

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
  return HttpApiBuilder.serve(outer(options)).pipe(
    Layer.provide(Middleware.layer),
    Layer.provide(api),
    Layer.provideMerge(services)
  )
}
