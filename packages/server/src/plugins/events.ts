/**
 * The plugins' news, published as server events: the records or their
 * running state changed, or a plugin notified and the entry shows no
 * notification itself. One subscription for the life of the server,
 * released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { Plugins } from './port'

export const PluginsEventsLive: Layer.Layer<never, never, ServerEvents | Plugins> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const plugins = yield* Plugins
      // `runFork` starts the fiber synchronously, so events keep their order.
      const off = plugins.subscribe((event) => {
        Effect.runFork(
          events
            .publish(event)
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] plugins event not published', cause)
                )
              )
            )
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
