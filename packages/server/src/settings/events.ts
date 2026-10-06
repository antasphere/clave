/**
 * The settings source's changes, published as server events: an account
 * list that changed, a login job that progressed, a usage read that landed,
 * a workspace state that was written, whoever caused it. One subscription
 * for the life of the server, released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { SettingsSource } from './port'

export const SettingsEventsLive: Layer.Layer<never, never, ServerEvents | SettingsSource> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const source = yield* SettingsSource
      const runtime = yield* Effect.runtime<never>()
      const off = source.subscribe((event) => {
        Effect.runFork(
          events
            .publish(event)
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] settings event not published', cause)
                )
              )
            ),
          { ...(runtime && {}) }
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
