package com.clave.core.notifications

import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.TransportVerdict
import com.clave.core.devices.credentialMayTravelTo
import com.clave.core.ports.KeyValueStore
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlin.random.Random
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Clearing the push registrations of machines the phone is forgetting (a sign-out, a road
 * reset). The clear must reach the machine with the credential the phone held for it, yet
 * the pairing is about to go, and the machine may be offline. So the credential is captured
 * first, into a separate encrypted owner store under an opaque reference, and only the
 * references enter the plain key-value store: a clear that could not reach its machine is
 * retried on a later call, with the old credential, never with a newer pairing's.
 */
public const val PUSH_CLEANUP_KEY: String = "clave.pending-push-cleanup"

/** How long one machine's clear may take before it is left pending. */
public const val PUSH_CLEAR_TIMEOUT_MS: Long = 3_000

/** The push work of one owner: services for that owner run one at a time on [lock], and
 *  [roadGeneration] invalidates approvals captured before a same-owner road reset. It never
 *  retains a credential or a token. */
public class OwnerPushWork {
    public val lock: Mutex = Mutex()

    @Volatile
    public var roadGeneration: Int = 0
}

public data class PushCleanupResult(
    /** Null when local storage prevented enumerating or recording the cleanup. */
    val pending: Int?,
    val retryRecorded: Boolean,
)

/** The separate encrypted owner store of captured credentials, by opaque reference; never
 *  an active machine pairing. */
public interface CleanupCredentialStore {
    public suspend fun get(ref: String): Credential?
    public suspend fun set(ref: String, credential: Credential)
    public suspend fun remove(ref: String)
}

public class CleanupOwner(
    public val kv: KeyValueStore,
    /** The active pairings' credentials, by machine id. */
    public val credentials: suspend (machineId: String) -> Credential?,
    public val cleanupCredentials: CleanupCredentialStore,
    public val build: BuildKind,
    /** A client for one captured credential; each clear is bounded by [PUSH_CLEAR_TIMEOUT_MS]. */
    public val clientFor: (Credential) -> PushTokenClient,
)

private class PendingCleanup(val refs: List<String>, val legacyMachineIds: List<String>)

private val REF_PATTERN = Regex("^push-cleanup-[a-z0-9-]+$")

private suspend fun readPending(kv: KeyValueStore): PendingCleanup {
    val raw = kv.get(PUSH_CLEANUP_KEY) ?: return PendingCleanup(emptyList(), emptyList())
    if (raw.isEmpty()) return PendingCleanup(emptyList(), emptyList())
    val parsed = parseJsonOrNull(raw) ?: throw IllegalStateException("Notification cleanup could not be read.")
    // The earlier pending-machine list is migrated before an active pairing disappears.
    if (parsed is JsonArray) {
        val ids = parsed.map { it.stringOrNull()?.takeIf { id -> id.isNotEmpty() } }
        if (ids.all { it != null }) return PendingCleanup(emptyList(), ids.filterNotNull())
    }
    if (parsed is JsonObject && (parsed["v"] as? JsonPrimitive)?.let { !it.isString && it.content == "2" } == true) {
        val refs = parsed["refs"] as? JsonArray
        if (refs != null) {
            val values = refs.map { it.stringOrNull()?.takeIf { ref -> REF_PATTERN.matches(ref) } }
            if (values.all { it != null }) return PendingCleanup(values.filterNotNull().distinct(), emptyList())
        }
    }
    throw IllegalStateException("Notification cleanup could not be read.")
}

/** The clears still owed: opaque references, and machine ids of the earlier format. */
public suspend fun pendingPushCleanup(kv: KeyValueStore): List<String> {
    val pending = readPending(kv)
    return pending.refs + pending.legacyMachineIds
}

private suspend fun savePending(kv: KeyValueStore, refs: List<String>) {
    val json = buildJsonObject {
        put("v", 2)
        put("refs", buildJsonArray { refs.forEach { add(JsonPrimitive(it)) } })
    }
    kv.set(PUSH_CLEANUP_KEY, json.toString())
}

private val sequence = AtomicLong()

private suspend fun retainCredential(owner: CleanupOwner, credential: Credential): String {
    var id: String
    do {
        id = "push-cleanup-" + java.lang.Long.toString(System.currentTimeMillis(), 36) + "-" +
            java.lang.Long.toString(sequence.incrementAndGet(), 36) + "-" +
            java.lang.Long.toString(Random.nextLong(Long.MAX_VALUE), 36)
    } while (owner.cleanupCredentials.get(id) != null)
    owner.cleanupCredentials.set(id, credential)
    return id
}

/** Persists the old roads' credentials BEFORE any active pairing is forgotten; only opaque
 *  references enter the key-value store. */
private suspend fun capture(machineIds: List<String>, owner: CleanupOwner): List<String> {
    val saved = readPending(owner.kv)
    val pending = saved.refs.toMutableList()
    val active = LinkedHashSet(saved.legacyMachineIds + machineIds)
    for (machineId in active) {
        val credential = owner.credentials(machineId)
            ?: throw IllegalStateException("Notification cleanup credentials are unavailable.")
        var retained = false
        for (ref in pending) {
            val previous = owner.cleanupCredentials.get(ref)
            if (previous?.serverUrl == credential.serverUrl && previous.bearer == credential.bearer) retained = true
        }
        if (!retained) pending += retainCredential(owner, credential)
    }
    savePending(owner.kv, pending)
    // A later pairing or a same-owner sign-in must register again, even after an offline cleanup.
    for (machineId in active) owner.kv.remove(pushTokenKey(machineId))
    return pending
}

/**
 * Clears the push token on every machine of [machineIds] and on every one still pending.
 * Receives the owner's own stores, never the current hub account, so a new road or a
 * replacement pairing cannot change the credential of a pending clear.
 */
public suspend fun clearPushRegistrations(machineIds: List<String>, owner: CleanupOwner): PushCleanupResult {
    val captured = capture(machineIds, owner)
    val results: List<Pair<String, Boolean>> = coroutineScope {
        captured.map { ref ->
            async { ref to clearOne(ref, owner) }
        }.awaitAll()
    }
    val pending = results.filter { !it.second }.map { it.first }
    if (pending.isNotEmpty()) savePending(owner.kv, pending) else owner.kv.remove(PUSH_CLEANUP_KEY)
    // The pending list is committed before the acknowledged encrypted context is discarded.
    for ((ref, cleared) in results) if (cleared) owner.cleanupCredentials.remove(ref)
    return PushCleanupResult(pending = pending.size, retryRecorded = true)
}

private suspend fun clearOne(ref: String, owner: CleanupOwner): Boolean {
    return try {
        val credential = owner.cleanupCredentials.get(ref) ?: return false
        // The transport policy holds here as everywhere: no clear over plain http in a release.
        if (credentialMayTravelTo(credential.serverUrl, owner.build) is TransportVerdict.Refused) return false
        withTimeoutOrNull(PUSH_CLEAR_TIMEOUT_MS) {
            clearDeviceToken(ref, credential.bearer, owner.clientFor(credential), owner.kv)
            true
        } ?: false
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }
}
