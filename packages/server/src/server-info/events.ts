/**
 * Every change of the self-upgrade's state goes out as `server.upgrade_changed`
 * to every attached client (issue #266), the way the plugins' news does.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { ServerInfoPort } from './port'

export const ServerInfoEventsLive: Layer.Layer<never, never, ServerEvents | ServerInfoPort> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const info = yield* ServerInfoPort
      // `runFork` starts the fiber synchronously, so events keep their order.
      const off = info.subscribe((status) => {
        Effect.runFork(
          events
            .publish({ _tag: 'server.upgrade_changed', status })
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] upgrade event not published', cause)
                )
              )
            )
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
