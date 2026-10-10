/**
 * A message typed into a terminal tab as ONE turn (wave 4, PRDCT-3377): the
 * sequence the window's dispatcher ran for `clave_send_to_session`, in the
 * process that owns the terminal. The person's half-typed draft is set
 * aside first (the draft shadow this process feeds from every keystroke it
 * writes), the input line cleared, the message delivered as a bracketed
 * paste and submitted alone, then the draft put back unsubmitted. Writes to
 * one terminal go one sequence at a time, so two messages can never
 * interleave their envelopes. The writer is injected: the sequence is tested
 * on a fake, and the real one is the PTY manager's write, never the lifecycle's
 * (the shadow must not see the injection as the person's typing).
 */
import { type DraftShadow, type DraftStash } from '../../shared/draft-shadow'
import { sanitizeForPaste } from '../../shared/paste-sanitize'
import type { DraftHandling } from '@clave/contract/sessions'

export interface TypingTarget {
  readonly shadow: DraftShadow
  readonly write: (data: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

export interface TypingOutcome {
  /** The submit was written after the paste. */
  submitted: boolean
  draftHandling: DraftHandling
}

/** The pause between the envelope and the submit, the one the window used. */
export const TYPING_GAP_MS = 150

const chains = new Map<string, Promise<unknown>>()
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const draftHandlingOf = (stash: DraftStash): DraftHandling =>
  stash.confident ? (stash.text ? 'stashed-restored' : 'none') : 'stashed-restored-best-effort'

/** Type `text` (already sanitized, provenance stamped) into the terminal
 *  keyed `id` and submit it; serialized per terminal. */
export function typeIntoTerminal(
  id: string,
  text: string,
  target: TypingTarget
): Promise<TypingOutcome> {
  const sleep = target.sleep ?? defaultSleep
  const run = async (): Promise<TypingOutcome> => {
    const stash = target.shadow.beginInjection()
    let submitted = false
    try {
      if (stash.clear) {
        target.write(stash.clear)
        await sleep(TYPING_GAP_MS)
      }
      // One bracketed paste so embedded newlines do not submit early, then
      // the submit. The TUI queues input that arrives mid-turn, so a busy
      // agent sees the message as its next user turn.
      target.write(`\x1b[200~${text}\x1b[201~`)
      await sleep(TYPING_GAP_MS)
      target.write('\r')
      // The submit went out: what the window called submitted, whether or
      // not the tab lived to take it (the tool reads the tab after).
      submitted = true
      if (stash.text) {
        await sleep(TYPING_GAP_MS)
        target.write(`\x1b[200~${sanitizeForPaste(stash.text)}\x1b[201~`)
      }
    } finally {
      target.shadow.endInjection(stash.text)
    }
    return { submitted, draftHandling: draftHandlingOf(stash) }
  }
  const prior = chains.get(id) ?? Promise.resolve()
  const next = prior.catch(() => undefined).then(run)
  chains.set(id, next)
  void next.finally(() => {
    if (chains.get(id) === next) chains.delete(id)
  })
  return next
}
