package com.clave.core.devices

import com.clave.core.ports.KeyValueStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What the phone keeps of a pairing beside the credential: the device id the server gave
 * it, the server's id and name, and when. The credential itself lives in the credential
 * store under the machine id; this record is what lets a notification, which names a
 * server, find the machine the phone reaches it through.
 */
public data class EnrollmentRecord(
    val machineId: String,
    val deviceId: String,
    val serverId: String,
    val serverName: String,
    val pairedAt: Long,
)

public const val ENROLLMENTS_KEY: String = "clave.enrollments"

/** One JSON list in the key-value store. Writes are serialized, so two approvals landing
 *  at once both survive instead of the second overwriting the first's read. */
public class EnrollmentRecords(private val store: KeyValueStore) {
    private val writing = Mutex()

    public suspend fun list(): List<EnrollmentRecord> {
        val raw = store.get(ENROLLMENTS_KEY) ?: return emptyList()
        val parsed = parseJsonOrNull(raw) as? JsonArray ?: return emptyList()
        return parsed.mapNotNull { element ->
            val r = element.objectOrNull() ?: return@mapNotNull null
            EnrollmentRecord(
                machineId = r["machineId"].stringOrNull() ?: return@mapNotNull null,
                deviceId = r["deviceId"].stringOrNull() ?: return@mapNotNull null,
                serverId = r["serverId"].stringOrNull() ?: return@mapNotNull null,
                serverName = r["serverName"].stringOrNull() ?: "",
                pairedAt = r["pairedAt"].numberOrNull()?.toLong() ?: 0,
            )
        }
    }

    public suspend fun get(machineId: String): EnrollmentRecord? = list().firstOrNull { it.machineId == machineId }

    /** The machine a server is reached through: what a notification's `serverId` resolves
     *  to. The most recent pairing wins when two machines name one server (a relay road and
     *  a direct address). */
    public suspend fun byServerId(serverId: String): EnrollmentRecord? =
        list().filter { it.serverId == serverId }.sortedByDescending { it.pairedAt }.firstOrNull()

    /** Keeps the record, replacing the one of the same machine. */
    public suspend fun set(record: EnrollmentRecord): Unit = writing.withLock {
        save(list().filter { it.machineId != record.machineId } + record)
    }

    public suspend fun remove(machineId: String): Unit = writing.withLock {
        val others = list().filter { it.machineId != machineId }
        if (others.isEmpty()) store.remove(ENROLLMENTS_KEY) else save(others)
    }

    private suspend fun save(records: List<EnrollmentRecord>) {
        val json = buildJsonArray {
            for (r in records) add(
                buildJsonObject {
                    put("machineId", r.machineId)
                    put("deviceId", r.deviceId)
                    put("serverId", r.serverId)
                    put("serverName", r.serverName)
                    put("pairedAt", r.pairedAt)
                },
            )
        }
        store.set(ENROLLMENTS_KEY, json.toString())
    }
}
