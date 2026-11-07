/**
 * A message another tab sent through clave_send_to_session, read back: who
 * sent it and what they wrote, so the transcript shows it as the agents'
 * own rather than as the person's words under a bracketed line.
 *
 * Ported from the desktop's `packages/shared/src/exchange-provenance.ts` (the
 * reading half; the phone writes no header). The desktop's file is the
 * original: a change to the header there is a change here.
 */
export interface ProvenanceSender {
  readonly id: string
  readonly name: string
}

export const NAMED_PROVENANCE_PREFIX = '[Message from Clave tab "'
export const ANONYMOUS_PROVENANCE_HEADER = '[Message from a Clave agent]'

export interface ParsedDelivery {
  /** The sending tab; null for the anonymous header. */
  readonly sender: ProvenanceSender | null
  /** The message itself, the header and the line under it gone. */
  readonly body: string
}

// The named header, whole, as the desktop writes it. A tab name cannot hold a
// newline, so the header is the first line; the name runs to the LAST
// `" — reply with`, so a name that happens to contain a quote still reads whole.
const NAMED_HEADER =
  /^\[Message from Clave tab "([^\n]*)" — reply with clave_send_to_session sessionId="([^"\n]*)"\]/

export function parseDelivery(text: string): ParsedDelivery | null {
  const trimmed = text.trimStart()
  const named = NAMED_HEADER.exec(trimmed)
  if (named)
    return {
      sender: { name: named[1] ?? '', id: named[2] ?? '' },
      body: trimmed.slice(named[0].length).replace(/^\n/, '')
    }
  if (trimmed.startsWith(ANONYMOUS_PROVENANCE_HEADER))
    return {
      sender: null,
      body: trimmed.slice(ANONYMOUS_PROVENANCE_HEADER.length).replace(/^\n/, '')
    }
  return null
}
