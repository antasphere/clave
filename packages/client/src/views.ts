/**
 * The views domain of the client: the view requests an agent tool sends to
 * one window through the server, and the window's answer. Main calls
 * `request` and waits; the window that receives the `request` frame on its
 * push client (`PushClient.onRequest`) runs the command and calls `answer`.
 * A refusal and a missed deadline are thrown as the contract's tagged errors
 * (`ViewRequestRefused`, `ViewRequestTimeout`), like every declared failure.
 */
import type { ViewAnswer } from '@clave/contract/views'
import type { Call } from './call'

export interface ViewRequestInput {
  readonly windowKey: string
  readonly command: string
  readonly payload: unknown
  /** How long the server waits for the window; its default otherwise. */
  readonly timeoutMs?: number
}

export interface ViewsClient {
  readonly request: (input: ViewRequestInput) => Promise<{ result?: unknown }>
  readonly answer: (input: ViewAnswer) => Promise<void>
}

export const viewsClient = (call: Call): ViewsClient => ({
  request: (input) => call((c) => c.views.request({ payload: input })),
  answer: (input) => call((c) => c.views.answer({ payload: input })).then(() => undefined)
})
