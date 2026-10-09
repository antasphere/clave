/**
 * The views domain: a view request is a command an agent tool sends to one
 * window of the app (list its tabs, rename a group, open a panel) and waits
 * on. The window is named by its key, runs the command and answers; the
 * server carries the request out on the push channel and the answer back to
 * the waiting caller. An agent tool that needs a window reaches it only
 * through the server, so a server running on its own can carry the same
 * frame the in-process one does. The server never reads `command` or
 * `payload`: they are the window's business, opaque on the wire.
 */
import { Schema } from 'effect'
import { Command } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { WindowKey } from './sidebar/layout'

// The deadlines live in `view-deadlines.ts`, a module with no import, so
// that main can read them at boot without loading Effect (lazy-load guard).
import { VIEW_REQUEST_MAX_TIMEOUT_MS } from './view-deadlines'
export { VIEW_REQUEST_MAX_TIMEOUT_MS, VIEW_REQUEST_TIMEOUT_MS } from './view-deadlines'

/** What the server pushes: the request, minted an id, for the window of that key. */
export const ViewRequest = Schema.Struct({
  requestId: Schema.NonEmptyString,
  windowKey: WindowKey,
  command: Schema.NonEmptyString,
  payload: Schema.Unknown
})
export type ViewRequest = typeof ViewRequest.Type

/** What the window sends back: the result, or the reason it refused. */
export const ViewAnswer = Schema.Struct({
  requestId: Schema.NonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String)
})
export type ViewAnswer = typeof ViewAnswer.Type

/** The window answered and said no; `message` is the window's own text. */
export class ViewRequestRefused extends Schema.TaggedError<ViewRequestRefused>()(
  'ViewRequestRefused',
  {
    requestId: Schema.String,
    windowKey: Schema.String,
    command: Schema.String,
    message: Schema.String
  }
) {}

/** No window answered within the deadline, or the server stopped first. */
export class ViewRequestTimeout extends Schema.TaggedError<ViewRequestTimeout>()(
  'ViewRequestTimeout',
  {
    requestId: Schema.String,
    windowKey: Schema.String,
    command: Schema.String,
    timeoutMs: Schema.Number
  }
) {}

/** An answer to a request nobody waits on: unknown, already answered, or timed out. */
export class ViewRequestNotFound extends Schema.TaggedError<ViewRequestNotFound>()(
  'ViewRequestNotFound',
  { requestId: Schema.String }
) {}

/** Ask a window to run a command; answers with what the window answered. */
export const RequestView = Command.define('RequestView', {
  payload: Schema.Struct({
    windowKey: WindowKey,
    command: Schema.NonEmptyString,
    payload: Schema.Unknown,
    timeoutMs: Schema.optional(Schema.Int.pipe(Schema.between(1, VIEW_REQUEST_MAX_TIMEOUT_MS)))
  }),
  success: Schema.Struct({ result: Schema.optional(Schema.Unknown) }),
  failure: Schema.Union(ViewRequestRefused, ViewRequestTimeout)
})

/** A window's answer to a request it received on the push channel. */
export const AnswerViewRequest = Command.define('AnswerViewRequest', {
  payload: ViewAnswer,
  success: Schema.Void,
  failure: ViewRequestNotFound
})

export const viewsGroup = ApiGroup.make('views')
  .add(HttpCqrs.commandEndpoint('request', '/views/request', RequestView))
  .add(HttpCqrs.commandEndpoint('answer', '/views/answer', AnswerViewRequest))
