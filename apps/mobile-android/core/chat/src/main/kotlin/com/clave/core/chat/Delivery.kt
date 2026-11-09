/**
 * A message another tab sent through clave_send_to_session, read back: who sent it and
 * what they wrote, so the transcript shows it as the agents' own rather than as the
 * person's words under a bracketed line.
 *
 * Ported from the phone's `apps/mobile/src/chat/delivery.ts` (the desktop's
 * `packages/shared/src/exchange-provenance.ts`, the reading half). A change to the header
 * there is a change here.
 */
package com.clave.core.chat

data class ProvenanceSender(val id: String, val name: String)

data class ParsedDelivery(
    /** The sending tab; null for the anonymous header. */
    val sender: ProvenanceSender?,
    /** The message itself, the header and the line under it gone. */
    val body: String,
)

const val NAMED_PROVENANCE_PREFIX: String = "[Message from Clave tab \""
const val ANONYMOUS_PROVENANCE_HEADER: String = "[Message from a Clave agent]"

// The named header, whole, as the desktop writes it. A tab name cannot hold a newline, so
// the header is the first line; the name runs to the LAST `" — reply with`, so a name that
// happens to contain a quote still reads whole.
private val NAMED_HEADER =
    Regex("^\\[Message from Clave tab \"([^\\n]*)\" — reply with clave_send_to_session sessionId=\"([^\"\\n]*)\"\\]")

fun parseDelivery(text: String): ParsedDelivery? {
    val trimmed = text.trimStart()
    val named = NAMED_HEADER.find(trimmed)
    if (named != null) {
        return ParsedDelivery(
            sender = ProvenanceSender(id = named.groupValues[2], name = named.groupValues[1]),
            body = trimmed.substring(named.value.length).removePrefix("\n"),
        )
    }
    if (trimmed.startsWith(ANONYMOUS_PROVENANCE_HEADER)) {
        return ParsedDelivery(null, trimmed.substring(ANONYMOUS_PROVENANCE_HEADER.length).removePrefix("\n"))
    }
    return null
}
