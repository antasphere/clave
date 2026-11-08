/**
 * The provenance header Clave stamps on every cross-tab message delivery, and
 * the matcher that recognizes it again in a session's transcript.
 *
 * ONE source of truth on purpose. The renderer BUILDS the header when
 * delivering (`mcp-dispatcher.handleSendToSession`), and `hasProvenanceHeader`
 * is the matcher any reader of a transcript uses to tell a sibling agent's
 * delivery from something the human typed (the in-app conversation view that
 * used it went with the clave_read_exchanges tool; the exos side reads the
 * record instead). A hand-typed second copy of this string would drift, and
 * the failure is silent in the worst direction: an unmatched header makes a
 * sibling agent's message read as something the human typed.
 */

/** Sender identity as it appears in a named header. */
export interface ProvenanceSender {
  id: string
  name: string
}

/** The invariant opening of a named header — the part interpolation cannot
 *  change, and therefore the part a matcher can rely on. */
export const NAMED_PROVENANCE_PREFIX = '[Message from Clave tab "'

/** Header used when the sending side has no tab identity. */
export const ANONYMOUS_PROVENANCE_HEADER = '[Message from a Clave agent]'

/** Build the provenance header for a delivery. The receiving agent must be
 *  able to tell the text came from a sibling tab, not from the user, and know
 *  how to answer it — hence the reply instruction carrying the sender's id. */
export function buildProvenanceHeader(sender: ProvenanceSender | undefined): string {
  if (!sender) return ANONYMOUS_PROVENANCE_HEADER
  return `${NAMED_PROVENANCE_PREFIX}${sender.name}" — reply with clave_send_to_session sessionId="${sender.id}"]`
}

/** The invariant opening of a checkpoint header — a self-addressed send,
 *  logged into the transport record, never delivered anywhere. */
export const CHECKPOINT_PROVENANCE_PREFIX = '[Checkpoint by Clave tab "'

/** Header used when the checkpointing side has no tab identity. */
export const ANONYMOUS_CHECKPOINT_HEADER = '[Checkpoint by a Clave agent — logged, not delivered]'

/**
 * Build the provenance stamped on a CHECKPOINT: a self-addressed send that is
 * logged, never delivered (the solo lane's internal note). Deliberately NOT
 * matched by `hasProvenanceHeader`: a checkpoint never appears in any
 * transcript, and the matcher's delivered-message semantics must stay exact.
 */
export function buildCheckpointProvenance(sender: ProvenanceSender | undefined): string {
  if (!sender) return ANONYMOUS_CHECKPOINT_HEADER
  return `${CHECKPOINT_PROVENANCE_PREFIX}${sender.name}" — logged, not delivered]`
}

/**
 * True when `text` arrived through clave_send_to_session — i.e. it is a
 * sibling agent's message that the transcript happens to store on the user
 * side, not something the human wrote.
 */
export function hasProvenanceHeader(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith(NAMED_PROVENANCE_PREFIX) || trimmed.startsWith(ANONYMOUS_PROVENANCE_HEADER)
  )
}

/** A delivered message read back: who sent it, and what they wrote. */
export interface ParsedDelivery {
  /** The sending tab; null for the anonymous header. */
  sender: ProvenanceSender | null
  /** The message itself, the header and the line under it gone. */
  body: string
}

// The named header, whole, as `buildProvenanceHeader` writes it. A tab name
// cannot hold a newline (the delivery strips control bytes), so the header is
// the first line; the name runs to the LAST `" — reply with`, so a name that
// happens to contain a quote still reads whole.
const NAMED_HEADER =
  /^\[Message from Clave tab "([^\n]*)" — reply with clave_send_to_session sessionId="([^"\n]*)"\]/

/**
 * Split a message that arrived through clave_send_to_session into its sender
 * and its body, so a view can show a sibling agent's message as one rather
 * than as the human's words under a bracketed line. Null for anything the
 * human typed — including a message that merely quotes a header further down.
 */
export function parseDelivery(text: string): ParsedDelivery | null {
  const trimmed = text.trimStart()
  const named = NAMED_HEADER.exec(trimmed)
  if (named)
    return {
      sender: { name: named[1], id: named[2] },
      body: trimmed.slice(named[0].length).replace(/^\n/, '')
    }
  if (trimmed.startsWith(ANONYMOUS_PROVENANCE_HEADER))
    return {
      sender: null,
      body: trimmed.slice(ANONYMOUS_PROVENANCE_HEADER.length).replace(/^\n/, '')
    }
  return null
}
