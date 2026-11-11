/**
 * A send and what the phone does when its outcome is not seen (decision 10 of the spec and
 * the write-status seam of 29 October 2026): the message goes out under an id the phone
 * minted; when the write's answer is lost (a reset, a timeout, the network gone), the phone
 * asks the server what it knows of that id and applies the table:
 *
 * - `accepted`: the message counts as sent.
 * - `pending`: ask again with backoff, for at most 60 s; then `unknown`.
 * - `rejected`: the draft is kept and the reason shown; a resend is a new id.
 * - `absent`: the same send is completed once with the same id; a second loss is `unknown`.
 * - `unknown`: nothing is sent by itself. A server without the status route (404) cannot
 *   tell either: `unknown`.
 *
 * Ported from `apps/mobile/src/chat/send.ts`; pure over its ports.
 */
package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import kotlin.coroutines.cancellation.CancellationException

/**
 * Why a session write or a status ask failed, as the transport reports it. The transport
 * module throws this exact class from its write, so the send table can tell a lost outcome
 * (network, timeout, an unreadable answer) from a refusal the server declared.
 */
class SendFailure(
    val kind: Kind,
    message: String,
    /** The HTTP status, when an answer arrived. */
    val status: Int? = null,
    /** The `_tag` of the server's declared failure on a refusal (`SessionWriteRefused`, …). */
    val failureTag: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    enum class Kind {
        /** 401: the bearer is not this server's. */
        Unauthenticated,
        /** 422 with a declared failure. */
        Refused,
        /** The request never completed. */
        Network,
        /** The deadline passed before an answer. */
        Timeout,
        /** The server answered something this client does not read. */
        Protocol,
        /** The address is not one this build sends a credential to. */
        Policy,
    }
}

/** The reason of a same-id completion that did not leave because the person discarded the send first. */
const val DISCARDED_FIRST: String = "Discarded before the reconnection sent it again."

interface SendPorts {
    /** Performs the write under this id; throws a [SendFailure] on failure. */
    suspend fun write(clientMessageId: String): WriteAnswer
    /** Asks the server what it knows of the id; throws on failure. */
    suspend fun status(clientMessageId: String): WriteStatus
    suspend fun sleep(ms: Long)
    fun now(): Long

    /** Asked right before the same-id completion leaves: false once that send must not be
     *  written any more, the person having discarded it first. */
    suspend fun mayComplete(clientMessageId: String): Boolean = true

    /** Whether the person has discarded this send: a pass stops waiting on its status then. */
    suspend fun discarded(clientMessageId: String): Boolean = false

    /** Whether a same-id completion of this send was refused before: it is not sent again by itself. */
    suspend fun completionRefused(clientMessageId: String): Boolean = false
}

/** Why a send whose same-id completion was refused before is not completed again by a pass. */
const val COMPLETION_REFUSED: String =
    "The machine refused this message when it was sent again, so it is not sent again by itself. Whether the first one arrived is not known."

/** The reason a refused same-id completion leaves on the send: the server's own words, then what it does not prove. */
fun completionRefusedReason(refusal: String): String =
    "The machine refused this message when it was sent again ($refusal). Whether the first one arrived is not known."

sealed interface SendOutcome {
    val clientMessageId: String

    /** The message landed: at once, or found `accepted` on reconciliation. */
    data class Sent(override val clientMessageId: String, val reconciled: Boolean) : SendOutcome
    /** The server refused the write or recorded it rejected: the draft stays. */
    data class Rejected(override val clientMessageId: String, val reason: String) : SendOutcome
    /**
     * Nobody can tell: the draft stays, nothing was sent by itself. [completionRefused]: the same-id
     * completion of a send whose first write was not seen was refused (401, 403, a declared 422); the
     * first may still arrive, so it stays unknown, and no pass sends the completion again.
     */
    data class Unknown(override val clientMessageId: String, val reason: String, val completionRefused: Boolean = false) : SendOutcome
    /** Another kind of failure (the token refused, a policy refusal): the draft stays. */
    data class Failed(override val clientMessageId: String, val reason: String) : SendOutcome
}

data class SendOptions(
    /** How long `pending` is asked again before it counts as `unknown`. */
    val pendingBudgetMs: Long = 60_000,
    /** The first wait between two status asks; doubles up to [maxBackoffMs]. */
    val backoffMs: Long = 1_000,
    val maxBackoffMs: Long = 8_000,
)

private fun outcomeLost(error: Throwable): Boolean =
    error is SendFailure &&
        (error.kind == SendFailure.Kind.Network || error.kind == SendFailure.Kind.Timeout || error.kind == SendFailure.Kind.Protocol)

