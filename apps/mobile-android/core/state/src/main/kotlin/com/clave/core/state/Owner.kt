package com.clave.core.state

import com.clave.core.auth.AuthError
import com.clave.core.auth.AuthFailure
import com.clave.core.auth.AuthStatus
import com.clave.core.auth.HubSignIn
import com.clave.core.auth.ownerNamespace
import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMarks
import com.clave.core.chat.Drafts
import com.clave.core.chat.UnknownSends
import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.DevicePlatform
import com.clave.core.contract.MachinePlatform
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentClient
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.Machine
import com.clave.core.devices.MachineSource
import com.clave.core.devices.MachinesError
import com.clave.core.devices.PairingInput
import com.clave.core.devices.PairingPorts
import com.clave.core.devices.PairingState
import com.clave.core.devices.RelayMachineSource
import com.clave.core.devices.SecureCredentialStore
import com.clave.core.devices.assertCredentialMayTravelTo
import com.clave.core.notifications.CleanupCredentialStore
import com.clave.core.notifications.CleanupOwner
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.OwnerPushWork
import com.clave.core.notifications.PushCleanupResult
import com.clave.core.notifications.PushTokenClient
import com.clave.core.notifications.PushTokenSource
import com.clave.core.notifications.TokenRegistration
import com.clave.core.notifications.TokenTarget
import com.clave.core.notifications.asPushTokenClient
import com.clave.core.notifications.clearPushRegistrations
import com.clave.core.notifications.pendingPushCleanup
import com.clave.core.notifications.pushTokenKey
import com.clave.core.notifications.registerDeviceToken
import com.clave.core.ports.Clock
import com.clave.core.ports.CryptoPort
import com.clave.core.ports.HttpPort
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.NamespacedKeyValueStore
import com.clave.core.ports.NamespacedSecureStore
import com.clave.core.ports.SecureStore
import com.clave.core.ports.SystemClock
import com.clave.core.transport.ServerError
import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import com.clave.core.devices.pair as pairMachine

/**
 * One account's stores (account.ts `nativeOwnerStores`): every key under the owner's
 * namespace, so an old asynchronous operation keeps its own owner's store after a sign-out
 * and can never write into the next account's records. The cleanup credentials sit in a
 * namespace of their own beside the active pairings.
 */
public class OwnerStores(
    public val namespace: String,
    public val kv: NamespacedKeyValueStore,
    public val secure: NamespacedSecureStore,
    public val credentials: SecureCredentialStore,
    public val cleanupCredentials: SecureCredentialStore,
    public val pushWork: OwnerPushWork,
)

/** The push work of each owner, process-wide: two services built for one owner (a screen
 *  rebuilt, a boot after a sign-in) still queue on one lock and share one road generation. */
private val ownerPushWork = ConcurrentHashMap<String, OwnerPushWork>()

public suspend fun ownerStores(
    issuer: String,
    subject: String?,
    rawKv: KeyValueStore,
    rawSecure: SecureStore,
    crypto: CryptoPort,
): OwnerStores {
    val namespace = ownerNamespace(issuer, subject, crypto)
    val secure = NamespacedSecureStore(rawSecure, namespace)
    return OwnerStores(
        namespace = namespace,
        kv = NamespacedKeyValueStore(rawKv, namespace),
        secure = secure,
        credentials = SecureCredentialStore(secure),
        cleanupCredentials = SecureCredentialStore(NamespacedSecureStore(rawSecure, "$namespace.push-cleanup")),
        pushWork = ownerPushWork.computeIfAbsent(namespace) { OwnerPushWork() },
    )
}

/** The stores of the account [status] names. */
public suspend fun ownerStores(status: AuthStatus, rawKv: KeyValueStore, rawSecure: SecureStore, crypto: CryptoPort): OwnerStores =
    ownerStores(status.issuer, status.account?.subject, rawKv, rawSecure, crypto)

/** Whether the platform lets Clave post notifications; [request] asks the person first. */
public fun interface PushPermission {
    public suspend fun granted(request: Boolean): Boolean
}

public const val RELAY_URL_KEY: String = "relay-url"
public const val MACHINES_CACHE_KEY: String = "machines-cache"

