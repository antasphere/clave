/**
 * The view requests on the server: a request waits here for the window it
 * names to answer. Asking mints an id, pushes a `request` frame to every
 * welcomed peer (the server does not know which socket is which window, so
 * only the window of that key answers) and suspends until the answer, the
 * deadline or the caller's own interruption, whichever comes first. The
 * waiting requests live in memory for the life of the server; a stopping
 * server fails them all rather than leave a caller hanging.
 */
import { Context, Effect, Layer } from 'effect'
import {
  VIEW_REQUEST_TIMEOUT_MS,
  type ViewAnswer,
  ViewRequestNotFound,
  ViewRequestRefused,
  ViewRequestTimeout
} from '@clave/contract/views'
import { PushHubService } from '../push/route'

export interface ViewRequestInput {
  readonly windowKey: string
  readonly command: string
  readonly payload: unknown
  readonly timeoutMs?: number | undefined
}

export interface ViewRequestsService {
  readonly ask: (
    input: ViewRequestInput
  ) => Effect.Effect<{ result?: unknown }, ViewRequestRefused | ViewRequestTimeout>
  readonly answer: (answer: ViewAnswer) => Effect.Effect<void, ViewRequestNotFound>
  /** How many requests wait for an answer right now. */
  readonly pending: () => number
}

interface Pending {
  readonly windowKey: string
  readonly command: string
  readonly timeoutMs: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly resume: (
    outcome: Effect.Effect<{ result?: unknown }, ViewRequestRefused | ViewRequestTimeout>
  ) => void
}

export class ViewRequests extends Context.Tag('@clave/server/ViewRequests')<
  ViewRequests,
  ViewRequestsService
>() {
  static readonly layer: Layer.Layer<ViewRequests, never, PushHubService> = Layer.scoped(
    ViewRequests,
    Effect.gen(function* () {
      const hub = yield* PushHubService
      const waiting = new Map<string, Pending>()
      const timeoutOf = (requestId: string, entry: Pending): ViewRequestTimeout =>
        new ViewRequestTimeout({
          requestId,
          windowKey: entry.windowKey,
          command: entry.command,
          timeoutMs: entry.timeoutMs
        })

      // The server is stopping: nobody will answer now, and every caller hears so.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const entries = [...waiting]
          waiting.clear()
          for (const [requestId, entry] of entries) {
            clearTimeout(entry.timer)
            entry.resume(Effect.fail(timeoutOf(requestId, entry)))
          }
        })
      )

      const service: ViewRequestsService = {
        ask: (input) =>
          Effect.async<{ result?: unknown }, ViewRequestRefused | ViewRequestTimeout>((resume) => {
            const requestId = crypto.randomUUID()
            const timeoutMs = input.timeoutMs ?? VIEW_REQUEST_TIMEOUT_MS
            const timer = setTimeout(() => {
              const entry = waiting.get(requestId)
              if (!entry) return
              waiting.delete(requestId)
              resume(Effect.fail(timeoutOf(requestId, entry)))
            }, timeoutMs)
            waiting.set(requestId, {
              windowKey: input.windowKey,
              command: input.command,
              timeoutMs,
              timer,
              resume
            })
            hub.publishFrame({
              _tag: 'request',
              requestId,
              windowKey: input.windowKey,
              command: input.command,
              payload: input.payload
            })
            // The caller went away (an aborted HTTP request): forget the request.
            return Effect.sync(() => {
              clearTimeout(timer)
              waiting.delete(requestId)
            })
          }),
        answer: (answer) =>
          Effect.gen(function* () {
            const entry = waiting.get(answer.requestId)
            if (!entry) return yield* new ViewRequestNotFound({ requestId: answer.requestId })
            waiting.delete(answer.requestId)
            clearTimeout(entry.timer)
            entry.resume(
              answer.ok
                ? Effect.succeed({ ...(answer.result !== undefined && { result: answer.result }) })
                : Effect.fail(
                    new ViewRequestRefused({
                      requestId: answer.requestId,
                      windowKey: entry.windowKey,
                      command: entry.command,
                      message: answer.error ?? 'The window refused the request without a message'
                    })
                  )
            )
          }),
        pending: () => waiting.size
      }
      return service
    })
  )
}
