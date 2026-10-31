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
import { Effect, Layer, Option } from 'effect'
import * as HttpIncomingMessage from '@effect/platform/HttpIncomingMessage'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import type * as HttpApi from '@effect/platform/HttpApi'
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import type * as HttpApp from '@effect/platform/HttpApp'
import type * as HttpServer from '@effect/platform/HttpServer'
import type * as HttpRouter from '@effect/platform/HttpRouter'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { type EventStore, InMemoryAll } from '@structure-ai/eventsourcing'
import { defaultErrorResponse, Middleware } from '@structure-ai/http'
import { Readiness } from '@structure-ai/runtime'
import { Correlation } from '@structure-ai/observability'
import { ApiLive } from './api'
import { bearerAuth } from './auth'
import { privateAnswerPath } from './requests/answer-route'
import { corsForLoopback } from './cors'
import { ClientRegistry, clientHandlers } from './clients'
import { ServerEvents } from './events'
import { PortsLive, type ServerPorts, SessionHost, SettingsSource, Terminals } from './ports'
import { PushHubService, pushRoute } from './push/route'
import { fixtureRoute } from './fixtures/route'
import { sessionHandlers } from './sessions'
import { SettingsEventsLive, WorkspacesWelcomeLive, settingsHandlers } from './settings'
import { SidebarEventsLive, SidebarLayoutsPort, sidebarHandlers } from './sidebar'
import {
  ReviewDesk,
  WorkspaceFilesEventsLive,
  WorkspaceFilesPort,
  workspaceFilesHandlers
} from './workspace-files'
import { ViewRequests, viewHandlers } from './views'
import { FilesPort, FilesEventsLive, fileHandlers } from './files'
import { RequestsPort } from './requests/port'
import { RequestEventsLive, requestHandlers } from './requests/handlers'
// ── Wave 4, lane C: the agent tools' tokens ──
import { AgentTokens, agentToolsHandlers } from './agent-tools'
// ── Wave 5, lane C: the plugins ──
import { Plugins, PluginsEventsLive, pluginHandlers } from './plugins'
// ── Wave wcs1023, lane C: the git domain ──
import { GitEventsLive, GitPort, gitHandlers } from './git'
// ── Issue #266: the server's version and its self-upgrade ──
import { ServerInfoEventsLive, ServerInfoPort, serverInfoHandlers } from './server-info'

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
  /** Wave 3, lane A: how long a `.clave` review waits for its answer before
   *  it reads as Cancel. Five minutes by default. */
  readonly reviewTimeoutMs?: number
}

export type ServerServices =
  | RequestsPort
  | FilesPort
  | ServerEvents
  | ClientRegistry
  | Readiness
  | SessionHost
  | SettingsSource
  | Terminals
  | PushHubService
  | EventStore
  | SidebarLayoutsPort
  | WorkspaceFilesPort
  | ReviewDesk
  // ── Lane D (wave 3): the view requests ──
  | ViewRequests
  // ── Wave 4, lane C: the agent tools' tokens ──
  | AgentTokens
  // ── Wave 5, lane C: the plugins ──
  | Plugins
  // ── Wave wcs1023, lane C: the git domain ──
  | GitPort
  // ── Issue #266: the server domain ──
  | ServerInfoPort

