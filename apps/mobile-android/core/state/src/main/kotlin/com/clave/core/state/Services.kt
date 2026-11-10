package com.clave.core.state

import com.clave.core.chat.DeliveryController
import com.clave.core.chat.Drafts
import com.clave.core.devices.BuildKind
import com.clave.core.devices.CredentialStore
import com.clave.core.devices.DeveloperMachineSource
import com.clave.core.devices.MachineSource
import com.clave.core.ports.Clock
import com.clave.core.ports.HttpPort
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.Log
import com.clave.core.ports.NoLog
import com.clave.core.ports.SystemClock
import com.clave.core.ports.WebSocketFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay

/** How the phone names itself to a server in the push hello. */
public const val CLIENT_NAME: String = "clave-mobile/android"

/** The push client's timers, apart so a test can shorten the reconnection backoff. */
public data class PushOptions(
    val backoffBaseMs: Long = 250,
    val backoffMaxMs: Long = 10_000,
    val livenessIntervalMs: Long = 20_000,
    val livenessTimeoutMs: Long = 10_000,
)

/**
 * Everything the store needs of the platform (store.ts `Services`). It comes in through
 * here so the store runs under JUnit with a MockWebServer standing in for the machine,
 * in-memory stores, and a clock and a sleep the test owns.
 */
public data class Services(
    /** Which build this is: decides the addresses a credential may go to. */
    val build: BuildKind,
    val credentials: CredentialStore,
    /** The relay of the team, once the sign-in supplies its token. */
    val relaySource: MachineSource?,
    /** Development builds only. */
    val developerSource: DeveloperMachineSource?,
    val kv: KeyValueStore,
    val drafts: Drafts,
    val http: HttpPort,
    val sockets: WebSocketFactory,
    val clientName: String = CLIENT_NAME,
    val clock: Clock = SystemClock,
    val mintMessageId: () -> String = { com.clave.core.state.mintMessageId() },
    val delivery: DeliveryController? = null,
    /** Where the store's background work runs (push events, snapshots, the reconnection
     *  pass). It must dispatch (Default, Main), never Unconfined: a snapshot is started under a
     *  conversation's lock and must not run inline there. */
    val scope: CoroutineScope,
    val log: Log = NoLog,
    /** The wait between two status asks of a send; a test advances its clock instead. */
    val sleep: suspend (Long) -> Unit = { delay(it) },
    val push: PushOptions = PushOptions(),
)

/** The id the phone mints for a message: `m-` and 24 hex digits, within the server's 8 to 64. */
public fun mintMessageId(random: () -> Double = Math::random): String {
    val hex = StringBuilder()
    while (hex.length < 24) hex.append(Math.floor(random() * 16).toInt().coerceIn(0, 15).toString(16))
    return "m-${hex.substring(0, 24)}"
}
