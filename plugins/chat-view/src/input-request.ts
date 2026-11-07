import { inputRequestMeta, type InputAnswer } from '@clave/contract/input-kinds'
import type { AgentQuestion } from '../../../src/shared/session-model'
import { questionKey } from '../../../src/renderer/src/lib/question-identity'
import type { Permission } from './reducer'

/* What the question card (InputPrompt.tsx) computes and nothing draws: the
   values a card starts from, the answers it sends, and which requests it
   answers. Pure, so a test pins each. */

export type Values = Record<string, InputAnswer>

const empty = (value: InputAnswer | undefined): boolean =>
  value === undefined || (typeof value === 'string' ? value.trim() === '' : value.length === 0)

/** The answers as sent: every question answered, trimmed, a multi-select's
 *  labels as an array; an optional question left empty is left out. */
export function answersOf(
  questions: readonly AgentQuestion[],
  values: Values
): Record<string, string | string[]> {
  return Object.fromEntries(
    questions.flatMap((q) => {
      const value = values[questionKey(q)]
      if (empty(value)) return []
      return [
        [
          questionKey(q),
          typeof value === 'string' ? value.trim() : [...(value as readonly string[])]
        ]
      ]
    })
  )
}

/** The values a card starts from: the agent's defaults, or what the reader
 *  had typed before the row scrolled out of view and unmounted. */
export function initialValues(
  request: Permission,
  drafts: Map<string, Values> | undefined
): Values {
  const kept = drafts?.get(request.id)
  if (kept) return kept
  return Object.fromEntries(
    (request.questions ?? []).flatMap((q) =>
      q.default !== undefined ? [[questionKey(q), q.default]] : []
    )
  )
}

/** The requests this card answers: the ones clave_request_input created. */
export const isInputRequest = (request: Permission): boolean =>
  inputRequestMeta(request.input) !== null

/** A refusal, by the option's id: the words every provider uses. */
export const isDeny = (id: string): boolean => /deny|decline|cancel|reject|abort/i.test(id)
