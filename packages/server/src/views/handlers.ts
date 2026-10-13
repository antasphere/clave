/**
 * The view requests' handlers: both commands go straight to the service,
 * which owns the waiting. Nothing here is a fact worth an event: a request
 * is a question to a window, not something that happened to the server.
 */
import { Effect } from 'effect'
import { CommandHandler } from '@structure-ai/cqrs'
import { AnswerViewRequest, RequestView } from '@clave/contract/views'
import { ViewRequests } from './requests'

export const viewHandlers = [
  CommandHandler.make(RequestView, (payload) =>
    Effect.flatMap(ViewRequests, (requests) => requests.ask(payload))
  ),
  CommandHandler.make(AnswerViewRequest, (payload) =>
    Effect.flatMap(ViewRequests, (requests) => requests.answer(payload))
  )
] as const
