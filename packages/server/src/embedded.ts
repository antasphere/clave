/**
 * The in-process entry: Electron main starts the server here (and the
 * standalone entry too, under Bun), on Node's own http server, loopback, a
 * random port and a fresh token, and gets back the address the clients read
 * and the handle it stops the server with.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Context, Effect, Exit, Layer, LogLevel, Logger, Scope } from 'effect'
import * as HttpServer from '@effect/platform/HttpServer'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { Readiness } from '@structure-ai/runtime'
import type { ServerEvent } from '@clave/contract/events'
import { CLOSE_SERVER_STOPPING } from '@clave/contract/push'
import { ServerEvents } from './events'
import type { ServerPorts } from './ports'
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
  /** Log at and above this level; warnings only by default, requests are not logged. */
  readonly logLevel?: LogLevel.LogLevel
  /** The end-to-end fixture route, test mode only (`runtime.ts`). */
  readonly testFixtures?: boolean
}

export interface EmbeddedServer {
  readonly url: string
  readonly token: string
  readonly serverId: string
  /** Tell every attached client something happened. */
  readonly publish: (event: ServerEvent) => Promise<void>
  /** How many push peers are attached and welcomed right now. */
  readonly connections: () => number
  readonly stop: () => Promise<void>
}

export async function startEmbedded(options: EmbeddedOptions): Promise<EmbeddedServer> {
  const token = options.token ?? randomBytes(32).toString('hex')
  const serverId = randomUUID()
  const host = options.host ?? '127.0.0.1'
  const layer = ServerLive({
    token,
    serverId,
    ports: options.ports,
    ...(options.helloTimeoutMs !== undefined && { helloTimeoutMs: options.helloTimeoutMs }),
    ...(options.testFixtures !== undefined && { testFixtures: options.testFixtures })
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => createServer(), { port: options.port ?? 0, host })
    ),
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
    return {
      url: `http://${host}:${address.port}`,
      token,
      serverId,
      publish: (event) => Effect.runPromise(events.publish(event)).then(() => undefined),
      connections: () => hub.connections,
      stop: async () => {
        hub.closeAll(CLOSE_SERVER_STOPPING, 'server stopping')
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
