package com.clave.core.devices

import com.clave.core.contract.MachinePlatform
import com.clave.core.ports.Clock
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.SystemClock
import java.net.URI
import java.net.URISyntaxException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

public const val DEVELOPER_MACHINES_KEY: String = "clave.developer-machines"

public data class DeveloperMachineRecord(
    val id: String,
    val name: String,
    val serverUrl: String,
    val addedAt: Long,
)

/** A stable id per address, the host and port, safe for a secure-store key. */
public fun developerMachineId(serverUrl: String): String {
    val parsed = parseAddress(serverUrl) ?: throw IllegalArgumentException("\"$serverUrl\" is not an address.")
    return "dev:${parsed.host.replace(Regex("[^A-Za-z0-9.:-]"), "-")}"
}

/** `http://127.0.0.1:43201/` and `127.0.0.1:43201` both become `http://127.0.0.1:43201`. */
public fun normalizeServerUrl(input: String): String {
    val trimmed = input.trim()
    val withScheme = if (Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) trimmed else "http://$trimmed"
    val uri = try {
        URI(withScheme)
    } catch (e: URISyntaxException) {
        throw IllegalArgumentException("\"$trimmed\" is not an address.", e)
    }
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") throw IllegalArgumentException("The address must start with http:// or https://")
    val hostname = uri.host?.lowercase()?.takeIf { it.isNotEmpty() }
        ?: throw IllegalArgumentException("\"$trimmed\" is not an address.")
    val defaultPort = if (scheme == "http") 80 else 443
    val host = if (uri.port == -1 || uri.port == defaultPort) hostname else "$hostname:${uri.port}"
    val path = (uri.rawPath ?: "").trimEnd('/')
    return "$scheme://$host$path"
}

/**
 * The developer's machines: a server reached by the address and the token a developer
 * pasted, to work against a local standalone server. The app offers it in a development
 * build only. The list lives in the key-value store, the token in the credential store.
 */
public class DeveloperMachineSource(
    private val store: KeyValueStore,
    private val credentials: CredentialStore,
    private val http: HttpPort,
    private val clock: Clock = SystemClock,
    private val timeoutMs: Long = 10_000,
) : MachineSource {
    public suspend fun records(): List<DeveloperMachineRecord> {
        val raw = store.get(DEVELOPER_MACHINES_KEY) ?: return emptyList()
        val parsed = parseJsonOrNull(raw) as? JsonArray ?: return emptyList()
        return parsed.mapNotNull { element ->
            val r = element.objectOrNull() ?: return@mapNotNull null
            val id = r["id"].stringOrNull() ?: return@mapNotNull null
            val serverUrl = r["serverUrl"].stringOrNull() ?: return@mapNotNull null
            DeveloperMachineRecord(id, r["name"].stringOrNull() ?: "", serverUrl, r["addedAt"].numberOrNull()?.toLong() ?: 0)
        }
    }

    override suspend fun list(): List<Machine> = records().map { machineOf(it.id, it.name, it.serverUrl) }

    /**
     * Adds a server: the token is tried once against `GET /launch-profiles` (a 401 is the
     * server refusing it), then kept in the credential store under the machine's id, the
     * address in the list. Answers the machine. Only a development build's allowance
     * applies, plain http to the loopback and nothing wider.
     */
    public suspend fun add(serverUrl: String, token: String, name: String = "Developer machine"): Machine {
        val normalized = normalizeServerUrl(serverUrl)
        assertCredentialMayTravelTo(normalized, BuildKind.Development)
        tryToken(normalized, token)
        val id = developerMachineId(normalized)
        val records = records().filter { it.id != id } + DeveloperMachineRecord(id, name, normalized, clock.now())
        save(records)
        credentials.set(id, Credential(normalized, token))
        return machineOf(id, name, normalized)
    }

    public suspend fun remove(id: String) {
        save(records().filter { it.id != id })
        credentials.remove(id)
    }

    private suspend fun save(records: List<DeveloperMachineRecord>) {
        val json = buildJsonArray {
            for (r in records) add(
                buildJsonObject {
                    put("id", r.id)
                    put("name", r.name)
                    put("serverUrl", r.serverUrl)
                    put("addedAt", r.addedAt)
                },
            )
        }
        store.set(DEVELOPER_MACHINES_KEY, json.toString())
    }

    private suspend fun tryToken(serverUrl: String, token: String) {
        val response: HttpResponse = try {
            http.send(
                HttpRequest(
                    method = "GET",
                    url = "$serverUrl/launch-profiles",
                    headers = mapOf("Authorization" to "Bearer $token", "Accept" to "application/json"),
                    timeoutMs = timeoutMs,
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpFailure.Timeout) {
            throw MachinesError(MachinesError.Kind.Timeout, "The server did not answer in time.", cause = e)
        } catch (e: Exception) {
            throw MachinesError(MachinesError.Kind.Network, "The server could not be reached.", cause = e)
        }
        if (response.status == 401) {
            throw MachinesError(MachinesError.Kind.Unauthenticated, "The server refused the token.", 401)
        }
        if (response.status !in 200..299) {
            throw MachinesError(MachinesError.Kind.Protocol, "The server answered ${response.status}.", response.status)
        }
    }

    private fun machineOf(id: String, name: String, serverUrl: String): Machine =
        Machine(
            id = id,
            name = name,
            platform = MachinePlatform.Unknown,
            version = "",
            online = true,
            lastSeen = null,
            baseUrl = serverUrl,
            pushUrl = "${serverUrl.trimEnd('/')}/push",
        )
}
