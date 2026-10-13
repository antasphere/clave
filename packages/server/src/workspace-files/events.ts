/**
 * A watched file's changes, published as server events: the instance tells
 * its listeners, this one listener turns each into `workspace_files.changed`
 * for every attached client. One subscription for the life of the server,
 * released with its scope.
 */
import { Effect, Layer, Runtime } from 'effect'
import { ServerEvents } from '../events'
import { WorkspaceFilesPort } from './port'

export const WorkspaceFilesEventsLive: Layer.Layer<
  never,
  never,
  WorkspaceFilesPort | ServerEvents
> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const files = yield* WorkspaceFilesPort
    const events = yield* ServerEvents
    const runtime = yield* Effect.runtime<never>()
    const off = files.onEvent((event) => {
      Runtime.runFork(runtime)(
        events
          .publish(event)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() =>
                console.error('[clave-server] workspace file event not published', cause)
              )
            )
          )
      )
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))
  })
)
