/**
 * What the phone's forms send back for a pending request, shaped the way
 * the server's `PendingRequests.validate` reads it (packages/server/src/
 * requests/service.ts): a permission answers with one of its option ids,
 * plus the answers when the request asked questions and the option is
 * `answer`; a clarification answers every question under its key, `q.id ??
 * q.question`, none empty; a secret answers its value, which travels in the
 * resolve body and nowhere else; a dismissal answers nothing. A multi-select
 * question joins the picked labels with `, `, as the desktop's prompt dock
 * does; a free answer is the typed text.
 */
import type { AgentQuestion, PendingRequest, RequestResponse } from '../contract/types'

export const questionKey = (q: AgentQuestion): string => q.id ?? q.question

/** What the reader chose for one question: picked option labels, a free answer. */
export interface QuestionReply {
  readonly picked: readonly string[]
  readonly other?: string
}

export type Shaped = { ok: true; response: RequestResponse } | { ok: false; problem: string }

/** The text of one question's reply: the labels joined, or the free answer. */
export function answerText(q: AgentQuestion, reply: QuestionReply | undefined): string {
  if (!reply) return ''
  const other = reply.other?.trim() ?? ''
  const picked = q.multiSelect ? reply.picked : reply.picked.slice(0, 1)
  const parts = [...picked, ...(other ? [other] : [])]
  return parts.join(', ').trim()
}

export function shapeAnswers(
  questions: readonly AgentQuestion[],
  replies: Readonly<Record<string, QuestionReply>>
): { ok: true; answers: Record<string, string> } | { ok: false; problem: string } {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const key = questionKey(q)
    const text = answerText(q, replies[key])
    if (!text) return { ok: false, problem: `Answer "${q.header ?? q.question}" first.` }
    answers[key] = text
  }
  return { ok: true, answers }
}

export function shapePermission(
  request: PendingRequest,
  optionId: string,
  replies: Readonly<Record<string, QuestionReply>> = {}
): Shaped {
  if (!request.options?.some((o) => o.id === optionId))
    return { ok: false, problem: 'That option is not one of this request.' }
  if (request.questions?.length && optionId === 'answer') {
    const shaped = shapeAnswers(request.questions, replies)
    if (!shaped.ok) return shaped
    return { ok: true, response: { type: 'permission', optionId, answers: shaped.answers } }
  }
  return { ok: true, response: { type: 'permission', optionId } }
}

export function shapeClarification(
  request: PendingRequest,
  replies: Readonly<Record<string, QuestionReply>>
): Shaped {
  const shaped = shapeAnswers(request.questions ?? [], replies)
  if (!shaped.ok) return shaped
  return { ok: true, response: { type: 'clarification', answers: shaped.answers } }
}

export function shapeSecret(value: string): Shaped {
  if (!value) return { ok: false, problem: 'Enter the secret first.' }
  return { ok: true, response: { type: 'secret', value } }
}

export const dismissal: RequestResponse = { type: 'dismiss' }

/** A request the server holds under a provider's id (a native prompt of the
 *  agent) answers like a permission even when its kind is clarification:
 *  the server reads `permission` with the option `answer` for it. */
export const answersAsPermission = (request: PendingRequest): boolean =>
  request.kind === 'permission' || request.providerRequestId !== undefined
