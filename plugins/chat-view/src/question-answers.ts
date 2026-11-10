import type { InputAnswer } from '@clave/contract/input-kinds'
import type { AgentQuestion } from '../../../src/shared/session-model'

/* How one card asks every question (PRDCT-4322): a form an agent opened
   through clave_request_input, and a question the agent asked with its own
   tool (Claude's AskUserQuestion, Codex's request for input, a plugin's
   question, a server's clarification). What the card reads off a question
   and an answer, and nothing it draws: pure, so a test pins each. */

/** The question as the card asks it. A form's question is the agent's own.
 *  A native question is a choice among its options with the person's own
 *  words allowed, as it always was, or a field of their own words when it
 *  offers no option; a plugin's question, whose choice IS the answer, is
 *  closed to its options. */
export function cardQuestion(
  question: AgentQuestion,
  how: 'hosted' | 'native' | 'plugin'
): AgentQuestion {
  if (how === 'hosted') return question
  if (!question.options.length) return { ...question, kind: 'long-text' }
  return { ...question, kind: 'choice', ...(how === 'plugin' && { optionsOnly: true }) }
}

/** Whether a choice takes the person's own words beside its options. */
export const takesOwnWords = (question: AgentQuestion): boolean =>
  question.kind === 'choice' && !question.optionsOnly

const WORD = /[\p{L}\p{N}]/u

/** The option a single choice's answer starts from: the option itself, or
 *  the one the person wrote on from ("Lint, only the changed files" reads as
 *  Lint). The longest label that opens the answer and is not cut mid-word;
 *  null for an answer in the person's own words. */
export function pickedOption(question: AgentQuestion, answer: string): string | null {
  const text = answer.trimStart()
  let best: string | null = null
  for (const { label } of question.options) {
    if (!label || !text.startsWith(label)) continue
    const next = text.charAt(label.length)
    if (next && WORD.test(next) && WORD.test(label.charAt(label.length - 1))) continue
    if (best === null || label.length > best.length) best = label
  }
  return best
}

const labelsOf = (question: AgentQuestion): Set<string> =>
  new Set(question.options.map((o) => o.label))

const listOf = (value: InputAnswer | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? (value ? [value] : []) : [...value]

/** A multi-select's own words: whatever its answer holds that is not one of
 *  the options, as the one line the card shows them in. */
export function ownWordsOf(question: AgentQuestion, value: InputAnswer | undefined): string {
  const labels = labelsOf(question)
  return listOf(value)
    .filter((entry) => !labels.has(entry))
    .join(', ')
}

/** A multi-select's answer with its own words replaced by `words`: the
 *  options picked, in their order, then the words when there are any. The
 *  words are kept as typed (a trailing space is the next word coming);
 *  the answer sent trims them (`answersOf`). */
export function withOwnWords(
  question: AgentQuestion,
  value: InputAnswer | undefined,
  words: string
): string[] {
  const labels = labelsOf(question)
  const picked = listOf(value).filter((entry) => labels.has(entry))
  return words.trim() === '' ? picked : [...picked, words]
}

/** A multi-select's answer with one option picked or unpicked; its own
 *  words stay where they were, last. */
export function togglePick(
  question: AgentQuestion,
  value: InputAnswer | undefined,
  label: string
): string[] {
  const labels = labelsOf(question)
  const list = listOf(value)
  const picked = list.filter((entry) => labels.has(entry))
  const own = list.filter((entry) => !labels.has(entry))
  const next = picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]
  // The options keep the order the agent gave them, whatever the clicks.
  const order = question.options.map((o) => o.label)
  next.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...next, ...own]
}

/** The words under "Claude asks" on a native question's card. The adapters
 *  name a native question by its text ("Which host?") or by its count
 *  ("Claude asks 3 questions"): both say again what the card shows, so the
 *  card shows neither. Anything else (a server's clarification, written by
 *  the agent) is the agent's own framing, and stays. */
export function nativeHeadline(
  description: string,
  questions: readonly AgentQuestion[]
): string | null {
  const text = description.trim()
  if (!text) return null
  if (questions.some((q) => q.question.trim() === text)) return null
  if (/^\S+ asks(?: \d+ questions?)?$/.test(text)) return null
  return text
}

/** The answers to the agent's own question as its provider takes them: one
 *  string per question, a multi-select's picks and own words joined by ", "
 *  (`PermissionResponseSchema`), whatever adapter reads them. */
export function nativeAnswers(answers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : value.join(', ')
    ])
  )
}
