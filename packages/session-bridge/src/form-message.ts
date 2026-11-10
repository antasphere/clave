/**
 * The marker of a hosted form's outcome (Clave, PRDCT-4157): when a person
 * answers a form the host asked, the host writes the answers into the session
 * as the person's next message, and the text carries the form's id on its own
 * first and last lines. Copied from Clave's `src/shared/form-message.ts` so a
 * reader here folds the same message the same way.
 */
const HEAD = /^\[The form "[\s\S]*?" was (approved|skipped) by the person\]\n/
const FOOT = /^\(form (clave:[0-9a-f-]{36})(?: · |\))/

/** The form a message is the outcome of, read off its own text; undefined for
 *  any other text, so a message that merely claims the marker hides nothing. */
export function formMessageMarker(text: string): string | undefined {
  const trimmed = text.trimEnd()
  if (!HEAD.test(trimmed)) return undefined
  const foot = FOOT.exec(trimmed.slice(trimmed.lastIndexOf('\n') + 1))
  return foot?.[1]
}
