import { HELPER_SYSTEM_PREAMBLE } from '../../shared/helper-prompt'
import {
  digestPrompt,
  parseDigestReply,
  type DigestDone,
  type DigestMessage
} from '../../shared/exchange-digest'
import {
  parseWorkDigestReply,
  workDigestPrompt,
  type WorkDigestDone
} from '../../shared/work-digest'
import { defineHelper } from './registry'

/**
 * The two digests the chat views ask for (`src/main/exchange-digest.ts` runs
 * them and files their answers): the exchange digest at the head of a tab's
 * exchange timeline, and the work digest that titles a card of the agent's
 * working notes. The prompt builders and parsers live in `src/shared/`, beside
 * the types the renderer reads.
 */

export const DIGEST_TIMEOUT_MS = 45_000

/** The exchange and the work digests share one cap of two, as they shared
 *  one queue before the helpers. */
export const DIGEST_POOL = { id: 'digests', concurrency: 2 }

/** The exchange digest reads messages already clipped by its caller. */
export const exchangeDigestHelper = defineHelper<readonly DigestMessage[], DigestDone>({
  id: 'exchange-digest',
  label: 'Exchange digests',
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: read the messages other agent sessions sent, and say in one line of JSON what their human must know or decide.`,
  buildPrompt: digestPrompt,
  parseReply: (stdout, messages) => parseDigestReply(stdout, messages.length),
  model: 'haiku',
  fallbackModel: 'sonnet',
  timeoutMs: DIGEST_TIMEOUT_MS,
  priority: 30,
  // A reader scrolling through history mounts many timelines at once: the
  // two digests together run two at a time, the rest in turn, and never
  // ahead of a title or a git call.
  pool: DIGEST_POOL,
  background: true,
  // One try: the card says it could not be read and offers to ask again.
  attempts: 1
})

export interface WorkDigestInput {
  /** Already clipped (`clipNotes`). */
  notes: readonly string[]
  tools: number
}

export const workDigestHelper = defineHelper<WorkDigestInput, WorkDigestDone>({
  id: 'work-digest',
  label: 'Work-card titles',
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: title the working notes an agent wrote, and say in one line of JSON whether one of them needs its human.`,
  buildPrompt: (input) => workDigestPrompt(input.notes, input.tools),
  parseReply: (stdout, input) => parseWorkDigestReply(stdout, input.notes.length),
  model: 'haiku',
  fallbackModel: 'sonnet',
  timeoutMs: DIGEST_TIMEOUT_MS,
  priority: 20,
  pool: DIGEST_POOL,
  background: true,
  attempts: 1
})
