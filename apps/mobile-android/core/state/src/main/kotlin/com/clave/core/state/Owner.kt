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
import com.clave.core.devices.AddressListing
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentClient
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.Machine
import com.clave.core.devices.MachineAddress
import com.clave.core.devices.MachineDirectory
import com.clave.core.devices.MachineListing
import com.clave.core.devices.MachinesError
import com.clave.core.devices.PairingInput
import com.clave.core.devices.PairingPorts
import com.clave.core.devices.PairingState
import com.clave.core.devices.RelayMachineSource
import com.clave.core.devices.SecureCredentialStore
import com.clave.core.devices.decodeMachineAddresses
import com.clave.core.devices.encodeMachineAddresses
import com.clave.core.devices.normalizeMachineAddress
import com.clave.core.notifications.CleanupCredentialStore
import com.clave.core.notifications.CleanupOwner
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.HandleResult
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.OwnerPushWork
import com.clave.core.notifications.PushCleanupResult
import com.clave.core.notifications.PushTokenClient
import com.clave.core.notifications.PushTokenSource
import com.clave.core.notifications.SettleClient
import com.clave.core.notifications.TokenRegistration
import com.clave.core.notifications.TokenTarget
import com.clave.core.notifications.asMachineResolver
import com.clave.core.notifications.asPushTokenClient
import com.clave.core.notifications.clearPushRegistrations
import com.clave.core.notifications.handleResponse
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
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
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

/** The list of addresses the phone asks for machines. */
public const val MACHINE_ADDRESSES_KEY: String = "machine-addresses"

/** The single relay of earlier versions, read once to move it into [MACHINE_ADDRESSES_KEY]. */
public const val RELAY_URL_KEY: String = "relay-url"

/** That relay's machine cache, moved under [machinesCacheKey] by the same move. */
public const val MACHINES_CACHE_KEY: String = "machines-cache"

/** The last list the address [url] gave, the fallback while it is out of reach. */
public fun machinesCacheKey(url: String): String = "machines-cache.$url"

