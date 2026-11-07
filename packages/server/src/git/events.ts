/**
 * The git domain's news, published as server events: a watched repository
 * changed on this server's disk, a batch moved. One subscription for the
 * life of the server, released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { GitPort } from './port'

export const GitEventsLive: Layer.Layer<never, never, ServerEvents | GitPort> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const events = yield* ServerEvents
    const git = yield* GitPort
    // `runFork` starts the fiber synchronously, so events keep their order.
    const off = git.subscribe((event) => {
      Effect.runFork(
        events
          .publish(event)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => console.error('[clave-server] git event not published', cause))
            )
          )
      )
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))
  })
)
