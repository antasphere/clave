/**
 * The in-process entry: Electron main starts the server here (and the
 * standalone entry too, under Bun), on Node's own http server, loopback, a
 * random port and a fresh token, and gets back the address the clients read
 * and the handle it stops the server with.
 *
 * The listener is this entry's own (`createServer()` below, handed to the
 * platform layer), so the stop can act on it in the order a quit needs
 * (`stopEmbedded`): stop accepting, answer what was accepted, tell the push
 * peers, close the scope, and only then end whatever a client still holds.
 * Wave 3 measured the other order (the hub closed first, the listener left
 * accepting, the Node server's close waiting on the window's connections)
 * at ten seconds per quit: exactly the client's request deadline.
 */
import { createServer, type Server as NodeServer } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { Context, Effect, Exit, Layer, LogLevel, Logger, Scope } from 'effect'
import * as HttpServer from '@effect/platform/HttpServer'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { Readiness } from '@structure-ai/runtime'
import type { ServerEvent } from '@clave/contract/events'
import { CLOSE_SERVER_STOPPING } from '@clave/contract/push'
import { ServerEvents } from './events'
import type { ServerPorts } from './ports'
import type { PushHub } from './push/hub'
import { PushHubService } from './push/route'
import { ServerLive } from './runtime'

export interface EmbeddedOptions {
  /** What this entry can do, one port per domain (`ports.ts`). */
  readonly ports: ServerPorts
  /** Loopback unless told otherwise; nothing here is meant for a network. */
  readonly host?: string
  /** 0, the default, takes a free port. */
  readonly port?: number
  /** A token to reuse across restarts; a fresh one otherwise. */
  readonly token?: string
  readonly helloTimeoutMs?: number
  /** Wave 3, lane A: how long a `.clave` review waits for its answer (`runtime.ts`). */
  readonly reviewTimeoutMs?: number
  /** Log at and above this level; warnings only by default, requests are not logged. */
  readonly logLevel?: LogLevel.LogLevel
  /** The end-to-end fixture route, test mode only (`runtime.ts`). */
  readonly testFixtures?: boolean
  /** Wave 4, lane A: how long the stop lets the requests already accepted
   *  finish before the handlers go (`STOP_DRAIN_MS` by default), and how
   *  long it gives a push peer to answer the close frame before its socket
   *  is ended (`STOP_PEER_GRACE_MS`). Tests shorten both. */
  readonly stopDrainMs?: number
  readonly stopPeerGraceMs?: number
}

/** What a stop did, for the log of whoever stopped the server. */
export interface StopReport {
  /** How long the whole stop took. */
  readonly ms: number
  /** Requests in flight when the stop began. */
  readonly inFlight: number
  /** Whether every one of them was answered before the handlers went. */
  readonly drained: boolean
  /** Push peers told the server was stopping. */
  readonly peers: number
  /** Connections a client still held once everything was closed, destroyed here. */
  readonly destroyed: number
}

export interface EmbeddedServer {
  readonly url: string
  readonly token: string
  readonly serverId: string
  /** Tell every attached client something happened. */
  readonly publish: (event: ServerEvent) => Promise<void>
  /** How many push peers are attached and welcomed right now. */
  readonly connections: () => number
  /** Stop, in the order `stopEmbedded` says; idempotent, the same report twice. */
  readonly stop: () => Promise<StopReport>
}

/** A request already accepted gets this long to be answered before the handlers go. */
export const STOP_DRAIN_MS = 1000
/** A push peer gets this long to answer the close frame before its socket is ended. */
export const STOP_PEER_GRACE_MS = 250

