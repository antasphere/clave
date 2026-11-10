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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException

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
     *  there, so the person's discard waits for it and a discarded send is never completed. */
    val exclusive: suspend (suspend () -> Unit) -> Unit = { block -> block() },
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
            val sendPorts = object : SendPorts {
                override suspend fun write(clientMessageId: String): WriteAnswer = ports.write(send)
                override suspend fun status(clientMessageId: String): WriteStatus = ports.status(send)
                override suspend fun sleep(ms: Long) = ports.sleep(ms)
                override fun now(): Long = ports.now()
            }
            val outcome = reconcile(send.clientMessageId, sendPorts, options, mayRetry = true)
            outcomes.add(SettledSend(send, outcome))
            settleSend(send, outcome, ports.sends, ports.marks, ports.drafts, ports.now, ports.clearAttachments)
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

    /**
     * The person's explicit choice on a send of unknown outcome ("Send again" or "Discard"): once
     * any reconnection pass of the machine has finished, the send leaves the ledger and its mark
     * is cleared. False when there is nothing to discard: the send was settled meanwhile (the
     * pass found it accepted, completed it, or saw it refused), or its own write is in flight.
     */
    suspend fun discard(machineId: String, sessionId: String, clientMessageId: String): Boolean =
        passLock(machineId).withLock {
            if (inFlight(clientMessageId)) return@withLock false
            if (sends.forSession(machineId, sessionId).none { it.clientMessageId == clientMessageId }) return@withLock false
            sends.remove(clientMessageId)
            marks.clear(machineId, sessionId)
            true
        }

    /** The attachment draft goes only when it is still the records sent. */
    private val clearAttachments: suspend (UnknownSend) -> Unit = { send ->
        val key = attachmentDraftKey(send.machineId, send.sessionId)
        if (kv.get(key) == AttachmentJson.encodeList(send.attachments ?: emptyList())) kv.remove(key)
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

    suspend fun finish(send: UnknownSend, outcome: SendOutcome) {
        try {
            settleSend(send, outcome, sends, marks, drafts, clock::now, clearAttachments)
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
                    exclusive = { block -> passLock(machineId).withLock { block() } },
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