internal fun reasonOf(error: Throwable): String = error.message ?: error.toString()

/** One send: the write, then the table when the answer was lost. */
suspend fun sendMessage(clientMessageId: String, ports: SendPorts, options: SendOptions = SendOptions()): SendOutcome {
    try {
        val answer = ports.write(clientMessageId)
        if (answer.status == WriteAnswerStatus.Accepted) return SendOutcome.Sent(clientMessageId, reconciled = false)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        if (!outcomeLost(error)) return refusal(clientMessageId, error)
    }
    return reconcile(clientMessageId, ports, options, mayRetry = true)
}

/** The server answered the write with a refusal: the message did not land, or nobody knows. */
private fun refusal(clientMessageId: String, error: Throwable): SendOutcome {
    if (error is SendFailure && error.failureTag == "SessionWriteUnknown") {
        return SendOutcome.Unknown(clientMessageId, reasonOf(error))
    }
    if (error is SendFailure && error.kind == SendFailure.Kind.Refused) {
        val rejected = error.failureTag == "SessionWriteRefused" || error.failureTag == "SessionNotFound"
        return if (rejected) SendOutcome.Rejected(clientMessageId, reasonOf(error)) else SendOutcome.Unknown(clientMessageId, reasonOf(error))
    }
    return SendOutcome.Failed(clientMessageId, reasonOf(error))
}

/**
 * The table, for a send whose outcome was not seen. [mayRetry] is the one same-id retry
 * `absent` permits; it is spent by the first `absent`, so a send lost twice ends `unknown`.
 */
suspend fun reconcile(
    clientMessageId: String,
    ports: SendPorts,
    options: SendOptions = SendOptions(),
    mayRetry: Boolean = true,
): SendOutcome {
    val budget = options.pendingBudgetMs
    val maxBackoff = options.maxBackoffMs
    var backoff = options.backoffMs
    val started = ports.now()
    while (true) {
        val status = try {
            ports.status(clientMessageId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // A server without the route (404), or one we cannot reach: it cannot tell, and
            // neither can the phone.
            return SendOutcome.Unknown(
                clientMessageId,
                if (error is SendFailure && error.status == 404) {
                    "This server cannot say whether the message arrived."
                } else "The server could not be asked whether the message arrived (${reasonOf(error)}).",
            )
        }
        when (status.status) {
            WriteStatusKind.Accepted -> return SendOutcome.Sent(clientMessageId, reconciled = true)
            WriteStatusKind.Rejected ->
                return SendOutcome.Rejected(clientMessageId, status.reason ?: "The server refused the message.")
            WriteStatusKind.Unknown ->
                return SendOutcome.Unknown(clientMessageId, status.reason ?: "The server cannot say whether the message arrived.")
            WriteStatusKind.Absent -> {
                if (!mayRetry) {
                    return SendOutcome.Unknown(
                        clientMessageId,
                        "The message was sent again once and its outcome is still not known.",
                    )
                }
                // Refused once, the completion is never sent again by itself: the person decides.
                if (ports.completionRefused(clientMessageId)) {
                    return SendOutcome.Unknown(clientMessageId, COMPLETION_REFUSED, completionRefused = true)
                }
                // The person's discard and this completion: whichever comes first decides.
                if (!ports.mayComplete(clientMessageId)) return SendOutcome.Unknown(clientMessageId, DISCARDED_FIRST)
                try {
                    val answer = ports.write(clientMessageId)
                    if (answer.status == WriteAnswerStatus.Accepted) return SendOutcome.Sent(clientMessageId, reconciled = true)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    // Every answer but a lost one refuses the completion alone: a 401, a 403, a policy, or a
                    // declared 422 (SessionWriteRefused, SessionNotFound, SessionWriteUnknown). None proves
                    // the first write absent, which may still arrive: unknown, never completed again by a
                    // pass. Only a status read settles it then (accepted, or rejected through its end).
                    if (!outcomeLost(error)) {
                        return SendOutcome.Unknown(clientMessageId, completionRefusedReason(reasonOf(error)), completionRefused = true)
                    }
                }
                return reconcile(clientMessageId, ports, options, mayRetry = false)
            }
            WriteStatusKind.Pending -> {
                if (ports.discarded(clientMessageId)) return SendOutcome.Unknown(clientMessageId, DISCARDED_FIRST)
                if (ports.now() - started >= budget) {
                    return SendOutcome.Unknown(clientMessageId, "The server is still working on the message after a minute.")
                }
                ports.sleep(minOf(backoff, maxOf(0, budget - (ports.now() - started))))
                backoff = minOf(maxBackoff, backoff * 2)
            }
        }
    }
}