export async function startEmbedded(options: EmbeddedOptions): Promise<EmbeddedServer> {
  const token = options.token ?? randomBytes(32).toString('hex')
  const serverId = randomUUID()
  const host = options.host ?? '127.0.0.1'
  const node = createServer()
  const connections = trackConnections(node)
  const layer = ServerLive({
    token,
    serverId,
    ports: options.ports,
    ...(options.helloTimeoutMs !== undefined && { helloTimeoutMs: options.helloTimeoutMs }),
    ...(options.testFixtures !== undefined && { testFixtures: options.testFixtures }),
    ...(options.reviewTimeoutMs !== undefined && { reviewTimeoutMs: options.reviewTimeoutMs })
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => node, { port: options.port ?? 0, host })),
    Layer.provide(Logger.minimumLogLevel(options.logLevel ?? LogLevel.Warning))
  )
  const scope = Effect.runSync(Scope.make())
  try {
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
    const address = Context.get(context, HttpServer.HttpServer).address
    if (address._tag !== 'TcpAddress') throw new Error('The embedded server needs a TCP address')
    const events = Context.get(context, ServerEvents)
    const hub = Context.get(context, PushHubService)
    await Effect.runPromise(Context.get(context, Readiness).setReady)
    let stopping: Promise<StopReport> | null = null
    return {
      url: `http://${host}:${address.port}`,
      token,
      serverId,
      publish: (event) => Effect.runPromise(events.publish(event)).then(() => undefined),
      connections: () => hub.connections,
      stop: () =>
        (stopping ??= stopEmbedded({
          node,
          connections,
          hub,
          scope,
          drainMs: options.stopDrainMs ?? STOP_DRAIN_MS,
          peerGraceMs: options.stopPeerGraceMs ?? STOP_PEER_GRACE_MS
        }))
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}

/** What the listener has open: every socket it accepted, which of them were
 *  upgraded to the push channel, and how many requests are in flight. */
interface Connections {
  readonly sockets: Set<Socket>
  readonly upgraded: Set<Socket>
  readonly inFlight: () => number
  /** Resolves once no request is in flight, or after `ms`; says which. */
  readonly drained: (ms: number) => Promise<boolean>
  /** Resolves once no upgraded socket is open, or after `ms`; says which. */
  readonly peersGone: (ms: number) => Promise<boolean>
}

function trackConnections(node: NodeServer): Connections {
  const sockets = new Set<Socket>()
  const upgraded = new Set<Socket>()
  let inFlight = 0
  const watchers = new Set<() => void>()
  const changed = (): void => {
    for (const watch of [...watchers]) watch()
  }
  node.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      upgraded.delete(socket)
      changed()
    })
  })
  node.on('upgrade', (_request, socket: Socket) => {
    upgraded.add(socket)
  })
  node.on('request', (_request, response) => {
    inFlight += 1
    // 'close' follows a finished response as much as a dropped connection.
    response.once('close', () => {
      inFlight -= 1
      changed()
    })
  })
  const until = (done: () => boolean, ms: number): Promise<boolean> => {
    if (done()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const watch = (): void => {
        if (!done()) return
        clearTimeout(timer)
        watchers.delete(watch)
        resolve(true)
      }
      const timer = setTimeout(() => {
        watchers.delete(watch)
        resolve(done())
      }, ms)
      watchers.add(watch)
    })
  }
  return {
    sockets,
    upgraded,
    inFlight: () => inFlight,
    drained: (ms) => until(() => inFlight === 0, ms),
    peersGone: (ms) => until(() => upgraded.size === 0, ms)
  }
}

/**
 * The stop, in the order a quit needs (PRDCT-3375):
 *
 * 1. Stop accepting. The listener closes first, so a connection a client
 *    opens from here is refused at once; `listening` is false from this
 *    line, so the platform layer's own close, later, has nothing to wait on.
 * 2. Answer what was already accepted: the handlers stay attached until the
 *    scope closes, and the stop waits, bounded, for the requests in flight.
 * 3. Tell the push peers, with the code that says why, and give them a
 *    moment to answer the close frame; a peer that does not is ended here,
 *    because the ws server's close in the scope would otherwise wait on it
 *    for its own thirty seconds.
 * 4. Close the scope: handlers off, hub disposed, ws server closed.
 * 5. Destroy whatever a client still holds (a socket with a request the drain
 *    gave up on, a peer that never answered), so the listener's close can
 *    complete; the idle kept-alive sockets were already destroyed by Node's
 *    own close at step 1. A request that arrives on such a socket after
 *    step 4 is refused by the reset, never left hanging until the client's
 *    deadline.
 */
async function stopEmbedded(input: {
  node: NodeServer
  connections: Connections
  hub: PushHub
  scope: Scope.CloseableScope
  drainMs: number
  peerGraceMs: number
}): Promise<StopReport> {
  const { node, connections, hub, scope } = input
  const started = Date.now()
  const closed = new Promise<void>((resolve) => {
    if (!node.listening) return resolve()
    node.close(() => resolve())
  })
  const inFlight = connections.inFlight()
  const drained = await connections.drained(input.drainMs)
  const peers = hub.connections
  hub.closeAll(CLOSE_SERVER_STOPPING, 'server stopping')
  if (!(await connections.peersGone(input.peerGraceMs)))
    for (const socket of [...connections.upgraded]) socket.destroy()
  await Effect.runPromise(Scope.close(scope, Exit.void))
  // Node's own close already destroyed the idle kept-alive sockets at step 1
  // (their 'close' event may not have run yet); what is counted here is what
  // THIS step had to end: a socket with a request still on it, a peer that
  // never answered.
  const left = [...connections.sockets].filter((socket) => !socket.destroyed)
  for (const socket of left) socket.destroy()
  await closed
  return { ms: Date.now() - started, inFlight, drained, peers, destroyed: left.length }
}
