/**
 * The artefacts' news, published as server events (PRDCT-4472): a session's
 * artefact opened or closed, its preview died under its holders, the
 * Slideless command line changed state. One subscription for the life of the
 * server, released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { ArtefactsPort } from './port'

export const ArtefactsEventsLive: Layer.Layer<never, never, ServerEvents | ArtefactsPort> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const artefacts = yield* ArtefactsPort
      const off = artefacts.subscribe((event) => {
        Effect.runFork(
          events
            .publish(event)
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] artefacts event not published', cause)
                )
              )
            )
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
