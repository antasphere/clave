/**
 * The settings source's changes, published as server events: an account
 * list that changed, a login job that progressed, a usage read that landed,
 * a workspace state that was written, whoever caused it. One subscription
 * for the life of the server, released with its scope.
 */
import { Effect, Layer } from 'effect'
import { ServerEvents } from '../events'
import { PushHubService } from '../push/route'
import { SettingsSource } from './port'

export const SettingsEventsLive: Layer.Layer<never, never, ServerEvents | SettingsSource> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const source = yield* SettingsSource
      // `runFork` starts the fiber synchronously, so events keep their order.
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
            )
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )

/**
 * Every socket hears the workspace state as it is the moment it is welcomed,
 * on that socket alone, before any change (wave wcs1023, lane B, #241). A
 * client of another machine takes a server's workspace list from its live
 * socket only, never from an HTTP answer: one connection to one process is
 * the only channel whose order holds across a restart. The frame is the
 * change event's, with no origin; it is not an event of the store, so its
 * `seq` is 0.
 */
export const WorkspacesWelcomeLive: Layer.Layer<never, never, PushHubService | SettingsSource> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const hub = yield* PushHubService
      const source = yield* SettingsSource
      const off = hub.onWelcome((send) => {
        void (async () => {
          const { workspaces, pins, revision, instance } = await source.workspaces.load()
          send({
            _tag: 'event',
            id: crypto.randomUUID(),
            seq: 0,
            at: Date.now(),
            event: {
              _tag: 'workspaces.state_changed',
              workspaces,
              pins,
              origin: null,
              revision,
              instance
            }
          })
        })().catch(() => {
          // A source without workspaces has no list to tell.
        })
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
  )
