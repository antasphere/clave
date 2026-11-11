/**
 * What the phone keeps about sends whose outcome it never saw (decision 10 of the spec, the
 * write-status seam of 29 October 2026): the id the phone minted, the session, and the text
 * sent under it, so that a reconnection can ask the server about exactly that id and, when
 * the server says it never arrived, complete the same send with the same bytes. The ledger
 * is a JSON list in the key-value store, so it survives a restart as the drafts do. Beside
 * it, one delivery mark per conversation says what the composer shows above the draft.
 * Ported from `apps/mobile/src/reconnect/ledger.ts`.
 */
package com.clave.core.chat

import com.clave.core.contract.Attachment
import com.clave.core.contract.SessionEvent
import com.clave.core.ports.KeyValueStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArraySet

data class UnknownSend(
    val machineId: String,
    val sessionId: String,
    val clientMessageId: String,
    /** The text as sent, so a resend the server asks for is the same bytes. */
    val text: String,
    val at: Long,
    /** The composer's text before the markers and the trim, to know whether the draft is still it. */
    val draftText: String? = null,
    val attachments: List<Attachment>? = null,
    /**
     * The person discarded it (Discard, or Send again) and the discard is not carried out yet. It is
     * written into the entry before the discard waits for a reconnection pass, so a controller built
     * again over these stores after the process ended finds the send decided: it never completes it,
     * and it carries the discard out. In the entry itself, the record cannot outlive the send or miss it.
     */
    val discarded: Boolean = false,
    /**
     * How the send ended (sent, rejected, failed), written into the entry before any cleanup of it.
     * From then on the entry is decided: no pass asks about it, completes it or writes it, and a
     * controller built again over these stores only finishes its cleanup, by this kind, the entry's
     * removal last.
     */
    val end: SendEnd? = null,
    /**
     * A same-id completion of this send was refused (401, 403, a declared 422). That says nothing of the first
     * write, which may still arrive, so the send stays unknown; but no pass sends the completion
     * again, in this process or the next: the person decides (Send again, or Discard).
     */
    val completionRefused: Boolean = false,
) {
    /** Discarded or ended: what is left is the cleanup, never a question to the server or a write. */
    val decided: Boolean get() = discarded || end != null

    /** The same message under the same id, the write a reconnection completes. */
    fun toUserMessage(): SessionEvent.UserMessage = SessionEvent.UserMessage(
        clientMessageId = clientMessageId,
        text = text,
        attachments = attachments?.takeIf { it.isNotEmpty() },
    )
}

/** A send's terminal end as its ledger entry records it; [reason] and [at] are the Rejected mark's. */
data class SendEnd(val kind: Kind, val reason: String = "", val at: Long = 0) {
    enum class Kind(val wire: String) {
        Sent("sent"), Rejected("rejected"), Failed("failed");
        companion object { fun of(wire: String?): Kind? = entries.firstOrNull { it.wire == wire } }
    }
}

const val UNKNOWN_SENDS_KEY: String = "clave.unknown-sends"

private fun parseOrNull(raw: String): JsonElement? = try {
    Json.parseToJsonElement(raw)
} catch (_: Exception) {
    null
}

private fun encodeSend(send: UnknownSend): JsonObject = buildJsonObject {
    put("machineId", send.machineId)
    put("sessionId", send.sessionId)
    put("clientMessageId", send.clientMessageId)
    put("text", send.text)
    put("at", send.at)
    send.draftText?.let { put("draftText", it) }
    send.attachments?.let { list -> put("attachments", JsonArray(list.map(AttachmentJson::encode))) }
    if (send.discarded) put("discarded", true)
    send.end?.let { end ->
        put(
            "end",
            buildJsonObject {
                put("kind", end.kind.wire)
                put("reason", end.reason)
                put("at", end.at)
            },
        )
    }
    if (send.completionRefused) put("completionRefused", true)
}

