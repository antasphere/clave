/**
 * The reconnection pass (decision 10 of the spec, the write-status seam of 29 October 2026):
 * when the machine is reachable again, the phone asks the server about every send whose
 * outcome it does not know and applies the table ([reconcile]), then refreshes the pending
 * requests and the history of the open conversations. Nothing is sent merely because the
 * connection came back:
 *
 * - `accepted`: the send leaves the ledger, the draft is cleared when it is still the text
 *   sent, the mark is cleared.
 * - `pending`: asked again with backoff for at most a minute, then `unknown`.
 * - `rejected`: the send leaves the ledger, the draft stays with the reason as its mark.
 * - `absent`: the same send is completed with the same id and bytes, once.
 * - `unknown`: nothing is sent; the send stays in the ledger, the draft stays, marked.
 *
 * Every end (sent, rejected, the composer's own write refused, a discard) is recorded in the send's
 * ledger entry before its cleanup, and the entry leaves last ([finishEnd]); a recorded end is never
 * asked about or written again, and a controller built again over the same stores finishes it with
 * no server ([DeliveryController.finishRecordedEnds]). A same-id completion refused (401, 403, a declared 422) keeps
 * the send unknown and is not sent again by itself.
 *
 * Ported from `apps/mobile/src/reconnect/pass.ts` and `controller.ts`.
 */
package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteStatus
import com.clave.core.ports.Clock
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.SystemClock
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

data class ReconnectPorts(
    val sends: UnknownSends,
    val marks: DeliveryMarks,
    val drafts: Drafts,
    /** `GET /sessions/writes` for this send; throws on failure. */
    val status: suspend (UnknownSend) -> WriteStatus,
    /** The same message under the same id; throws a [SendFailure] on failure. */
    val write: suspend (UnknownSend) -> WriteAnswer,
    val sleep: suspend (Long) -> Unit,
    val now: () -> Long,
    val refreshRequests: suspend (machineId: String) -> Unit,
    val refreshHistory: suspend (machineId: String, sessionId: String) -> Unit,
    val clearAttachments: (suspend (UnknownSend) -> Unit)? = null,
    /** A send whose own write is still in flight: the pass leaves it to its sender. */
    val isActive: ((UnknownSend) -> Boolean)? = null,
    /** Runs the reconciliation of the ledger's sends; the controller holds the machine's lock
     *  there, so the ledger is read and settled by one pass at a time. */
    val exclusive: suspend (suspend () -> Unit) -> Unit = { block -> block() },
    /** Whether the person discarded this send before the pass reached it, or it left the ledger since
     *  the pass read it, or its end is recorded (decided, only its cleanup is left): it is left alone. */
    val discarded: (suspend (UnknownSend) -> Boolean)? = null,
    /** Right before this send's same-id completion leaves: false when the person discarded it first. */
    val mayComplete: (suspend (UnknownSend) -> Boolean)? = null,
    /** Whether a same-id completion of this send was refused before, read from the store; without
     *  this port, what the ledger said when the pass read it. */
    val completionRefused: (suspend (UnknownSend) -> Boolean)? = null,
    /** This send's reconciliation is over, whatever it found. */
    val reconciled: ((UnknownSend) -> Unit)? = null,
    /** The pass settled this send with this outcome. */
    val settled: ((UnknownSend, SendOutcome) -> Unit)? = null,
)

data class ReconnectInput(
    val machineId: String,
    /** The ids of the conversations open on the phone, whose history is refreshed. */
    val openConversations: List<String>,
)

data class SettledSend(val send: UnknownSend, val outcome: SendOutcome)

data class ReconnectReport(
    val outcomes: List<SettledSend>,
    val requestsRefreshed: Boolean,
    val historyRefreshed: List<String>,
    val refreshFailures: List<String>,
)

