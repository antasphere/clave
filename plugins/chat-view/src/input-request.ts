import { inputRequestMeta, own, type InputAnswer } from '@clave/contract/input-kinds'
import type { AgentQuestion } from '../../../src/shared/session-model'
import { questionKey } from '../../../src/renderer/src/lib/question-identity'
import type { Permission } from './reducer'

/* What the question card (InputPrompt.tsx) computes and nothing draws: the
   values a card starts from, the answers it sends, and which requests it
   answers. Pure, so a test pins each. */

export type Values = Record<string, InputAnswer>

const empty = (value: InputAnswer | undefined): boolean =>
  value === undefined ||
  (typeof value === 'string' ? value.trim() === '' : value.every((entry) => entry.trim() === ''))

/** The answers as sent: every question answered, trimmed, a multi-select's
 *  labels as an array with the person's own words last, each trimmed, an
 *  empty one dropped and a repeated one said once; a question left empty is
 *  left out. */
export function answersOf(
  questions: readonly AgentQuestion[],
  values: Values
): Record<string, string | string[]> {
  return Object.fromEntries(
    questions.flatMap((q): [string, string | string[]][] => {
      const value = own(values, questionKey(q))
      if (empty(value)) return []
      if (typeof value === 'string') return [[questionKey(q), value.trim()]]
      // Trimmed, blanks dropped, and each said once: own words that read like
      // a ticked option are that option.
      const list = [
        ...new Set((value as readonly string[]).map((entry) => entry.trim()).filter(Boolean))
      ]
      return list.length ? [[questionKey(q), list]] : []
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

/** What a card keeps across its row's unmounts, beside the values the host's
 *  `drafts` map keeps: the transcript is virtualised, and a card at the edge
 *  of the view mounts again as the agent speaks under it. A card that came
 *  back at its first step with the agent's writes replayed would change its
 *  height, scroll out, and mount again, without end. */
export interface CardMemory {
  step: number
  direction: 'forward' | 'back'
  landed: Record<string, number>
  applied: Values
  touched: Record<string, boolean>
  attempted: boolean
  /** The fields as the server's draft holds them, as far as this card knows
   *  (PRDCT-4210): what the agent set and what the reader's typing already
   *  sent. The typing is sent as it differs from this, never the agent's. */
  synced: Values
}
const memory = new Map<string, CardMemory>()
export const recalled = (id: string): CardMemory =>
  memory.get(id) ?? {
    step: 0,
    direction: 'forward',
    landed: {},
    applied: {},
    touched: {},
    attempted: false,
    synced: {}
  }
/** Written on a change of state, never on a render: a second instance of
 *  the same card (a hidden view of the session) must not write its own
 *  standing over the one the reader is looking at. */
export const remember = (id: string, patch: Partial<CardMemory>): void => {
  memory.set(id, { ...recalled(id), ...patch })
}
/** A form settled (answered, skipped, withdrawn): nothing to come back to. */
export const forgetCard = (id: string): void => {
  memory.delete(id)
}
