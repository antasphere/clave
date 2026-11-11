package com.clave.core.devices

import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.PairingRead
import com.clave.core.contract.PairingStatus
import com.clave.core.contract.PairingTicket
import com.clave.core.ports.Clock
import kotlin.coroutines.cancellation.CancellationException

/**
 * The pairing as a state machine (decision 3 of the spec): the phone asks with its ID token
 * and its client id, waits while the owner approves or refuses it on the Mac (Settings →
 * Mobile), polling every two seconds, and on the approval takes the device session the
 * server hands out once: the credential goes to the credential store under the machine id,
 * with the machine's road as the server URL, and the record of the pairing to the
 * enrollment records. A refusal, a lapse and a failure are said plainly as states, so a
 * screen renders each; nothing is retried on its own.
 */
public sealed interface PairingState {
    public data object Requesting : PairingState

    public data class Waiting(
        val pairingId: String,
        val expiresAt: Long,
        /** How many times the server was asked so far. */
        val polls: Int,
    ) : PairingState

    public data class Approved(val record: EnrollmentRecord) : PairingState
    public data object Refused : PairingState
    public data object Expired : PairingState
    public data object Cancelled : PairingState
    public data class Failed(val failure: EnrollmentFailure, val message: String, val check: String? = null) : PairingState
}

public data class PairingInput(
    val machineId: String,
    val baseUrl: String,
    val idToken: String,
    val clientId: String,
    val device: DeviceDescription,
) {
    override fun toString(): String =
        "PairingInput(machineId=$machineId, baseUrl=$baseUrl, idToken=<redacted>, clientId=$clientId, device=$device)"
}

public class PairingPorts(
    public val client: PairingClient,
    public val credentials: CredentialStore,
    public val records: EnrollmentRecords,
    /** Commits the approval within the owner's current lifecycle boundary; false means
     *  cancelled (the account changed while the pairing waited). */
    public val persist: (suspend (EnrollmentRecord, Credential) -> Boolean)? = null,
    public val sleep: suspend (Long) -> Unit,
    public val clock: Clock,
    /** Every state as it happens, for the screen. */
    public val onState: (PairingState) -> Unit = {},
    /** The person left the screen: polling stops at the next step. */
    public val cancelled: () -> Boolean = { false },
)

public data class PairingOptions(
    /** Between two reads of the pairing. */
    val pollMs: Long = POLL_MS,
    /** Past the server's own deadline, how long a still-pending answer is believed before
     *  the pairing is read as lapsed here. */
    val graceMs: Long = 60_000,
)

public const val POLL_MS: Long = 2_000

private fun failed(error: Exception): PairingState.Failed =
    if (error is EnrollmentError) PairingState.Failed(error.kind, error.message ?: "", error.check)
    else PairingState.Failed(EnrollmentFailure.Protocol, error.message ?: error.toString())

private fun transient(error: Exception): Boolean =
    error is EnrollmentError && (error.kind == EnrollmentFailure.Network || error.kind == EnrollmentFailure.Timeout)

public suspend fun pair(input: PairingInput, ports: PairingPorts, options: PairingOptions = PairingOptions()): PairingState {
    fun emit(state: PairingState): PairingState {
        ports.onState(state)
        return state
    }
    fun cancelled() = ports.cancelled()

    emit(PairingState.Requesting)
    if (cancelled()) return emit(PairingState.Cancelled)
    val ticket: PairingTicket = try {
        ports.client.requestPairing(input.idToken, input.clientId, input.device)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return emit(failed(e))
    }
    if (cancelled()) return emit(PairingState.Cancelled)
    var polls = 0
    fun waiting() = PairingState.Waiting(ticket.pairingId, ticket.expiresAt, polls)
    emit(waiting())
    while (true) {
        if (cancelled()) return emit(PairingState.Cancelled)
        ports.sleep(options.pollMs)
        if (cancelled()) return emit(PairingState.Cancelled)
        polls += 1
        val read: PairingRead = try {
            ports.client.readPairing(ticket.pairingId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The network, not the server: the owner may still be about to answer, so the
            // wait goes on until the server's own deadline.
            if (transient(e) && ports.clock.now() <= ticket.expiresAt + options.graceMs) {
                emit(waiting())
                continue
            }
            return emit(failed(e))
        }
        if (cancelled()) return emit(PairingState.Cancelled)
        when (read.status) {
            PairingStatus.Pending -> {
                if (ports.clock.now() > ticket.expiresAt + options.graceMs) return emit(PairingState.Expired)
                emit(waiting())
            }
            PairingStatus.Refused -> return emit(PairingState.Refused)
            PairingStatus.Expired -> return emit(PairingState.Expired)
            PairingStatus.Approved -> {
                val session = read.deviceSession
                    ?: return emit(
                        PairingState.Failed(
                            EnrollmentFailure.Consumed,
                            "The approval was already handed out and cannot be read again. Pair again.",
                        ),
                    )
                val record = EnrollmentRecord(
                    machineId = input.machineId,
                    deviceId = session.deviceId,
                    serverId = session.serverId,
                    serverName = session.serverName,
                    pairedAt = ports.clock.now(),
                )
                val credential = Credential(input.baseUrl, session.token)
                if (cancelled()) return emit(PairingState.Cancelled)
                val persist = ports.persist
                if (persist != null) {
                    if (!persist(record, credential) || cancelled()) return emit(PairingState.Cancelled)
                } else {
                    ports.credentials.set(input.machineId, credential)
                    ports.records.set(record)
                }
                return emit(PairingState.Approved(record))
            }
        }
    }
}
