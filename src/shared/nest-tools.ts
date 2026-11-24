import type { NestResult } from '@clave/contract/nest-rules'

/**
 * What `clave_attach_session` (PRDCT-4997) asks for, read from its arguments
 * the same way on every road: the server's (`src/main/mcp/served-nest-tools.ts`),
 * the window's (`mcp-dispatcher.ts`) and a Clave server's own
 * (`src/main/mcp/standalone-mcp.ts`). Each road keeps its own reach check,
 * its own call to `NestSession` and its own layout; this file holds the
 * words every road shows an agent, the argument rule, and the answer. A bad
 * argument is an error in words, before any call.
 */

export const ATTACH_SESSION_TOOL = 'clave_attach_session'

export const ATTACH_SESSION_DESCRIPTION =
  "Nest a tab that already exists under another tab of the sidebar, as attachToParent does for a tab you open: the parent's row counts it and unfolds to show it. Use it to tuck a finished or handed-over tab under the tab that continues its work, or a helper under the tab it serves. detach: true takes the tab out again, a row of its own. It changes where the tab is shown and nothing else: the tab keeps running and nothing is sent to it."

/** The three arguments' descriptions, one wording on every road. */
export const ATTACH_SESSION_ARGS = {
  sessionId: 'The tab to nest or to take out: "mine" (the default) or any tab\'s session id',
  to: 'The tab it goes under: a session id, or "mine" for your own tab',
  detach: 'Take the tab out of the tab it is nested under'
} as const

/** The refusal of a call that carries no tab identity. */
export const ATTACH_SESSION_NEEDS_TAB = `${ATTACH_SESSION_TOOL} must be called from inside a Clave agent tab — this request has no tab identity.`

/** What a call asks: the subject's reference, and the parent's or a detach. */
export type AttachRequest =
  | { subject: string; type: 'nest'; to: string }
  | { subject: string; type: 'detach' }

type Args = Record<string, unknown>
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Exactly one of `to` (a non-empty string) and `detach: true`; the subject
 *  defaults to the caller's own tab. */
export function attachRequest(p: Args): AttachRequest {
  const to = text(p.to)
  const detach = p.detach === true
  if ((to !== undefined) === detach)
    throw new Error('Pass exactly one of: to (the tab it goes under) or detach: true (take it out)')
  const subject = text(p.sessionId) ?? 'mine'
  return to !== undefined ? { subject, type: 'nest', to } : { subject, type: 'detach' }
}

/** The tool's answer: the subject, the tab it is nested under now (null for
 *  a row of its own), and whether the record changed. */
export function attachAnswer(result: NestResult): {
  sessionId: string
  nestedUnder: string | null
  changed: boolean
} {
  return { sessionId: result.id, nestedUnder: result.under, changed: result.changed }
}
