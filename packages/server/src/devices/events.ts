/**
 * Every change of the devices (a phone asking, approved, refused, revoked,
 * seen, its push token set or cleared, the relay address) told to every
 * attached client as `devices.changed` with the revision; a client re-lists.
 * The event carries the revision alone: no name, no token, no address. A
 * phone asking is also `devices.pairing_requested` with its name and
 * platform, for the notice the shell shows.
 */
import { Effect, Layer, Runtime } from 'effect'
import { ServerEvents } from '../events'
import { DeviceSessions } from './service'

export const DevicesEventsLive: Layer.Layer<never, never, ServerEvents | DeviceSessions> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const devices = yield* DeviceSessions
      const events = yield* ServerEvents
      const runtime = yield* Effect.runtime<never>()
      const off = devices.subscribe((revision) => {
        Runtime.runFork(runtime)(
          events
            .publish({ _tag: 'devices.changed', revision })
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] devices event not published', cause)
                )
              )
            )
        )
      })
      // A phone asked: its name and platform to every client, for the Mac's
      // notification; never its token, which the event does not carry.
      const offAsked = devices.onPairingRequested((pairing) => {
        Runtime.runFork(runtime)(
          events
            .publish({ _tag: 'devices.pairing_requested', ...pairing })
            .pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  console.error('[clave-server] pairing event not published', cause)
                )
              )
            )
        )
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          off()
          offAsked()
        })
      )
    })
  )
