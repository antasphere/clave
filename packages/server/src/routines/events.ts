/**
 * The scheduler's news, published as server events (ADR 0004): the routines,
 * their next occurrence or their runs changed, and every window re-lists.
 * One subscription for the life of the server, released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { Routines } from './port'

export const RoutinesEventsLive: Layer.Layer<never, never, ServerEvents | Routines> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const routines = yield* Routines
      const off = routines.subscribe((event) => {
        Effect.runFork(
          events
            .publish(event)
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] routines event not published', cause)
                )
              )
            )
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
