import { Effect, Layer, Runtime } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  ListPendingRequests,
  ResolvePendingRequest,
  RequestRejected
} from '../../../contract/src/requests'
import { ServerEvents } from '../events'
import { RequestsPort } from './port'

const failure = (error: unknown): RequestRejected | CapabilityUnavailable =>
  error instanceof RequestRejected || error instanceof CapabilityUnavailable
    ? error
    : new RequestRejected({ code: 'invalid', message: 'The request operation failed.' })
export const requestHandlers = [
  QueryHandler.make(ListPendingRequests, () =>
    Effect.flatMap(RequestsPort, (requests) =>
      Effect.try({
        try: () => requests.snapshot(),
        catch: () =>
          new CapabilityUnavailable({
            capability: 'requests',
            message: 'This server has no shared request service.'
          })
      })
    )
  ),
  CommandHandler.make(ResolvePendingRequest, (input) =>
    Effect.flatMap(RequestsPort, (requests) =>
      Effect.tryPromise({ try: () => requests.resolve(input), catch: failure })
    )
  )
] as const

/** Notifications carry a revision only. No answers or action results enter
 * the event store, including for secrets. Reconnect reads the current query. */
export const RequestEventsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const requests = yield* RequestsPort
    const events = yield* ServerEvents
    const runtime = yield* Effect.runtime<never>()
    const off = requests.subscribe((revision) => {
      Runtime.runFork(runtime)(events.publish({ _tag: 'requests.changed', revision }))
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))
  })
)
