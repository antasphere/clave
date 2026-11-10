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
     *  the pass read it: it is left alone. */
    val discarded: (suspend (UnknownSend) -> Boolean)? = null,
    /** Right before this send's same-id completion leaves: false when the person discarded it first. */
    val mayComplete: (suspend (UnknownSend) -> Boolean)? = null,
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
            }
            try {
                val outcome = reconcile(send.clientMessageId, sendPorts, options, mayRetry = true)
                // Discarded meanwhile and still unknown (the completion not sent, or the server
                // unable to say): the person's discard settles it. What the server answered
                // (accepted, rejected) is settled here whatever the person chose since.
                if (outcome is SendOutcome.Unknown && ports.discarded?.invoke(send) == true) continue
                outcomes.add(SettledSend(send, outcome))
                settleSend(send, outcome, ports.sends, ports.marks, ports.drafts, ports.now, ports.clearAttachments)
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

/** The ledger, the draft and the mark after one send's outcome. */
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
        is SendOutcome.Sent -> {
            sends.remove(send.clientMessageId)
            // A draft edited since the send is the person's new text, never cleared.
            if (drafts.get(send.machineId, send.sessionId) == (send.draftText ?: send.text)) {
                drafts.clear(send.machineId, send.sessionId)
            }
            clearAttachments?.invoke(send)
            marks.clear(send.machineId, send.sessionId)
        }
        is SendOutcome.Rejected -> {
            sends.remove(send.clientMessageId)
            marks.set(send.machineId, send.sessionId, DeliveryMark(DeliveryMark.Kind.Rejected, send.clientMessageId, outcome.reason, now()))
        }
        is SendOutcome.Unknown ->
            marks.set(send.machineId, send.sessionId, DeliveryMark(DeliveryMark.Kind.Unknown, send.clientMessageId, outcome.reason, now()))
        // The machine is not reachable after all: the send waits for the next pass.
        is SendOutcome.Failed -> Unit
    }
}

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

/** The person chose to discard a send of unknown outcome: it leaves the ledger and the mark. */
suspend fun discardUnknownSend(
    machineId: String,
    sessionId: String,
    clientMessageId: String,
    sends: UnknownSends,
    marks: DeliveryMarks,
) {
    sends.remove(clientMessageId)
    marks.clear(machineId, sessionId)
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
     * The decision is written into the send's ledger entry, and awaited, before the wait, so a
     * controller built again over the same stores after the process ended (while a pass held this
     * send) finds it and carries the discard out instead of completing the send ([finishRecordedDiscards]).
     * Then, once the pass has let go of the ledger, the send leaves it and its mark is cleared.
     * What the server answered before the discard stands and is said: accepted (it arrived),
     * rejected, or a completion already on its way. A record the store failed to write discards
     * nothing ([DiscardResult.NotSaved]), once the pass has let go.
     */
    suspend fun discard(machineId: String, sessionId: String, clientMessageId: String): DiscardResult {
        if (inFlight(clientMessageId)) return DiscardResult.InFlight
        if (decisions.putIfAbsent(clientMessageId, Decision.Discarded) == Decision.Completing) return DiscardResult.BeingCompleted
        // Once decided, the discard is carried through even when its caller is cancelled meanwhile (a
        // screen closing): a decision left behind would make every pass skip the send.
        return withContext(NonCancellable) {
            // The store returns once the write is on disk; what this guards is a process that ends
            // during the wait below, not a power loss. The entry, its mark and the draft are separate
            // writes, not one transaction.
            val recorded = try {
                sends.markDiscarded(clientMessageId)
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
                when {
                    inFlight(clientMessageId) -> DiscardResult.InFlight
                    sends.forSession(machineId, sessionId).any { it.clientMessageId == clientMessageId } -> {
                        if (recorded) {
                            discardUnknownSend(machineId, sessionId, clientMessageId, sends, marks)
                            DiscardResult.Discarded
                        } else {
                            DiscardResult.NotSaved
                        }
                    }
                    else -> when (synchronized(settledLately) { settledLately[clientMessageId] }) {
                        true -> DiscardResult.AlreadyDelivered
                        false -> DiscardResult.AlreadyRejected
                        null -> DiscardResult.NothingToDiscard
                    }
                }
            } finally {
                decisions.remove(clientMessageId, Decision.Discarded)
            }
        }

    /**
     * Whether the ledger still holds this send waiting for its outcome: no discard recorded in its
     * entry (by this controller, another one over the same stores, or one whose process ended), and
     * not settled since the pass read the ledger. Read from the store, not from this controller's memory.
     */
    private suspend fun waiting(send: UnknownSend): Boolean =
        sends.list().any { it.clientMessageId == send.clientMessageId && !it.discarded }

    /**
     * Carries out, at the start of a pass and under its lock, every discard recorded in this machine's
     * ledger that no Discard of this controller is still carrying out: what a process leaves when it
     * ends while its Discard waits for a pass. The send leaves the ledger and its mark is cleared, as
     * the Discard would have done, and it is never reconciled. The drafts stay as they are: that Discard
     * may have been a Send again, whose text was never sent.
     */
    private suspend fun finishRecordedDiscards(machineId: String) {
        for (send in sends.forMachine(machineId)) {
            if (!send.discarded || active.contains(send.clientMessageId)) continue
            if (decisions[send.clientMessageId] == Decision.Discarded) continue
            discardUnknownSend(send.machineId, send.sessionId, send.clientMessageId, sends, marks)
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

    suspend fun begin(send: UnknownSend) {
        active.add(send.clientMessageId)
        try {
            recordUnknownSend(send, "Delivery has not been confirmed.", sends, marks)
        } catch (error: Throwable) {
            active.remove(send.clientMessageId)
            throw error
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

    suspend fun finish(send: UnknownSend, outcome: SendOutcome) {
        try {
            settleSend(send, outcome, sends, marks, drafts, clock::now, clearAttachments)
            noteSettled(send.clientMessageId, outcome)
            if (outcome is SendOutcome.Failed) {
                // The write itself failed (a refused token, a policy): nothing is in doubt.
                sends.remove(send.clientMessageId)
                marks.clear(send.machineId, send.sessionId)
            }
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
                            finishRecordedDiscards(machineId)
                            block()
                        }
                    },
                    discarded = { decisions[it.clientMessageId] == Decision.Discarded || !waiting(it) },
                    mayComplete = { waiting(it) && decisions.putIfAbsent(it.clientMessageId, Decision.Completing) != Decision.Discarded },
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
