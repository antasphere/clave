/**
 * What a notification's action means and how its answer reaches the server
 * (decision 9 of the spec): allow and deny on a permission, a typed reply on
 * a question, through `POST /requests/resolve` with the device session, in
 * the background where the platform lets the app run; anything the
 * notification cannot settle opens the app on the request.
 *
 * The answer is shaped from the pending request fetched by its id, never
 * from the payload: a permission's option ids are the adapter's (`allow-once`
 * and `deny` for Claude, `approve` and `deny` for an MCP approval, native
 * strings for Codex), and a clarification's answer is keyed by `q.id ??
 * q.question` (docs/server-requests.md), which the payload's bounded text
 * cannot give. A server without the requests port (the Mac app's in-process
 * server) holds the prompt as a stream frame instead, and lane B names that
 * frame's id as the `requestId`: there, allow and deny go through
 * `POST /sessions/write` as a `permission_response`, and a reply opens the
 * app, since the question's key is only in the frame.
 */
import { ServerError, messageOf } from '../api/errors'
import type {
  PendingRequest,
  RequestResponse,
  RequestSnapshot,
  ResolveOutcome,
  SessionWriteInput
} from '../contract/types'
import { answersAsPermission, questionKey } from '../requests/answers'
import { ACTION_IDS } from './categories'
import { parsePayload, type NotificationPayload } from './payload'
import type { IncomingResponse } from './port'

export type NotificationIntent =
  | { readonly kind: 'allow' | 'deny'; readonly payload: NotificationPayload }
  | { readonly kind: 'reply'; readonly payload: NotificationPayload; readonly text: string }
  | { readonly kind: 'open'; readonly payload: NotificationPayload }

/** What the person did on the notification, as the payload allows it: an
 *  action the payload did not offer is a plain open. Null when the push
 *  carried no readable payload. */
export function interpretResponse(response: IncomingResponse): NotificationIntent | null {
  const payload = parsePayload(response.notification.request.content.data)
  if (!payload) return null
  switch (response.actionIdentifier) {
    case ACTION_IDS.allow:
      return payload.actions.includes('allow')
        ? { kind: 'allow', payload }
        : { kind: 'open', payload }
    case ACTION_IDS.deny:
      return payload.actions.includes('deny')
        ? { kind: 'deny', payload }
        : { kind: 'open', payload }
    case ACTION_IDS.reply: {
      const text = response.userText?.trim() ?? ''
      return payload.actions.includes('reply') && text
        ? { kind: 'reply', payload, text }
        : { kind: 'open', payload }
    }
    default:
      return { kind: 'open', payload }
  }
}

/** Lane B's rule for which option ids are an allow and a deny
 *  (`packages/server/src/notify/payload.ts`), the same words here so the
 *  phone answers what the server offered. */
const ALLOW_OPTION = /^(allow|allow-once|allow-always|approve|accept|yes|ok)$/i
const DENY_OPTION = /^(deny|decline|reject|cancel|no)$/i

/** The option id to answer with: the request's own when it is known, else
 *  the Claude adapter's `allow-once` and `deny`. A request offering several
 *  allows (`allow-once`, `allow-always`) gets the first, the narrower one. */
export function permissionOptionId(
  request: Pick<PendingRequest, 'options'> | null,
  choice: 'allow' | 'deny'
): string {
  const pattern = choice === 'allow' ? ALLOW_OPTION : DENY_OPTION
  const own = request?.options?.find((o) => pattern.test(o.id))?.id
  return own ?? (choice === 'allow' ? 'allow-once' : 'deny')
}

export function permissionResponse(
  request: Pick<PendingRequest, 'options'> | null,
  choice: 'allow' | 'deny'
): RequestResponse {
  return { type: 'permission', optionId: permissionOptionId(request, choice) }
}

/** A typed reply to the one question of the request, keyed as the server
 *  reads it; null when the request asks more than one question or none,
 *  which the app answers. */
export function replyResponse(request: PendingRequest, text: string): RequestResponse | null {
  const questions = request.questions ?? []
  if (questions.length !== 1) return null
  const answers = { [questionKey(questions[0]!)]: text }
  return answersAsPermission(request)
    ? { type: 'permission', optionId: 'answer', answers }
    : { type: 'clarification', answers }
}

export type SettleOutcome =
  | { readonly kind: 'settled' }
  /** Somebody else answered first, or the request is gone. */
  | { readonly kind: 'already-settled' }
  /** The notification cannot settle this: the app opens on it. */
  | { readonly kind: 'open-app'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

/** What `settleFromNotification` needs of lane C's server client. */
export interface SettleClient {
  readonly requests: {
    list(): Promise<RequestSnapshot>
    resolve(requestId: string, response: RequestResponse): Promise<ResolveOutcome>
  }
  readonly sessions: {
    write(id: string, input: SessionWriteInput): Promise<void>
  }
}

export async function settleFromNotification(
  intent: NotificationIntent,
  client: SettleClient
): Promise<SettleOutcome> {
  if (intent.kind === 'open') return { kind: 'open-app', reason: 'The notification was opened.' }
  const { payload } = intent
  if (!payload.requestId)
    return { kind: 'open-app', reason: 'The notification names no request to answer.' }
  let snapshot: RequestSnapshot
  try {
    snapshot = await client.requests.list()
  } catch (error) {
    if (error instanceof ServerError && error.capabilityUnavailable)
      return settleInChat(intent, client)
    return { kind: 'failed', reason: messageOf(error) }
  }
  const request = snapshot.pending.find((r) => r.id === payload.requestId)
  if (!request) return { kind: 'already-settled' }
  let response: RequestResponse | null
  if (intent.kind === 'reply') {
    response = replyResponse(request, intent.text)
    if (!response)
      return { kind: 'open-app', reason: 'This question needs the app to be answered.' }
  } else response = permissionResponse(request, intent.kind)
  try {
    const outcome = await client.requests.resolve(request.id, response)
    return outcome.accepted ? { kind: 'settled' } : { kind: 'already-settled' }
  } catch (error) {
    return { kind: 'failed', reason: messageOf(error) }
  }
}

/** The in-process server's way: the prompt is a stream frame of the
 *  session, answered through the write route. */
async function settleInChat(
  intent: Exclude<NotificationIntent, { kind: 'open' }>,
  client: SettleClient
): Promise<SettleOutcome> {
  const { payload } = intent
  if (intent.kind === 'reply')
    return { kind: 'open-app', reason: 'This question needs the app to be answered.' }
  if (!payload.sessionId || !payload.requestId)
    return { kind: 'open-app', reason: 'The notification names no conversation to answer in.' }
  try {
    await client.sessions.write(payload.sessionId, {
      type: 'permission_response',
      id: payload.requestId,
      optionId: permissionOptionId(null, intent.kind)
    })
    return { kind: 'settled' }
  } catch (error) {
    if (error instanceof ServerError && error.kind === 'refused') return { kind: 'already-settled' }
    return { kind: 'failed', reason: messageOf(error) }
  }
}