/** Everything but the listener. */
export const ServicesLive = (options: ServerOptions): Layer.Layer<ServerServices> => {
  const foundations = Layer.mergeAll(
    PortsLive(options.ports),
    // ── Lane A: the clients the shell registers as ──
    ClientRegistry.layer,
    // ── Lane B: terminals · Lane C: sidebar · Lane D: settings ──
    Readiness.layer,
    InMemoryAll,
    // ── Wave 3, lane A: the reviews a `.clave` read waits on ──
    ReviewDesk.layer({
      ...(options.reviewTimeoutMs !== undefined && { timeoutMs: options.reviewTimeoutMs })
    })
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
  // ── Wave 3, lane A: a watched `.clave` file's changes told to the clients ──
  const workspaceFilesEvents = WorkspaceFilesEventsLive.pipe(Layer.provide(services))
  // ── Lane D (wave 3): the view requests, pushed through the hub ──
  const views = ViewRequests.layer.pipe(Layer.provide(hub))
  // ── Wave 5, lane C: the plugins' news goes out as server events ──
  const pluginsEvents = PluginsEventsLive.pipe(Layer.provide(services))
  // ── Wave wcs1023, lane B: each socket hears the workspace list at its welcome ──
  const workspacesWelcome = WorkspacesWelcomeLive.pipe(Layer.provide(Layer.merge(services, hub)))
  // ── Wave wcs1023, lane C: a watched repository's changes and a batch's progress told to the clients ──
  const gitEvents = GitEventsLive.pipe(Layer.provide(services))
  // ── Wave wcs1023, lane D: a watched folder's changes told to the clients ──
  const filesEvents = FilesEventsLive.pipe(Layer.provide(services))
  const requestEvents = RequestEventsLive.pipe(Layer.provide(services))
  // ── Issue #266: the self-upgrade's state told to the clients ──
  const serverInfoEvents = ServerInfoEventsLive.pipe(Layer.provide(services))
  return Layer.mergeAll(
    services,
    requestEvents,
    filesEvents,
    hub,
    settingsEvents,
    sidebarEvents,
    terminalsReady,
    workspaceFilesEvents,
    views,
    // ── Wave 5, lane C: the plugins ──
    pluginsEvents,
    // ── Wave wcs1023, lane B ──
    workspacesWelcome,
    // ── Wave wcs1023, lane C: the git domain ──
    gitEvents,
    // ── Issue #266: the server domain ──
    serverInfoEvents
  )
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
      ...requestHandlers,
      ...fileHandlers,
      ...clientHandlers,
      // ── Lane D: settings ──
      ...settingsHandlers,
      // ── Lane C: the sidebar ──
      ...sidebarHandlers,
      // ── Wave 3, lane A: the workspace files ──
      ...workspaceFilesHandlers,
      // ── Lane D (wave 3): the view requests ──
      ...viewHandlers,
      // ── Wave 4, lane C: the agent tools' tokens ──
      ...agentToolsHandlers,
      // ── Wave 5, lane C: the plugins ──
      ...pluginHandlers,
      // ── Wave wcs1023, lane C: the git domain ──
      ...gitHandlers,
      // ── Issue #266: the server domain ──
      ...serverInfoHandlers
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
        pushRoute(hub)(
          bearerAuth(options.token)(
            fixtureRoute(options.testFixtures === true)(boundedFileRequest(privateAnswerJson(app)))
          )
        )
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

/** Bound transfer and sensitive resolution bodies before JSON decoding.
 * Authentication runs first; oversized secret inputs are never echoed. */
const boundedFileRequest = (app: HttpApp.Default): HttpApp.Default =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const limit =
      request.url.startsWith('/requests/') || privateAnswerPath(request.url) === '/requests/resolve'
        ? 64 * 1024
        : request.url.startsWith('/files/')
          ? 7 * 1024 * 1024
          : undefined
    if (limit === undefined) return app
    const length = Number(request.headers['content-length'])
    if (Number.isFinite(length) && length > limit)
      return Effect.succeed(HttpServerResponse.empty({ status: 413 }))
    return HttpIncomingMessage.withMaxBodySize(app, Option.some(limit))
  })

/** Node's JSON.parse SyntaxError can quote private input. Handle syntax before
 * the framework turns it into a logged defect. The cached body is decoded by
 * the normal API schema afterward; unrelated routes and defects stay intact. */
const privateAnswerJson = (app: HttpApp.Default): HttpApp.Default =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== 'POST' || privateAnswerPath(request.url) === undefined) return yield* app
    const contentType = request.headers['content-type']?.toLowerCase().trim() ?? 'application/json'
    if (!contentType.includes('application/json')) return yield* app
    const text = yield* request.text.pipe(
      Effect.catchTag('RequestError', () => Effect.succeed(undefined))
    )
    let valid = text !== undefined
    if (text) {
      try {
        JSON.parse(text)
      } catch {
        valid = false
      }
    }
    if (!valid) {
      return yield* Middleware.correlation(
        Effect.gen(function* () {
          const context = yield* Correlation.current
          yield* Effect.logWarning('Invalid private answer JSON body')
          return HttpServerResponse.setHeaders(
            defaultErrorResponse(undefined, context.correlationId),
            {
              ...(context.requestId && { 'x-request-id': context.requestId }),
              ...(context.correlationId && { 'x-correlation-id': context.correlationId })
            }
          )
        })
      )
    }
    return yield* app
  })
