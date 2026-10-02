/**
 * The push channel on the listener: a request to `PUSH_PATH` is upgraded
 * through the platform's own socket (Node's and Bun's servers both answer
 * `HttpServerRequest.upgrade`), and the socket is handed to the hub. A
 * second WebSocket server on the same port is not an option: platform-node
 * already owns the server's upgrade event, and two handlers corrupt the frames.
 */
import { Context, Effect, Either, Layer, Runtime } from 'effect'
import * as Socket from '@effect/platform/Socket'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { PUSH_PATH } from '@clave/contract/push'
import { type Wrap, pathOf } from '../auth'
import { isLoopbackOrigin } from '../cors'
import { ServerEvents } from '../events'
import { SessionSource } from '../ports'
import { PushHub } from './hub'

export class PushHubService extends Context.Tag('@clave/server/PushHub')<
  PushHubService,
  PushHub
>() {
  static layer(options: {
    token: string
    serverId: string
    helloTimeoutMs?: number
  }): Layer.Layer<PushHubService, never, ServerEvents | SessionSource> {
    return Layer.scoped(
      PushHubService,
      Effect.gen(function* () {
        const events = yield* ServerEvents
        const source = yield* SessionSource
        const hub = new PushHub({ ...options, events, source })
        yield* Effect.addFinalizer(() => Effect.sync(() => hub.dispose()))
        return hub
      })
    )
  }
}

const utf8 = new TextDecoder()

export const pushRoute =
  (hub: PushHub): Wrap =>
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (pathOf(request.url) !== PUSH_PATH) return yield* app
      // A browser page sends its Origin on the handshake and the browser
      // applies no same-origin rule to a WebSocket: a page off this machine
      // is refused here. A client with no Origin (Node, the preload's own
      // socket) still proves itself with the hello token.
      const origin = request.headers['origin']
      if (origin !== undefined && !isLoopbackOrigin(origin))
        return HttpServerResponse.text('The push channel takes no page from off this machine.', {
          status: 403
        })
      const upgraded = yield* Effect.either(HttpServerRequest.upgrade)
      if (Either.isLeft(upgraded))
        return HttpServerResponse.text('The push channel is a WebSocket.', { status: 426 })
      const socket = upgraded.right
      yield* Effect.scoped(
        Effect.gen(function* () {
          const write = yield* socket.writer
          const runtime = yield* Effect.runtime<never>()
          const run = (effect: Effect.Effect<void, Socket.SocketError>): void => {
            Runtime.runFork(runtime)(Effect.ignore(effect))
          }
          const peer = hub.attach({
            send: (text) => run(write(text)),
            close: (code, reason) => run(write(new Socket.CloseEvent(code, reason)))
          })
          yield* socket
            .runRaw((data) => peer.onMessage(typeof data === 'string' ? data : utf8.decode(data)))
            .pipe(Effect.ensuring(Effect.sync(() => peer.onClose())))
        })
      ).pipe(
        // A peer that leaves, with any close code, is the end of its
        // connection and nothing more.
        Effect.catchAllCause(() => Effect.void)
      )
      return HttpServerResponse.empty()
    })