/**
 * The owner-scoped services of the signed-in account (beta.ts `BetaServices`): the relay
 * address, the machines through the relay with the cache as the fallback when the relay is
 * out of reach, the pairing, the push registrations and the sign-out. Every operation that
 * touches the pairings or the push tokens runs one at a time on the owner's push lock, and
 * each re-checks [assertOwner] after every wait: once another account signs in, old work
 * stops rather than write anywhere. The pickers of attachments are the app's, not here.
 */
public class OwnerServices(
    public val auth: HubSignIn,
    public val stores: OwnerStores,
    private val http: HttpPort,
    public val build: BuildKind,
    /** How the phone names itself when it asks a machine to pair. */
    private val device: DeviceDescription,
    /** The relay the build ships with, when the person has typed none. */
    private val defaultRelayUrl: String = "",
    private val pushTokens: PushTokenSource = PushTokenSource { null },
    private val permission: PushPermission = PushPermission { false },
    private val clock: Clock = SystemClock,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val assertOwner: () -> Unit = auth.guardAccount(),
) {
    public val kv: KeyValueStore = stores.kv
    public val credentials: SecureCredentialStore = stores.credentials
    public val pushWork: OwnerPushWork = stores.pushWork
    public val drafts: Drafts = Drafts(kv)
    public val records: EnrollmentRecords = EnrollmentRecords(kv)
    public val delivery: DeliveryController = DeliveryController(UnknownSends(kv), DeliveryMarks(kv), drafts, kv, clock, sleep)
    public val source: MachineSource = object : MachineSource {
        override suspend fun list(): List<Machine> = machines()
    }

    @Volatile private var closing = false
    private val signLock = Any()
    private var signingOut: CompletableDeferred<PushCleanupResult>? = null

    private val cleanupOwner = CleanupOwner(
        kv = kv,
        credentials = { machineId -> credentials.get(machineId) },
        cleanupCredentials = object : CleanupCredentialStore {
            override suspend fun get(ref: String): Credential? = stores.cleanupCredentials.get(ref)
            override suspend fun set(ref: String, credential: Credential) = stores.cleanupCredentials.set(ref, credential)
            override suspend fun remove(ref: String) = stores.cleanupCredentials.remove(ref)
        },
        build = build,
        clientFor = { credential -> EnrollmentClient(credential.serverUrl, http, build).asPushTokenClient() },
    )

    private fun ownerCurrent(): Boolean = try {
        assertOwner()
        true
    } catch (_: Exception) {
        false
    }

    private fun signingOutError() = AuthError(AuthFailure.Cancelled, "The account is signing out.")

    public suspend fun relayUrl(): String = kv.get(RELAY_URL_KEY) ?: defaultRelayUrl

    /**
     * Sets the team relay: an origin only, one this build sends a credential to. A different
     * relay is a different road, so the road generation moves (an approval captured before
     * cannot land), the push registrations of every pairing are cleared, and the pairings
     * and the machine cache are forgotten.
     */
    public suspend fun setRelayUrl(value: String): PushCleanupResult {
        val url = value.trim().trimEnd('/')
        val parsed = try {
            URI(url)
        } catch (e: URISyntaxException) {
            throw IllegalArgumentException("\"$url\" is not an address.", e)
        }
        assertCredentialMayTravelTo(url, build)
        val path = parsed.rawPath.orEmpty()
        if ((path != "" && path != "/") || parsed.rawQuery != null || parsed.rawFragment != null) {
            throw IllegalArgumentException("Enter the team relay origin without a path or query.")
        }
        return pushWork.lock.withLock {
            if (closing) throw signingOutError()
            assertOwner()
            val old = relayUrl()
            assertOwner()
            var cleanup = PushCleanupResult(pending = pendingPushCleanup(kv).size, retryRecorded = true)
            if (url != old) {
                pushWork.roadGeneration++
                val records = this.records.list()
                cleanup = clearPushRegistrations(records.map { it.machineId }, cleanupOwner)
                assertOwner()
                for (record in records) {
                    credentials.remove(record.machineId)
                    this.records.remove(record.machineId)
                }
                kv.remove(MACHINES_CACHE_KEY)
            }
            assertOwner()
            kv.set(RELAY_URL_KEY, url)
            cleanup
        }
    }

    /** The relay's list; on a transient failure (the network, a deadline, a 5xx) the last
     *  list seen, every machine offline. A refusal is never papered over by the cache. */
    private suspend fun machines(): List<Machine> {
        if (auth.status().account == null) return emptyList()
        assertOwner()
        val relayUrl = relayUrl()
        assertOwner()
        if (relayUrl.isEmpty()) throw IllegalStateException("Enter the team relay address to see your machines.")
        try {
            val machines = RelayMachineSource(
                relayUrl,
                {
                    assertOwner()
                    auth.accessToken()
                },
                http,
                build,
            ).list()
            assertOwner()
            kv.set(MACHINES_CACHE_KEY, encodeMachines(machines))
            return machines
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            assertOwner()
            val transient = when (e) {
                is MachinesError -> e.kind == MachinesError.Kind.Network || e.kind == MachinesError.Kind.Timeout || (e.status ?: 0) >= 500
                is ServerError -> e.kind == ServerError.Kind.Network || e.kind == ServerError.Kind.Timeout || (e.status ?: 0) >= 500
                is AuthError -> e.failure == AuthFailure.Network || e.failure == AuthFailure.Timeout
                else -> false
            }
            if (!transient) throw e
            val raw = kv.get(MACHINES_CACHE_KEY) ?: throw e
            val cached = decodeMachines(raw) ?: throw e
            return cached.map { it.copy(online = false) }
        }
    }

    /**
     * Pairs this phone with [machine] for the current owner. The approval lands only if the
     * owner, the road and the person's wish are all still what they were when it began.
     */
    public suspend fun pair(machine: Machine, onState: (PairingState) -> Unit, cancelled: () -> Boolean): PairingState {
        assertOwner()
        val generation = pushWork.roadGeneration
        val isCancelled: () -> Boolean = {
            closing || generation != pushWork.roadGeneration || !ownerCurrent() || cancelled()
        }
        val idToken = auth.idToken()
        assertOwner()
        val clientId = auth.ensureClient()
        assertOwner()
        return pairMachine(
            PairingInput(machine.id, machine.baseUrl, idToken, clientId, device),
            PairingPorts(
                client = EnrollmentClient(machine.baseUrl, http, build),
                credentials = credentials,
                records = records,
                persist = { record, credential -> persistPairing(record, credential, isCancelled) },
                sleep = sleep,
                clock = clock,
                onState = onState,
                cancelled = isCancelled,
            ),
        )
    }

    /** The approval, committed whole or not at all: a cancellation seen midway restores the
     *  previous credential and record. */
    private suspend fun persistPairing(record: EnrollmentRecord, credential: Credential, cancelled: () -> Boolean): Boolean =
        pushWork.lock.withLock {
            if (cancelled()) return@withLock false
            val previousCredential = credentials.get(record.machineId)
            val previousRecord = records.get(record.machineId)
            if (cancelled()) return@withLock false
            suspend fun restore() {
                if (previousCredential != null) credentials.set(record.machineId, previousCredential) else credentials.remove(record.machineId)
                if (previousRecord != null) records.set(previousRecord) else records.remove(record.machineId)
            }
            try {
                credentials.set(record.machineId, credential)
                if (cancelled()) {
                    restore()
                    return@withLock false
                }
                records.set(record)
                kv.remove(pushTokenKey(record.machineId))
                if (cancelled()) {
                    restore()
                    return@withLock false
                }
                true
            } catch (e: Exception) {
                restore()
                throw e
            }
        }

    public suspend fun registerPush(machineId: String, token: DeviceToken? = null, requestPermission: Boolean = true): TokenRegistration =
        pushWork.lock.withLock { registerPushNow(machineId, token, requestPermission) }

    private suspend fun registerPushNow(machineId: String, token: DeviceToken?, requestPermission: Boolean): TokenRegistration {
        if (closing) return TokenRegistration.Failed("The account is signing out.")
        assertOwner()
        val credential = credentials.get(machineId) ?: return TokenRegistration.Failed("Pair this phone first.")
        if (!permission.granted(requestPermission)) return TokenRegistration.Unsupported("Notifications are off for Clave.")
        val enrollment = EnrollmentClient(credential.serverUrl, http, build)
        return registerDeviceToken(
            target = TokenTarget(machineId, credential.bearer, DevicePlatform.Android),
            source = if (token != null) PushTokenSource { token } else pushTokens,
            client = object : PushTokenClient {
                override suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform) {
                    if (closing) throw signingOutError()
                    assertOwner()
                    enrollment.setPushToken(bearer, token, platform)
                }

                override suspend fun clearPushToken(bearer: String) = enrollment.clearPushToken(bearer)
            },
            kv = kv,
        )
    }

    /** Boot and the platform's token rotation keep every paired server's token current,
     *  after retrying the clears still owed. */
    public suspend fun syncPushTokens(token: DeviceToken? = null): List<TokenRegistration> = pushWork.lock.withLock {
        if (closing) return@withLock emptyList()
        assertOwner()
        val pending = pendingPushCleanup(kv)
        val records = this.records.list()
        val outcomes = mutableListOf<TokenRegistration>()
        if (pending.isNotEmpty()) {
            val cleaned = clearPushRegistrations(emptyList(), cleanupOwner)
            assertOwner()
            // A successful retry may have removed this owner's current token too.
            for (record in records) kv.remove(pushTokenKey(record.machineId))
            if (cleaned.pending != 0) outcomes += TokenRegistration.Failed("Some machines have not confirmed notification removal.")
        }
        for (record in records) outcomes += registerPushNow(record.machineId, token, false)
        outcomes
    }

    /**
     * Stops new registrations, drains the work queued before, then clears this owner's push
     * targets; the hub login is forgotten only when it is still this owner's. A replacement
     * login is never signed out nor used for the cleanup. A second call joins the first.
     */
    public suspend fun signOut(): PushCleanupResult {
        val (deferred, mine) = synchronized(signLock) {
            val running = signingOut
            if (running != null) {
                running to false
            } else {
                assertOwner()
                closing = true
                CompletableDeferred<PushCleanupResult>().also { signingOut = it } to true
            }
        }
        if (!mine) return deferred.await()
        try {
            val result = pushWork.lock.withLock {
                val cleanup = try {
                    clearPushRegistrations(records.list().map { it.machineId }, cleanupOwner)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    PushCleanupResult(pending = null, retryRecorded = false)
                }
                if (ownerCurrent()) auth.signOut()
                cleanup
            }
            deferred.complete(result)
            return result
        } catch (e: Throwable) {
            deferred.completeExceptionally(e)
            throw e
        }
    }
}