suspend fun reconnectPass(input: ReconnectInput, ports: ReconnectPorts, options: SendOptions = SendOptions()): ReconnectReport {
    val outcomes = mutableListOf<SettledSend>()
    ports.exclusive {
        for (send in ports.sends.forMachine(input.machineId)) {
            if (ports.isActive?.invoke(send) == true) continue
            // Discarded by the person while the pass worked on another send: never reconciled.
            if (ports.discarded?.invoke(send) == true) continue
            val sendPorts = object : SendPorts {
                override suspend fun write(clientMessageId: String): WriteAnswer = ports.write(send)
                override suspend fun status(clientMessageId: String): WriteStatus = ports.status(send)
                override suspend fun sleep(ms: Long) = ports.sleep(ms)
                override fun now(): Long = ports.now()
                override suspend fun mayComplete(clientMessageId: String): Boolean = ports.mayComplete?.invoke(send) ?: true
                override suspend fun discarded(clientMessageId: String): Boolean = ports.discarded?.invoke(send) ?: false
                override suspend fun completionRefused(clientMessageId: String): Boolean =
                    ports.completionRefused?.invoke(send) ?: send.completionRefused
            }
            try {
                val outcome = reconcile(send.clientMessageId, sendPorts, options, mayRetry = true)
                // Discarded meanwhile and still unknown (the completion not sent, or the server
                // unable to say): the person's discard settles it. What the server answered
                // (accepted, rejected) is settled here whatever the person chose since.
                if (outcome is SendOutcome.Unknown && ports.discarded?.invoke(send) == true) continue
                // A store that fails to record the end throws here: the send stays as it was, unreported.
                settleSend(send, outcome, ports.sends, ports.marks, ports.drafts, ports.now, ports.clearAttachments)
                outcomes.add(SettledSend(send, outcome))
                ports.settled?.invoke(send, outcome)
            } finally {
                ports.reconciled?.invoke(send)
            }
        }
    }
    val refreshFailures = mutableListOf<String>()
    var requestsRefreshed = false
    try {
        ports.refreshRequests(input.machineId)
        requestsRefreshed = true
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        refreshFailures.add("requests: ${reasonOf(error)}")
    }
    val historyRefreshed = mutableListOf<String>()
    for (sessionId in input.openConversations) {
        try {
            ports.refreshHistory(input.machineId, sessionId)
            historyRefreshed.add(sessionId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            refreshFailures.add("history $sessionId: ${reasonOf(error)}")
        }
    }
    return ReconnectReport(outcomes, requestsRefreshed, historyRefreshed, refreshFailures)
}

/**
 * The ledger, the draft and the mark after one send's outcome. Sent and Rejected are ends: recorded
 * in the send's entry first ([endSend]), then cleaned up from that record. Unknown keeps the send
 * waiting, marked; a refused same-id completion also holds it from any further completion, written
 * before its mark. Failed does not reach here from a pass (a refused completion stays unknown); the
 * composer's own first write refused is ended by [DeliveryController.finish].
 */
suspend fun settleSend(
    send: UnknownSend,
    outcome: SendOutcome,
    sends: UnknownSends,
    marks: DeliveryMarks,
    drafts: Drafts,
    now: () -> Long,
    clearAttachments: (suspend (UnknownSend) -> Unit)? = null,
) {
    when (outcome) {
        is SendOutcome.Sent -> endSend(send, SendEnd(SendEnd.Kind.Sent, at = now()), sends, marks, drafts, clearAttachments)
        is SendOutcome.Rejected ->
            endSend(send, SendEnd(SendEnd.Kind.Rejected, outcome.reason, now()), sends, marks, drafts, clearAttachments)
        is SendOutcome.Unknown -> {
            if (outcome.completionRefused) sends.markCompletionRefused(send.clientMessageId)
            marks.set(send.machineId, send.sessionId, DeliveryMark(DeliveryMark.Kind.Unknown, send.clientMessageId, outcome.reason, now()))
        }
        is SendOutcome.Failed -> Unit
    }
}

/**
 * Records [end] in the send's entry, awaited, then cleans up from what the entry records
 * ([finishEnd]). When the record fails it throws and nothing is cleaned up: the send stays as it
 * was. A cleanup that fails once the end is recorded is left to the next start or pass. Nothing is
 * done for a send no longer in the ledger: whoever took it out finished it, the entry leaving last.
 */
suspend fun endSend(
    send: UnknownSend,
    end: SendEnd,
    sends: UnknownSends,
    marks: DeliveryMarks,
    drafts: Drafts,
    clearAttachments: (suspend (UnknownSend) -> Unit)? = null,
) {
    val recorded = sends.markEnded(send.clientMessageId, end) ?: return
    finishQuietly(recorded, sends, marks, drafts, clearAttachments)
}

/**
 * The cleanup of a send whose end or discard its entry records, each write anchored to that record
 * and safe to run again. Sent, and a Discard: what the message carried leaves the composer's stores,
 * the draft while it is still the text sent and the records sent out of the attachment draft (an edit
 * and a file added since stay), then the mark. Rejected: the Rejected mark. Failed, a Send again (its
 * text is being sent anew) and a discard an older build recorded without its choice: the mark, the
 * drafts staying. The conversation has one mark: it is cleared or set only while it is this send's
 * own (or, to set, absent), so a newer send's is never touched. The entry leaves last, so a process
 * that ends midway leaves the record for the next start or pass to finish.
 */
suspend fun finishEnd(
    entry: UnknownSend,
    sends: UnknownSends,
    marks: DeliveryMarks,
    drafts: Drafts,
    clearAttachments: (suspend (UnknownSend) -> Unit)? = null,
) {
    val end = entry.end
    when {
        end?.kind == SendEnd.Kind.Sent -> {
            clearWhatItCarried(entry, drafts, clearAttachments)
            clearOwnMark(entry, marks)
        }
        end?.kind == SendEnd.Kind.Rejected ->
            setOwnMark(entry, marks, DeliveryMark(DeliveryMark.Kind.Rejected, entry.clientMessageId, end.reason, end.at))
        end == null && entry.discarded && entry.choice == DiscardChoice.Discard -> {
            clearWhatItCarried(entry, drafts, clearAttachments)
            clearOwnMark(entry, marks)
        }
        entry.decided -> clearOwnMark(entry, marks)
        else -> return
    }
    sends.remove(entry.clientMessageId)
}

/** The draft while it is still the text sent (an edit since is the person's new text, never cleared), and the records sent. */
private suspend fun clearWhatItCarried(entry: UnknownSend, drafts: Drafts, clearAttachments: (suspend (UnknownSend) -> Unit)?) {
    if (drafts.get(entry.machineId, entry.sessionId) == (entry.draftText ?: entry.text)) {
        drafts.clear(entry.machineId, entry.sessionId)
    }
    clearAttachments?.invoke(entry)
}

/** [finishEnd], a failure of which leaves the entry recorded for the next start or pass. */
internal suspend fun finishQuietly(
    entry: UnknownSend,
    sends: UnknownSends,
    marks: DeliveryMarks,
    drafts: Drafts,
    clearAttachments: (suspend (UnknownSend) -> Unit)?,
) {
    try {
        finishEnd(entry, sends, marks, drafts, clearAttachments)
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        // The end is recorded: the next start or pass finishes what is left, and no pass asks about it meanwhile.
    }
}

/** The conversation's mark cleared while it is this send's own; none, or another send's, stays as it is. */
private suspend fun clearOwnMark(send: UnknownSend, marks: DeliveryMarks) {
    if (marks.get(send.machineId, send.sessionId)?.clientMessageId == send.clientMessageId) {
        marks.clear(send.machineId, send.sessionId)
    }
}

/** [mark] set while the conversation's mark is this send's own or absent; a newer send's stays. */
private suspend fun setOwnMark(send: UnknownSend, marks: DeliveryMarks, mark: DeliveryMark) {
    val current = marks.get(send.machineId, send.sessionId)
    if (current == null || current.clientMessageId == send.clientMessageId) marks.set(send.machineId, send.sessionId, mark)
}

/** What the composer's own send answers when the store failed to record how it ended: it stays unknown, as stored. */
const val END_NOT_SAVED: String =
    "The phone could not save how this message's delivery ended, so it stays unknown. The next connection asks the machine again."

/** What the composer records when a send's outcome was not seen: the ledger entry and the
 *  mark, so a restart finds both. */
suspend fun recordUnknownSend(send: UnknownSend, reason: String, sends: UnknownSends, marks: DeliveryMarks) {
    sends.add(send)
    marks.set(send.machineId, send.sessionId, DeliveryMark(DeliveryMark.Kind.Unknown, send.clientMessageId, reason, send.at))
}

/** The records of a stored attachment draft as written; none when it is not a JSON list. */
private fun recordsOf(raw: String): List<JsonElement> = try {
    (Json.parseToJsonElement(raw) as? JsonArray)?.toList() ?: emptyList()
} catch (_: Exception) {
    emptyList()
}

/** The person chose to discard a send of unknown outcome: its own mark is cleared, then it leaves the ledger. */
suspend fun discardUnknownSend(
    machineId: String,
    sessionId: String,
    clientMessageId: String,
    sends: UnknownSends,
    marks: DeliveryMarks,
) {
    clearOwnMark(UnknownSend(machineId, sessionId, clientMessageId, "", 0), marks)
    sends.remove(clientMessageId)
}

/**
 * The composer's and the connection's one door to the ledger: [begin] before a write
 * leaves (so a crash mid-send is found on the next start), [finish] with its outcome, and
 * [reconnect] when a machine is reachable again, at most one pass per machine at a time (a
 * second caller joins the pass under way rather than asking the server twice).
 */
class DeliveryController(
    val sends: UnknownSends,
    val marks: DeliveryMarks,
    private val drafts: Drafts,
    private val kv: KeyValueStore,
    private val clock: Clock = SystemClock,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val active = ConcurrentHashMap.newKeySet<String>()
    private val reconnecting = HashMap<String, CompletableDeferred<ReconnectReport>>()
    private val lock = Any()

    /** Held by a machine's reconnection pass while it reconciles the ledger's sends (not while it
     *  refreshes), and by the person's discard, so a pass never completes a discarded send. */
    private val passLocks = ConcurrentHashMap<String, Mutex>()
    private fun passLock(machineId: String): Mutex = passLocks.getOrPut(machineId) { Mutex() }

    /**
     * The conversation's send whose outcome is not settled: one in flight, or one whose outcome
     * is unknown and waits for the reconnection pass or the person's choice. While it exists the
     * conversation takes no new message, since a new id would be a second logical message; the
     * reconciliation of that same id goes on.
     */
    suspend fun unsettled(machineId: String, sessionId: String): UnknownSend? =
        sends.forSession(machineId, sessionId).firstOrNull()

    /**
     * The conversation's notice of unknown delivery left without its send: a mark of kind Unknown
     * whose id is in no ledger entry. Only a build before this one leaves it (it took a settled
     * send's entry out before the mark's write, and the process ended between), with the draft and
     * files kept. Whether that message arrived nobody knows, so while it stands the conversation
     * takes no plain send and the person decides: Discard clears that mark alone, Send again sends
     * the draft under a new id. A newer send's mark is never one: its entry goes in before its mark
     * and leaves after it.
     */
    suspend fun orphan(machineId: String, sessionId: String): DeliveryMark? {
        val mark = marks.get(machineId, sessionId)?.takeIf { it.kind == DeliveryMark.Kind.Unknown } ?: return null
        return mark.takeIf { sends.list().none { it.clientMessageId == mark.clientMessageId } }
    }

    /** Whether this send's own write is still in flight. */
    fun inFlight(clientMessageId: String): Boolean = active.contains(clientMessageId)

    /** The conversations a send is being admitted or written in: one send each at a time. */
    private val claims = ConcurrentHashMap.newKeySet<String>()

    /** Takes the conversation's one send slot, before any check or id; false while another send holds it. */
    fun claim(machineId: String, sessionId: String): Boolean = claims.add(claimKey(machineId, sessionId))

    /** Gives the conversation's send slot back, once that send has settled or was refused. */
    fun release(machineId: String, sessionId: String) {
        claims.remove(claimKey(machineId, sessionId))
    }

    private fun claimKey(machineId: String, sessionId: String): String = "$machineId\u0000$sessionId"

    /** Who decided first for a send of unknown outcome: the person's discard, or the pass's same-id completion. */
    private enum class Decision { Discarded, Completing }
    private val decisions = ConcurrentHashMap<String, Decision>()

    /** What the person's discard did. */
    enum class DiscardResult {
        /** The send left the ledger and its mark: nothing of it will be sent again. */
        Discarded,
        /** The server had accepted it before the discard: it arrived. */
        AlreadyDelivered,
        /** The server had refused it: its rejection mark says why. */
        AlreadyRejected,
        /** The reconnection's same-id completion was already on its way: it can no longer be discarded. */
        BeingCompleted,
        /** Its own write is still in flight. */
        InFlight,
        /** It is no longer waiting, and how it was settled is not known here (discarded already). */
        NothingToDiscard,
        /** The phone could not record the discard: nothing was discarded, and the send still waits. */
        NotSaved,
        /** A notice of unknown delivery left without its send ([orphan]) was cleared, that mark alone:
         *  whether the message arrived is not known, so the draft and its files stay as they are. */
        OrphanCleared,
    }

    /** How the latest sends were settled, by id (accepted true, rejected false; 64 kept): what a
     *  late Discard or Send again can truthfully say. */
    private val settledLately = object : LinkedHashMap<String, Boolean>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean = size > 64
    }

    private fun noteSettled(clientMessageId: String, outcome: SendOutcome) = synchronized(settledLately) {
        when (outcome) {
            is SendOutcome.Sent -> settledLately[clientMessageId] = true
            is SendOutcome.Rejected -> settledLately[clientMessageId] = false
            else -> Unit
        }
    }

    /**
     * The person's explicit choice on a send of unknown outcome ("Send again" or "Discard"),
     * decided at once and without waiting: a reconnection pass that has not sent the same-id
     * completion yet will not send it, and a pass that has not reached the send leaves it alone.
     * The decision, with the person's [choice], is written into the send's ledger entry, and awaited,
     * before the wait, so a controller built again over the same stores after the process ended
     * (while a pass held this send) finds it and carries it out instead of completing the send
     * ([finishRecordedEnds]). Then, once the pass has let go of the ledger, it is carried out from
     * that record ([finishEnd]): a Discard takes out of the composer's stores what the message
     * carried (the draft while still its text, its files), a Send again keeps them for its new id;
     * the mark is cleared and the entry leaves last. What the server answered before the discard
     * stands and is said: accepted (it arrived), rejected, or a completion already on its way. A
     * record the store failed to write discards nothing ([DiscardResult.NotSaved]), once the pass has let go.
     */
    suspend fun discard(
        machineId: String,
        sessionId: String,
        clientMessageId: String,
        choice: DiscardChoice = DiscardChoice.Discard,
    ): DiscardResult {
        if (inFlight(clientMessageId)) return DiscardResult.InFlight
        if (decisions.putIfAbsent(clientMessageId, Decision.Discarded) == Decision.Completing) return DiscardResult.BeingCompleted
        // Once decided, the discard is carried through even when its caller is cancelled meanwhile (a
        // screen closing): a decision left behind would make every pass skip the send.
        return withContext(NonCancellable) {
            // The store returns once the write is on disk; what this guards is a process that ends
            // during the wait below, not a power loss. The entry, its mark and the draft are separate
            // writes, not one transaction.
            val recorded = try {
                sends.markDiscarded(clientMessageId, choice)
            } catch (_: Exception) {
                // Whatever the store threw, a cancellation of its own included: the claim is let go
                // only by discardDecided, under the lock, and the answer says nothing was discarded.
                false
            }
            discardDecided(machineId, sessionId, clientMessageId, recorded)
        }
    }

    /** Under the machine's lock, so no pass is midway through this send. [recorded]: the decision reached
     *  the ledger entry before the wait. Without it nothing is discarded: during the wait the decision
     *  lived in memory only, and "Discarded" is said only of one a process death could not have lost. */
    private suspend fun discardDecided(machineId: String, sessionId: String, clientMessageId: String, recorded: Boolean): DiscardResult =
        passLock(machineId).withLock {
            try {
                val entry = sends.forSession(machineId, sessionId).firstOrNull { it.clientMessageId == clientMessageId }
                val end = entry?.end
                when {
                    inFlight(clientMessageId) -> DiscardResult.InFlight
                    // Ended before the press, its cleanup not over (a store that failed): finished now, and said.
                    entry != null && end != null -> {
                        finishQuietly(entry, sends, marks, drafts, clearAttachments)
                        when (end.kind) {
                            SendEnd.Kind.Sent -> DiscardResult.AlreadyDelivered
                            SendEnd.Kind.Rejected -> DiscardResult.AlreadyRejected
                            SendEnd.Kind.Failed -> DiscardResult.Discarded
                        }
                    }
                    entry != null -> {
                        if (recorded && entry.discarded) {
                            // Carried out from its record; a cleanup the store refuses midway stays recorded for the next start or pass.
                            finishQuietly(entry, sends, marks, drafts, clearAttachments)
                            DiscardResult.Discarded
                        } else {
                            DiscardResult.NotSaved
                        }
                    }
                    else -> when (synchronized(settledLately) { settledLately[clientMessageId] }) {
                        true -> DiscardResult.AlreadyDelivered
                        false -> DiscardResult.AlreadyRejected
                        null -> clearOrphan(machineId, sessionId, clientMessageId)
                    }
                }
            } finally {
                decisions.remove(clientMessageId, Decision.Discarded)
            }
        }

    /** The [orphan] notice of this id cleared, that mark alone; nothing to discard when there is none. */
    private suspend fun clearOrphan(machineId: String, sessionId: String, clientMessageId: String): DiscardResult {
        if (orphan(machineId, sessionId)?.clientMessageId != clientMessageId) return DiscardResult.NothingToDiscard
        return try {
            marks.clear(machineId, sessionId)
            DiscardResult.OrphanCleared
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            DiscardResult.NotSaved
        }
    }

    /**
     * Whether the ledger still holds this send waiting for its outcome: not decided (no discard and no
     * end recorded in its entry, by this controller, another one over the same stores, or one whose
     * process ended), and not settled since the pass read the ledger. Read from the store, not from
     * this controller's memory.
     */
    private suspend fun waiting(send: UnknownSend): Boolean =
        sends.list().any { it.clientMessageId == send.clientMessageId && !it.decided }

    /**
     * Finishes, under the machine's lock, every end and discard recorded in this machine's ledger that
     * no settle or Discard of this controller is still carrying out: what a process leaves when it ends
     * midway through a cleanup (or a Discard waiting for a pass), and what a failed store write left.
     * Each is finished by its record ([finishEnd]) and never reconciled; one that fails stays recorded.
     * A Discard takes out what its message carried; a Send again, and a discard an older build recorded
     * without its choice, keep the drafts: that text may be the one being sent anew.
     */
    private suspend fun finishRecorded(machineId: String) {
        for (send in sends.forMachine(machineId)) {
            if (!send.decided || active.contains(send.clientMessageId)) continue
            if (decisions[send.clientMessageId] == Decision.Discarded) continue
            finishQuietly(send, sends, marks, drafts, clearAttachments)
        }
    }

    /**
     * Finishes, with no server, every end and discard the ledger records and a previous process (or a
     * failed write) left unfinished. Run when the owner session starts, before any screen reads these
     * stores (OwnerSession.open awaits it), and again at the start of every pass under the machine's
     * lock. Safe to run again: what fails stays recorded for the next time, and no pass asks about it
     * or writes it meanwhile.
     */
    suspend fun finishRecordedEnds() {
        for (machineId in sends.list().filter { it.decided }.map { it.machineId }.distinct()) {
            passLock(machineId).withLock { finishRecorded(machineId) }
        }
    }

    /** The attachment draft goes when it is still the records sent; otherwise the records sent leave it
     *  and a file the person added since stays, so a restart never brings a delivered file back. */
    private val clearAttachments: suspend (UnknownSend) -> Unit = { send ->
        val key = attachmentDraftKey(send.machineId, send.sessionId)
        val sent = send.attachments ?: emptyList()
        val stored = kv.get(key)
        if (stored == AttachmentJson.encodeList(sent)) {
            kv.remove(key)
        } else if (stored != null && sent.isNotEmpty()) {
            val kept = recordsOf(stored)
            val sentRecords = sent.map(AttachmentJson::encode)
            val remaining = kept.filterNot { it in sentRecords }
            if (remaining.size < kept.size) {
                if (remaining.isEmpty()) kv.remove(key) else kv.set(key, JsonArray(remaining).toString())
            }
        }
    }

    /** What [begin] left, the send's write not having left the phone. */
    enum class Begun {
        /** The entry and its mark are kept: the write may leave. */
        Recorded,
        /** The record failed and the ledger holds none of this send (taken out again, or never written):
         *  nothing was sent and nothing will be, so the person may be told so. */
        NotSaved,
        /** The record failed and its entry could not be taken out again: a later pass may still send it
         *  under its id, so the person must not be told that nothing was sent. */
        KeptNotSaved,
    }

    /**
     * The ledger entry, then its mark, before the write leaves, so a crash mid-send is found on the
     * next start. When the store refuses a write here, nothing has left yet: the entry is taken out
     * again before any answer ([Begun.NotSaved] once the ledger holds none of it), since a pass would
     * otherwise send what the person is told was not sent; when that undoing fails too and the entry
     * stays, the answer is [Begun.KeptNotSaved]. A cancellation is thrown as it comes, the entry left
     * as it is, like a send cancelled with its write out ([abandon]).
     */
    suspend fun begin(send: UnknownSend): Begun {
        active.add(send.clientMessageId)
        try {
            recordUnknownSend(send, "Delivery has not been confirmed.", sends, marks)
        } catch (error: Throwable) {
            active.remove(send.clientMessageId)
            if (error is CancellationException || error !is Exception) throw error
            return if (undoBegin(send)) Begun.NotSaved else Begun.KeptNotSaved
        }
        return Begun.Recorded
    }

    /** Takes a failed begin's entry out of the ledger; true once it holds none of it, read back when the removal fails. */
    private suspend fun undoBegin(send: UnknownSend): Boolean = try {
        sends.remove(send.clientMessageId)
        true
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        try {
            sends.list().none { it.clientMessageId == send.clientMessageId }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Unreadable too: whether it stays is not known, so it is answered as kept.
            false
        }
    }

    /**
     * The send's own coroutine ended before it settled (cancelled while its write was out): the
     * write may have landed, so the ledger entry, its unknown mark and the draft stay, and only
     * the in-flight mark goes. The next reconnection pass settles the same id, and the person
     * may choose meanwhile. Nothing is dropped and no other id is minted.
     */
    fun abandon(send: UnknownSend) {
        active.remove(send.clientMessageId)
    }

    /**
     * The composer's own send settled with [outcome]; answers what the person is told. An end (sent,
     * rejected, or failed: its own first write refused, a 401 or a 403, so nothing is in doubt) is
     * recorded in the send's entry first, then cleaned up from that record. When the store fails to
     * record it, nothing is cleaned up, the send stays in the ledger as it was with its unknown mark,
     * and the answer is [SendOutcome.Unknown] ([END_NOT_SAVED]): the card and its choice, since a
     * later pass still asks about that send and may complete it, so "failed" would be untrue.
     */
    suspend fun finish(send: UnknownSend, outcome: SendOutcome): SendOutcome {
        try {
            val end = when (outcome) {
                is SendOutcome.Sent -> SendEnd(SendEnd.Kind.Sent, at = clock.now())
                is SendOutcome.Rejected -> SendEnd(SendEnd.Kind.Rejected, outcome.reason, clock.now())
                is SendOutcome.Failed -> SendEnd(SendEnd.Kind.Failed, outcome.reason, clock.now())
                is SendOutcome.Unknown -> null
            }
            if (end == null) {
                settleSend(send, outcome, sends, marks, drafts, clock::now, clearAttachments)
                return outcome
            }
            val recorded = try {
                sends.markEnded(send.clientMessageId, end)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return SendOutcome.Unknown(send.clientMessageId, END_NOT_SAVED)
            }
            noteSettled(send.clientMessageId, outcome)
            if (recorded != null) finishQuietly(recorded, sends, marks, drafts, clearAttachments)
            return outcome
        } finally {
            active.remove(send.clientMessageId)
        }
    }

    suspend fun reconnect(
        machineId: String,
        openConversations: List<String>,
        write: suspend (UnknownSend) -> WriteAnswer,
        status: suspend (UnknownSend) -> WriteStatus,
        refreshRequests: suspend (machineId: String) -> Unit,
        refreshHistory: suspend (machineId: String, sessionId: String) -> Unit,
    ): ReconnectReport {
        val mine = CompletableDeferred<ReconnectReport>()
        val previous = synchronized(lock) {
            reconnecting[machineId] ?: run { reconnecting[machineId] = mine; null }
        }
        if (previous != null) return previous.await()
        try {
            val report = reconnectPass(
                ReconnectInput(machineId, openConversations),
                ReconnectPorts(
                    sends = sends,
                    marks = marks,
                    drafts = drafts,
                    status = status,
                    write = write,
                    sleep = sleep,
                    now = clock::now,
                    refreshRequests = refreshRequests,
                    refreshHistory = refreshHistory,
                    clearAttachments = clearAttachments,
                    isActive = { active.contains(it.clientMessageId) },
                    exclusive = { block ->
                        passLock(machineId).withLock {
                            finishRecorded(machineId)
                            block()
                        }
                    },
                    discarded = { decisions[it.clientMessageId] == Decision.Discarded || !waiting(it) },
                    mayComplete = { waiting(it) && decisions.putIfAbsent(it.clientMessageId, Decision.Completing) != Decision.Discarded },
                    completionRefused = { send -> sends.list().any { it.clientMessageId == send.clientMessageId && it.completionRefused } },
                    reconciled = { decisions.remove(it.clientMessageId, Decision.Completing) },
                    settled = { send, outcome -> noteSettled(send.clientMessageId, outcome) },
                ),
            )
            mine.complete(report)
            return report
        } catch (error: Throwable) {
            mine.completeExceptionally(error)
            throw error
        } finally {
            synchronized(lock) { reconnecting.remove(machineId) }
        }
    }
}