private fun flagOf(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

/** An entry written before the end existed has none; an end of a kind this build does not know is none. */
private fun decodeEnd(value: JsonElement?): SendEnd? {
    val o = value as? JsonObject ?: return null
    val kind = SendEnd.Kind.of(stringOf(o["kind"])) ?: return null
    return SendEnd(kind, stringOf(o["reason"]) ?: "", numberOf(o["at"])?.toLong() ?: 0)
}

/** Fields this build does not know are ignored; the ones it knows and does not find take their defaults. */
private fun decodeSend(value: JsonElement): UnknownSend? {
    val o = value as? JsonObject ?: return null
    return UnknownSend(
        machineId = stringOf(o["machineId"]) ?: return null,
        sessionId = stringOf(o["sessionId"]) ?: return null,
        clientMessageId = stringOf(o["clientMessageId"]) ?: return null,
        text = stringOf(o["text"]) ?: return null,
        at = numberOf(o["at"])?.toLong() ?: 0,
        draftText = stringOf(o["draftText"]),
        attachments = (o["attachments"] as? JsonArray)?.mapNotNull(AttachmentJson::decode),
        discarded = flagOf(o["discarded"]),
        end = decodeEnd(o["end"]),
        completionRefused = flagOf(o["completionRefused"]),
    )
}

class UnknownSends(private val store: KeyValueStore) {
    /** Every change is a read-modify-write of one key: two at once must not drop an id. */
    private val writing = Mutex()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    /** Called after every write of the ledger (a send's entry in, changed or out); answers the unsubscribe. */
    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    suspend fun list(): List<UnknownSend> {
        val raw = store.get(UNKNOWN_SENDS_KEY)
        if (raw.isNullOrEmpty()) return emptyList()
        val parsed = parseOrNull(raw) as? JsonArray ?: return emptyList()
        return parsed.mapNotNull(::decodeSend)
    }

    suspend fun forMachine(machineId: String): List<UnknownSend> = list().filter { it.machineId == machineId }

    suspend fun forSession(machineId: String, sessionId: String): List<UnknownSend> =
        list().filter { it.machineId == machineId && it.sessionId == sessionId }

    /** Keeps the send, replacing one of the same id. */
    suspend fun add(send: UnknownSend): Unit = writing.withLock {
        write(list().filter { it.clientMessageId != send.clientMessageId } + send)
    }

    suspend fun remove(clientMessageId: String): Unit = writing.withLock {
        write(list().filter { it.clientMessageId != clientMessageId })
    }

    /** Records the person's discard in the send's entry, awaited until the store has it; false when
     *  the send is no longer waiting (out of the ledger, or its end recorded meanwhile), and then
     *  nothing is written. */
    suspend fun markDiscarded(clientMessageId: String): Boolean = writing.withLock {
        val sends = list()
        if (sends.none { it.clientMessageId == clientMessageId && it.end == null }) return@withLock false
        write(sends.map { if (it.clientMessageId == clientMessageId) it.copy(discarded = true) else it })
        true
    }

    /**
     * Records how the send ended in its entry, awaited until the store has it, before any cleanup of
     * it; what the server answered stands over a discard recorded since. An end already recorded
     * stays (the first is the one finished). Answers the entry as it now stands, or null when the
     * send is no longer in the ledger, and then nothing is written. Throws what the store throws,
     * and then nothing is recorded.
     */
    suspend fun markEnded(clientMessageId: String, end: SendEnd): UnknownSend? = writing.withLock {
        val sends = list()
        val entry = sends.firstOrNull { it.clientMessageId == clientMessageId } ?: return@withLock null
        if (entry.end != null) return@withLock entry
        val ended = entry.copy(end = end)
        write(sends.map { if (it.clientMessageId == clientMessageId) ended else it })
        ended
    }

    /** Records that a same-id completion of this send was refused; false when it is no longer waiting. */
    suspend fun markCompletionRefused(clientMessageId: String): Boolean = writing.withLock {
        val sends = list()
        val entry = sends.firstOrNull { it.clientMessageId == clientMessageId && !it.decided } ?: return@withLock false
        if (!entry.completionRefused) {
            write(sends.map { if (it.clientMessageId == clientMessageId) it.copy(completionRefused = true) else it })
        }
        true
    }

    private suspend fun write(sends: List<UnknownSend>) {
        if (sends.isEmpty()) store.remove(UNKNOWN_SENDS_KEY)
        else store.set(UNKNOWN_SENDS_KEY, JsonArray(sends.map(::encodeSend)).toString())
        for (listener in listeners) listener()
    }
}

data class DeliveryMark(val kind: Kind, val clientMessageId: String, val reason: String, val at: Long) {
    enum class Kind(val wire: String) {
        Unknown("unknown"), Rejected("rejected");
        companion object { fun of(wire: String?): Kind? = entries.firstOrNull { it.wire == wire } }
    }
}

fun deliveryMarkKey(machineId: String, sessionId: String): String = "clave.delivery:$machineId:$sessionId"

class DeliveryMarks(private val store: KeyValueStore) {
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    /** Called after every set and clear; answers the unsubscribe. */
    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    private fun changed() {
        for (listener in listeners) listener()
    }

    /** The mark, or null; an unreadable mark is no mark. */
    suspend fun get(machineId: String, sessionId: String): DeliveryMark? {
        val raw = store.get(deliveryMarkKey(machineId, sessionId))
        if (raw.isNullOrEmpty()) return null
        val o = parseOrNull(raw) as? JsonObject ?: return null
        val kind = DeliveryMark.Kind.of(stringOf(o["kind"])) ?: return null
        val id = stringOf(o["clientMessageId"]) ?: return null
        return DeliveryMark(kind, id, stringOf(o["reason"]) ?: "", numberOf(o["at"])?.toLong() ?: 0)
    }

    suspend fun set(machineId: String, sessionId: String, mark: DeliveryMark) {
        val json = buildJsonObject {
            put("kind", mark.kind.wire)
            put("clientMessageId", mark.clientMessageId)
            put("reason", mark.reason)
            put("at", mark.at)
        }
        store.set(deliveryMarkKey(machineId, sessionId), json.toString())
        changed()
    }

    suspend fun clear(machineId: String, sessionId: String) {
        store.remove(deliveryMarkKey(machineId, sessionId))
        changed()
    }
}
