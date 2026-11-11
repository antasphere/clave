package com.clave.core.devices

import com.clave.core.contract.MachinePlatform
import com.clave.core.ports.SecureStore
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The machines a phone may reach, behind one interface, whatever lists them: the relay of
 * the team (the real road), or, in a development build only, a server the developer pasted
 * an address and a token for.
 */
public data class Machine(
    val id: String,
    val name: String,
    val platform: MachinePlatform,
    val version: String,
    val online: Boolean,
    /** Epoch milliseconds of the last time the relay heard the machine; null when never. */
    val lastSeen: Long?,
    /** Where the machine's API is reached from the phone. */
    val baseUrl: String,
    /** Where its push channel is reached. */
    val pushUrl: String,
)

public interface MachineSource {
    public suspend fun list(): List<Machine>
}

/**
 * What a machine is reached with: its API's base URL and the bearer the phone holds for it
 * (a device session; a server token on a developer machine). Its `toString` leaves the
 * bearer out, so a credential printed by accident in a log or an assertion says nothing.
 */
public data class Credential(val serverUrl: String, val bearer: String) {
    override fun toString(): String = "Credential(serverUrl=$serverUrl, bearer=<redacted>)"
}

public interface CredentialStore {
    public suspend fun get(machineId: String): Credential?
    public suspend fun set(machineId: String, credential: Credential)
    public suspend fun remove(machineId: String)

    /** The machine whose saved profiles the launch form lists (decision 7): the first
     *  paired, or the one marked main on the phone. */
    public suspend fun mainMachineId(): String?
    public suspend fun setMainMachineId(machineId: String?)
}

/** The secure-store key of a machine's credential, the TypeScript app's exactly: the id is
 *  URL-encoded and every `%` becomes `_`, so the key stays within `[A-Za-z0-9._-]`. */
public fun credentialKey(machineId: String): String =
    "clave.credential.${encodeUriComponent(machineId).replace('%', '_')}"

public const val MAIN_MACHINE_KEY: String = "clave.main-machine"

/** The credential store over the phone's secure store: one entry per machine id, the
 *  credential as JSON, plus which machine is the main one. Nothing here is ever logged. */
public class SecureCredentialStore(private val secure: SecureStore) : CredentialStore {
    override suspend fun get(machineId: String): Credential? {
        val raw = secure.get(credentialKey(machineId))
        if (raw.isNullOrEmpty()) return null
        // An unreadable entry is no credential.
        val parsed = parseJsonOrNull(raw).objectOrNull() ?: return null
        val serverUrl = parsed["serverUrl"].stringOrNull() ?: return null
        val bearer = parsed["bearer"].stringOrNull() ?: return null
        return Credential(serverUrl, bearer)
    }

    override suspend fun set(machineId: String, credential: Credential) {
        val json = buildJsonObject {
            put("serverUrl", credential.serverUrl)
            put("bearer", credential.bearer)
        }
        secure.set(credentialKey(machineId), json.toString())
        if (mainMachineId() == null) setMainMachineId(machineId)
    }

    override suspend fun remove(machineId: String) {
        secure.remove(credentialKey(machineId))
        if (mainMachineId() == machineId) setMainMachineId(null)
    }

    override suspend fun mainMachineId(): String? = secure.get(MAIN_MACHINE_KEY)?.takeIf { it.isNotEmpty() }

    override suspend fun setMainMachineId(machineId: String?) {
        if (machineId == null) secure.remove(MAIN_MACHINE_KEY) else secure.set(MAIN_MACHINE_KEY, machineId)
    }
}
