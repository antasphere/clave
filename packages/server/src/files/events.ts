import { Effect, Layer, Runtime } from 'effect'
import { ServerEvents } from '../events'
import { FilesPort } from './port'

export const FilesEventsLive: Layer.Layer<never, never, FilesPort | ServerEvents> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const files = yield* FilesPort
      const events = yield* ServerEvents
      const runtime = yield* Effect.runtime<never>()
      const off = files.onEvent((event) => {
        Runtime.runFork(runtime)(events.publish(event))
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          off()
          files.dispose()
        })
      )
    })
  )