/**
 * The owner-scoped services of the signed-in account (beta.ts `BetaServices`): the machine
 * addresses, the machines they list with each address's cache as the fallback when it is
 * out of reach, the pairing and its forgetting, the push registrations and the sign-out. Every operation that
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
    /** The relay the build ships with: the first address when the person has typed none. */
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
    public val source: MachineDirectory = object : MachineDirectory {
        override suspend fun listing(progress: suspend (MachineListing) -> Unit): MachineListing = machines(progress)
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

    /**
     * The addresses the phone asks for machines, in the person's order. The first read after
     * the single relay of earlier versions moves it here once: the relay typed (or the one
     * the build ships with) becomes the one address, its machine cache follows it, and no
     * pairing, push token or road is touched.
     */
    public suspend fun addresses(): List<MachineAddress> {
        assertOwner()
        val raw = kv.get(MACHINE_ADDRESSES_KEY)
        assertOwner()
        if (raw != null) return decodeMachineAddresses(raw)
        return pushWork.lock.withLock { addressesLocked() }
    }

    /** The list, under the push lock; the one move from the single relay when there is none
     *  yet. A second first read finds the list the first one wrote. */
    private suspend fun addressesLocked(): List<MachineAddress> {
        assertOwner()
        kv.get(MACHINE_ADDRESSES_KEY)?.let {
            assertOwner()
            return decodeMachineAddresses(it)
        }
        val url = (kv.get(RELAY_URL_KEY)?.takeIf { it.isNotEmpty() } ?: defaultRelayUrl.takeIf { it.isNotEmpty() })
            ?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        val addresses = if (url == null) emptyList() else listOf(MachineAddress(url))
        assertOwner()
        // A sign-out under way writes nothing more; the move happens on the next read.
        if (closing) return addresses
        if (url != null) {
            val cache = kv.get(MACHINES_CACHE_KEY)
            assertOwner()
            if (cache != null) kv.set(machinesCacheKey(url), cache)
        }
        assertOwner()
        kv.set(MACHINE_ADDRESSES_KEY, encodeMachineAddresses(addresses))
        kv.remove(MACHINES_CACHE_KEY)
        kv.remove(RELAY_URL_KEY)
        return addresses
    }

    /** One write of the list, under the push lock, refused once the account signs out or
     *  changed. [change] gets the current list and returns the next, or null to write nothing. */
    private suspend fun <T> changeAddresses(change: suspend (List<MachineAddress>) -> Pair<List<MachineAddress>?, T>): T =
        pushWork.lock.withLock {
            if (closing) throw signingOutError()
            assertOwner()
            val current = addressesLocked()
            assertOwner()
            val (next, result) = change(current)
            if (next != null) {
                assertOwner()
                kv.set(MACHINE_ADDRESSES_KEY, encodeMachineAddresses(next))
            }
            result
        }

    /**
     * Adds an address at the end of the list: an origin only, one this build sends a
     * credential to, and not one already there. A blank [name] is none. No pairing changes:
     * a machine is paired one by one, from its row.
     */
    public suspend fun addAddress(input: String, name: String? = null): MachineAddress {
        val url = normalizeMachineAddress(input, build)
        val address = MachineAddress(url, name?.trim()?.takeIf { it.isNotEmpty() })
        return changeAddresses { current ->
            if (current.any { it.url.equals(url, ignoreCase = true) }) {
                throw IllegalArgumentException("That address is already in the list.")
            }
            (current + address) to address
        }
    }

    /** Names the address [url], or takes its name away when [name] is blank; an address not
     *  in the list is left alone. */
    public suspend fun renameAddress(url: String, name: String?) {
        val named = name?.trim()?.takeIf { it.isNotEmpty() }
        changeAddresses { current ->
            if (current.none { it.url == url }) null to Unit
            else current.map { if (it.url == url) it.copy(name = named) else it } to Unit
        }
    }

    /**
     * Takes the address [url] out of the list, with its machine cache. The road generation
     * moves, so a pairing still waiting is cancelled. A machine paired through this address
     * keeps its credential, its record and its push registration: forgetting one is
     * [forgetMachine], a choice of its own.
     */
    public suspend fun removeAddress(url: String) {
        changeAddresses { current ->
            if (current.none { it.url == url }) {
                null to Unit
            } else {
                pushWork.roadGeneration++
                assertOwner()
                kv.remove(machinesCacheKey(url))
                current.filter { it.url != url } to Unit
            }
        }
    }

    /**
     * Forgets the pairing of [machineId]: its push registration is cleared on the machine
     * first (or kept pending when the machine is out of reach), then the credential, the
     * record and the push token go.
     */
    public suspend fun forgetMachine(machineId: String): PushCleanupResult = pushWork.lock.withLock {
        if (closing) throw signingOutError()
        assertOwner()
        val credential = credentials.get(machineId)
        assertOwner()
        val cleanup = if (credential != null) {
            clearPushRegistrations(listOf(machineId), cleanupOwner)
        } else {
            PushCleanupResult(pending = pendingPushCleanup(kv).size, retryRecorded = true)
        }
        assertOwner()
        credentials.remove(machineId)
        records.remove(machineId)
        kv.remove(pushTokenKey(machineId))
        cleanup
    }

    /**
     * Every address's list, read side by side. An address out of reach (the network, a
     * deadline, a 5xx) lends the last list it gave, every machine offline, and still says
     * why; a refusal is never papered over by the cache. A machine two addresses list is one
     * row, the first address's, but a paired machine is always reached at the road it was
     * paired through. A paired machine no address lists stays, offline, from its record.
     *
     * A slow address holds back no other: [progress] hears the merged listing each time one
     * more address answers, the ones still waiting marked pending. An address removed while
     * its read was under way gives nothing, neither rows nor a cache: the road generation
     * the read started on has moved.
     */
    private suspend fun machines(progress: suspend (MachineListing) -> Unit = {}): MachineListing {
        if (auth.status().account == null) return MachineListing(emptyList(), emptyList())
        assertOwner()
        val addresses = addresses()
        assertOwner()
        val generation = pushWork.roadGeneration
        val done = arrayOfNulls<Pair<List<Machine>, AddressListing>>(addresses.size)
        val publishing = Mutex()
        coroutineScope {
            addresses.mapIndexed { index, address ->
                async {
                    val read = readAddress(address, generation)
                    publishing.withLock {
                        done[index] = read
                        if (done.any { it == null }) progress(merge(addresses, done.toList(), generation))
                    }
                }
            }.awaitAll()
        }
        val listing = merge(addresses, done.toList(), generation)
        assertOwner()
        return listing
    }

    /** The listing of the reads done so far, in address order: those still waiting are
     *  pending rows, and an address taken out of the list since [generation] is left out. */
    private suspend fun merge(
        addresses: List<MachineAddress>,
        reads: List<Pair<List<Machine>, AddressListing>?>,
        generation: Int,
    ): MachineListing {
        assertOwner()
        val kept = if (generation == pushWork.roadGeneration) null else addresses().map { it.url }.toSet()
        val rows = LinkedHashMap<String, Machine>()
        val listed = mutableListOf<AddressListing>()
        for ((index, address) in addresses.withIndex()) {
            if (kept != null && address.url !in kept) continue
            val read = reads[index]
            if (read == null) {
                listed += AddressListing(address, emptyList(), null, fromCache = false, pending = true)
                continue
            }
            for (m in read.first) rows.putIfAbsent(m.id, m)
            listed += read.second
        }
        val result = mutableListOf<Machine>()
        for (m in rows.values) {
            val credential = credentials.get(m.id)
            result += if (credential == null) m else m.copy(baseUrl = credential.serverUrl, pushUrl = pushUrlOf(credential))
        }
        for (record in records.list()) {
            if (record.machineId in rows) continue
            val credential = credentials.get(record.machineId) ?: continue
            rows[record.machineId] = Machine(
                id = record.machineId,
                name = record.serverName.ifEmpty { record.machineId },
                platform = MachinePlatform.Unknown,
                version = "",
                online = false,
                lastSeen = null,
                baseUrl = credential.serverUrl,
                pushUrl = pushUrlOf(credential),
            ).also { result += it }
        }
        assertOwner()
        return MachineListing(result, listed)
    }

    /** One address's machines and its row. Nothing but a cancellation and the account
     *  changing escapes it: every other failure becomes the row's sentence. */
    private suspend fun readAddress(address: MachineAddress, generation: Int): Pair<List<Machine>, AddressListing> {
        val url = address.url
        try {
            val listed = RelayMachineSource(
                url,
                {
                    assertOwner()
                    auth.accessToken()
                },
                http,
                build,
            ).list()
            assertOwner()
            try {
                // Under the push lock, which a removal holds: once the address is removed,
                // an answer still on its way writes no cache back.
                pushWork.lock.withLock {
                    if (generation == pushWork.roadGeneration) kv.set(machinesCacheKey(url), encodeMachines(listed))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The list stands without its cache; the next read writes it again.
            }
            val machines = listed.map { it.copy(address = url) }
            return machines to AddressListing(address, machines.map { it.id }, null, fromCache = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            assertOwner()
            val sentence = e.message?.takeIf { it.isNotBlank() } ?: "This address could not be read."
            val cached = if (transient(e)) cachedMachines(url) else null
            if (cached != null) {
                val machines = cached.map { it.copy(online = false, address = url) }
                return machines to AddressListing(address, machines.map { it.id }, sentence, fromCache = true)
            }
            return emptyList<Machine>() to AddressListing(address, emptyList(), sentence, fromCache = false)
        }
    }

    private suspend fun cachedMachines(url: String): List<Machine>? = try {
        kv.get(machinesCacheKey(url))?.let(::decodeMachines)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
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

    /** The machine a push from [serverId] is posted with: the one this owner paired with that
     *  server, or none (the tap then lands on Machines), never another paired machine. */
    public suspend fun machineForServer(serverId: String): String? = records.byServerId(serverId)?.machineId

    /**
     * Answers a notification response for this owner. The machine is the one the payload's own
     * server id resolves to through this owner's pairing records, and the credential is that
     * machine's: never the main machine's nor another's. A server this owner never paired with
     * gets no client built at all.
     */
    public suspend fun respond(response: IncomingResponse, client: (Credential) -> SettleClient): HandleResult =
        handleResponse(response, records.asMachineResolver(), { machineId -> credentials.get(machineId) }, client)

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

/** Whether a failure to list is the road being out of reach (the network, a deadline, a
 *  5xx), when the cache may stand in; a refusal or an unreadable answer is not. */
private fun transient(e: Exception): Boolean = when (e) {
    is MachinesError -> e.kind == MachinesError.Kind.Network || e.kind == MachinesError.Kind.Timeout || (e.status ?: 0) >= 500
    is ServerError -> e.kind == ServerError.Kind.Network || e.kind == ServerError.Kind.Timeout || (e.status ?: 0) >= 500
    is AuthError -> e.failure == AuthFailure.Network || e.failure == AuthFailure.Timeout
    else -> false
}

/** A paired machine's push channel: on the road its credential was paired through. */
private fun pushUrlOf(credential: Credential): String = credential.serverUrl.trimEnd('/') + "/push"

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
