/**
 * The message a hosted form's outcome becomes for the agent (PRDCT-4157):
 * when the person approves or skips a form asked with `clave_request_input`,
 * the server writes it into the session as the person's next message, so an
 * idle agent wakes with the answers. The text carries its own marker (the
 * form's provider id on its last line), so the view that draws the session,
 * live or from a transcript read back later, folds it into the form's record
 * row instead of a bubble. One module for the host that writes it, the
 * adapter that reads a transcript back, and the view that judges it.
 */

export interface FormOutcome {
  /** The request's record id, the one the agent's tools name. */
  id: string
  /** The request's provider id, the one the views know the card by. */
  form: string
  description: string
  questions: readonly { id?: string; question: string }[]
  /** The approved answers; absent when the person skipped. */
  answers?: Readonly<Record<string, string | readonly string[]>>
}

const HEAD = /^\[The form "[\s\S]*?" was (approved|skipped) by the person\]$/
const FOOT = /^\(form (clave:[0-9a-f-]{36})(?: · |\))/

/** The message, as the agent reads it. */
export function formMessage(outcome: FormOutcome): string {
  const approved = outcome.answers !== undefined
  const head = `[The form "${outcome.description}" was ${approved ? 'approved' : 'skipped'} by the person]`
  const lines = approved
    ? outcome.questions.flatMap((q) => {
        const value = outcome.answers?.[q.id ?? q.question]
        if (value === undefined) return []
        const text = Array.isArray(value) ? value.join(', ') : String(value)
        return [`${q.question}: ${text}`]
      })
    : []
  const foot = approved
    ? `(form ${outcome.form} · request ${outcome.id}: clave_input_result reads it, clave_input_set revises a field)`
    : `(form ${outcome.form} · request ${outcome.id})`
  return [head, ...lines, foot].join('\n')
}

/** The form a message is the outcome of, read off its own text: its first
 *  line and its last line both have to say so. Undefined for any other text,
 *  so a message that merely claims the marker hides nothing. */
export function formMessageMarker(text: string): string | undefined {
  const lines = text.trimEnd().split('\n')
  if (lines.length < 2 || !HEAD.test(lines[0])) return undefined
  const foot = FOOT.exec(lines[lines.length - 1])
  return foot?.[1]
}