private fun encodeMachines(machines: List<Machine>): String = buildJsonArray {
    for (m in machines) add(
        buildJsonObject {
            put("id", m.id)
            put("name", m.name)
            put("platform", m.platform.wire)
            put("version", m.version)
            put("online", m.online)
            put("lastSeen", m.lastSeen)
            put("baseUrl", m.baseUrl)
            put("pushUrl", m.pushUrl)
        },
    )
}.toString()

/** The cache as it was written; null when it is not a list, so the original error stands. */
private fun decodeMachines(raw: String): List<Machine>? {
    val element = try {
        Json.parseToJsonElement(raw)
    } catch (_: Exception) {
        return null
    }
    val parsed = element as? JsonArray ?: return null
    return parsed.mapNotNull { element ->
        val o = element as? JsonObject ?: return@mapNotNull null
        fun text(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        Machine(
            id = text("id") ?: return@mapNotNull null,
            name = text("name") ?: "",
            platform = MachinePlatform.of(text("platform")),
            version = text("version") ?: "",
            online = (o["online"] as? JsonPrimitive)?.booleanOrNull ?: false,
            lastSeen = (o["lastSeen"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.longOrNull,
            baseUrl = text("baseUrl") ?: return@mapNotNull null,
            pushUrl = text("pushUrl") ?: return@mapNotNull null,
        )
    }
}
