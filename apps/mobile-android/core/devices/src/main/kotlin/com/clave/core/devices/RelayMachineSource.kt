package com.clave.core.devices

import com.clave.core.contract.MachinePlatform
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Why listing or adding a machine failed. The message is a sentence to show; it never
 *  carries a token. */
public class MachinesError(
    public val kind: Kind,
    message: String,
    public val status: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    public enum class Kind { Network, Timeout, Unauthenticated, Protocol }
}

public fun machineBaseUrl(relayUrl: String, machineId: String): String =
    "${relayUrl.trimEnd('/')}/m/${encodeUriComponent(machineId)}"

public fun machinePushUrl(relayUrl: String, machineId: String): String =
    "${machineBaseUrl(relayUrl, machineId)}/push"

/**
 * The machines of the person, from the relay: `GET <relay>/machines` with the hub's access
 * token as bearer answers `{machines: [{id, name, platform, version, online, lastSeen,
 * direct: [{url}]}]}`; a machine is reached at `<relay>/m/<id>/<path>` and its socket at
 * `<relay>/m/<id>/push`, the device session's bearer travelling through. The direct
 * addresses a row carries are ignored: the road is the relay (trying one first is owed to
 * the integration, and only over https).
 *
 * The hub token belongs to the sign-in module: this source takes a supplier, so it never
 * holds one longer than a request.
 */
public class RelayMachineSource(
    private val relayUrl: String,
    private val token: suspend () -> String,
    private val http: HttpPort,
    build: BuildKind = BuildKind.Release,
    private val timeoutMs: Long = 10_000,
) : MachineSource {
    init {
        assertCredentialMayTravelTo(relayUrl, build)
    }

    override suspend fun list(): List<Machine> {
        val bearer = token()
        val response: HttpResponse = try {
            http.send(
                HttpRequest(
                    method = "GET",
                    url = "${relayUrl.trimEnd('/')}/machines",
                    headers = mapOf("Authorization" to "Bearer $bearer", "Accept" to "application/json"),
                    timeoutMs = timeoutMs,
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpFailure.Timeout) {
            throw MachinesError(MachinesError.Kind.Timeout, "The relay did not answer in time.", cause = e)
        } catch (e: Exception) {
            throw MachinesError(MachinesError.Kind.Network, "The relay could not be reached.", cause = e)
        }
        val status = response.status
        if (status == 401) throw MachinesError(MachinesError.Kind.Unauthenticated, "The relay refused the sign-in.", status)
        if (status !in 200..299) throw MachinesError(MachinesError.Kind.Protocol, "The relay answered $status.", status)
        val body = parseJsonOrNull(response.body)
            ?: throw MachinesError(MachinesError.Kind.Protocol, "The relay answered something unreadable.", status)
        val machines = body.objectOrNull()?.get("machines") as? JsonArray
            ?: throw MachinesError(MachinesError.Kind.Protocol, "The relay answered no machine list.", status)
        return machines.mapIndexed { index, raw ->
            val m = raw.objectOrNull() ?: JsonObject(emptyMap())
            val id = m["id"].stringOrNull()?.takeIf { it.isNotEmpty() }
                ?: throw MachinesError(MachinesError.Kind.Protocol, "The relay's machine $index has no id.", status)
            Machine(
                id = id,
                name = m["name"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: id,
                platform = platformOf(m["platform"]),
                version = m["version"].stringOrNull() ?: "",
                online = m["online"].isTrue(),
                lastSeen = lastSeenOf(m["lastSeen"]),
                baseUrl = machineBaseUrl(relayUrl, id),
                pushUrl = machinePushUrl(relayUrl, id),
            )
        }
    }
}

private fun platformOf(value: JsonElement?): MachinePlatform =
    when (value.stringOrNull()) {
        "macos" -> MachinePlatform.Macos
        "linux" -> MachinePlatform.Linux
        else -> MachinePlatform.Unknown
    }

/** A number of epoch milliseconds, or an ISO date the relay may send instead; null when
 *  never seen or unreadable. */
private fun lastSeenOf(value: JsonElement?): Long? {
    value.numberOrNull()?.let { return it.toLong() }
    val text = value.stringOrNull() ?: return null
    return try {
        Instant.parse(text).toEpochMilli()
    } catch (_: DateTimeParseException) {
        try {
            OffsetDateTime.parse(text).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}
