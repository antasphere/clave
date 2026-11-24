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
  'Nest a tab that already exists under another tab of the sidebar, as attachToParent does for a tab you open: the parent\'s row counts it and unfolds to show it. Use it to tuck a finished or handed-over tab under the tab that continues its work, or a helper under the tab it serves. detach: true takes the tab out again, a row of its own. It changes where the tab is shown: the tab keeps running and nothing is sent to it. Its "parent" for messages stays the tab that opened it; a tab nobody opened takes the tab it is nested under.'

/** The three arguments' descriptions, one wording on every road. */
export const ATTACH_SESSION_ARGS = {
  sessionId: 'The tab to nest or to take out: "mine" (the default) or any tab\'s session id',
  to: 'The tab it goes under: a session id, or "mine" for your own tab',
  detach: 'Take the tab out of the tab it is nested under'
} as const

/** What a window is answered when it asks for a nesting before main has
 *  named the server to it: the command is the server's alone, so there is no
 *  other road. Not a refusal: the same call can be made again. */
export const NEST_SERVER_NOT_NAMED = 'Clave server is not available'

/**
 * A nesting the server ANSWERED with a no, as opposed to one it never
 * answered (a server silent, not named yet, a road that failed). The two are
 * told apart where the answer is known, in the preload, by the error's tag.
 * An Error crossing the context bridge keeps its message and nothing else, so
 * the answer travels in the message, marked: `nestRefusalMessage` on the way
 * out, `nestRefusalIn` on the way in. Nothing is read off the sentence's own
 * words, which quote names a person chose (a lane called "Import/export", a
 * tab named after a path).
 */
export const NEST_REFUSAL_MARK = '[nest refused] '
export const nestRefusalMessage = (sentence: string): string => NEST_REFUSAL_MARK + sentence
/** The server's sentence when `message` is a marked refusal, else null. */
export function nestRefusalIn(message: string): string | null {
  return message.startsWith(NEST_REFUSAL_MARK) ? message.slice(NEST_REFUSAL_MARK.length) : null
}
/** What a tab the server no longer knows is answered with: the declared
 *  not-found carries an id and no sentence of its own. */
export const NEST_TAB_GONE = 'That tab is gone'

/** The refusal as the renderer throws and catches it, once unmarked. */
export class NestRefused extends Error {
  override readonly name = 'NestRefused'
}

/** The error a tagged answer of the server becomes on its way to a window:
 *  a refusal marked with its sentence, anything else as it came. The two
 *  answers that are a no: the rule's or the host's refusal, and a tab that
 *  is gone. A server that says it cannot (`CapabilityUnavailable`) is not
 *  one: the server answers so for any failure of its host, a disk that was
 *  busy for a moment included, and its words then carry that failure's own,
 *  a path among them. It stays a call that was never answered: plain words
 *  under the row, and an undo keeps its step. */
export function nestAnswerError(error: unknown): unknown {
  const tagged = error as { _tag?: unknown; message?: unknown } | null
  if (!tagged || typeof tagged !== 'object') return error
  if (tagged._tag === 'NestRefused' && typeof tagged.message === 'string')
    return new Error(nestRefusalMessage(tagged.message))
  if (tagged._tag === 'SessionNotFound') return new Error(nestRefusalMessage(NEST_TAB_GONE))
  return error
}

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
