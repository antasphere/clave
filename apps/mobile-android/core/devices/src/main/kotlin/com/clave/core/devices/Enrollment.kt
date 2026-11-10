package com.clave.core.devices

import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.DevicePlatform
import com.clave.core.contract.DeviceSession
import com.clave.core.contract.DeviceView
import com.clave.core.contract.PairingRead
import com.clave.core.contract.PairingStatus
import com.clave.core.contract.PairingTicket
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Why an enrollment call failed, each said plainly by the pairing screen. */
public enum class EnrollmentFailure {
    /** The request never completed. */
    Network,
    /** The deadline passed. */
    Timeout,
    /** The server refused the ID token by one of its checks (`check` names it). */
    Refused,
    /** The server has no Antasphere login: nobody owns it, so it admits no phone. */
    NoOwner,
    /** The device session is not this server's any more. */
    Unauthenticated,
    /** The phone's record is gone: the owner revoked it. */
    Revoked,
    /** The server answered something this client does not read. */
    Protocol,
    /** This build sends no credential to that address (the transport policy). */
    Policy,
    /** The approval was already handed out to an earlier read. */
    Consumed,
}

/** An enrollment failure. The message never carries the ID token nor the device session:
 *  the server names the check that refused, never what it read. */
public class EnrollmentError(
    public val kind: EnrollmentFailure,
    message: String,
    /** The name of the check that refused the token, on a [EnrollmentFailure.Refused]. */
    public val check: String? = null,
    public val status: Int? = null,
) : Exception(message)

/** The two calls the pairing loop makes, so it runs over a scripted client in a test. */
public interface PairingClient {
    public suspend fun requestPairing(idToken: String, clientId: String, device: DeviceDescription): PairingTicket
    public suspend fun readPairing(pairingId: String): PairingRead
}

/**
 * The enrollment client: the device routes on a Clave server, as
 * `packages/contract/src/devices.ts` defines them. `POST /devices/pair` takes no bearer, the
 * proof is in the body (the hub's ID token for the phone's own client id, and how the phone
 * names itself); `GET /devices/pair?id=` says where the pairing stands and carries the
 * device session exactly once on `approved`; the device's own routes take the device
 * session as the bearer. The base URL is the machine's road; the transport policy decides
 * here, before anything is sent, whether a credential may travel there in this build.
 */
public class EnrollmentClient(
    serverUrl: String,
    private val http: HttpPort,
    build: BuildKind = BuildKind.Release,
    private val timeoutMs: Long = 10_000,
) : PairingClient {
    public val baseUrl: String = serverUrl.trimEnd('/')

    init {
        val verdict = credentialMayTravelTo(baseUrl, build)
        if (verdict is TransportVerdict.Refused) throw EnrollmentError(EnrollmentFailure.Policy, verdict.reason)
    }

    /** Asks to pair; the owner's word is awaited through [readPairing]. */
    override suspend fun requestPairing(idToken: String, clientId: String, device: DeviceDescription): PairingTicket {
        val body = buildJsonObject {
            put("idToken", idToken)
            put("clientId", clientId)
            put(
                "device",
                buildJsonObject {
                    put("name", device.name)
                    put("platform", device.platform.wire)
                    put("appVersion", device.appVersion)
                },
            )
        }
        val json = send("POST", "/devices/pair", body = body.toString()).objectOrNull()
            ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The pairing answer is unreadable.")
        return PairingTicket(
            pairingId = required(json["pairingId"], "the pairing id"),
            expiresAt = json["expiresAt"].numberOrNull()?.toLong() ?: 0,
        )
    }

    override suspend fun readPairing(pairingId: String): PairingRead {
        val json = send("GET", "/devices/pair?id=${encodeUriComponent(pairingId)}").objectOrNull()
            ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The pairing answer is unreadable.")
        val status = json["status"].stringOrNull()?.let { PairingStatus.of(it) }
            ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The pairing's status is unreadable.")
        return if (!json.containsKey("deviceSession")) PairingRead(status)
        else PairingRead(status, decodeDeviceSession(json["deviceSession"]))
    }

    public suspend fun me(bearer: String): DeviceView = decodeDeviceView(send("GET", "/devices/me", bearer = bearer))

    public suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform) {
        val body = buildJsonObject {
            put("token", token)
            put("platform", platform.wire)
        }
        send("POST", "/devices/me/push-token", bearer = bearer, body = body.toString())
    }

    public suspend fun clearPushToken(bearer: String) {
        send("POST", "/devices/me/push-token/clear", bearer = bearer, body = "{}")
    }

    private suspend fun send(method: String, path: String, bearer: String? = null, body: String? = null): JsonElement? {
        val headers = buildMap {
            put("Accept", "application/json")
            if (!bearer.isNullOrEmpty()) put("Authorization", "Bearer $bearer")
            if (body != null) put("Content-Type", "application/json")
        }
        val response: HttpResponse = try {
            http.send(HttpRequest(method, "$baseUrl$path", headers, body, timeoutMs))
        } catch (e: CancellationException) {
            throw e
        } catch (_: HttpFailure.Timeout) {
            throw EnrollmentError(EnrollmentFailure.Timeout, "The machine did not answer within ${seconds(timeoutMs)} s.")
        } catch (_: Exception) {
            // The cause is dropped on purpose: a transport's exception may quote the request.
            throw EnrollmentError(EnrollmentFailure.Network, "The machine could not be reached.")
        }
        val status = response.status
        var json: JsonElement? = null
        if (response.body.isNotEmpty()) {
            json = parseJsonOrNull(response.body)
            if (json == null && status in 200..299) {
                throw EnrollmentError(EnrollmentFailure.Protocol, "The machine answered something unreadable.", status = status)
            }
        }
        if (status == 401) throw EnrollmentError(EnrollmentFailure.Unauthenticated, "The machine refused the device session.", status = status)
        if (status == 422) throw refusal(json.objectOrNull(), status)
        if (status !in 200..299) throw EnrollmentError(EnrollmentFailure.Protocol, "The machine answered $status.", status = status)
        return json
    }

    /** A declared failure, by its tag: the server names the check that refused the token,
     *  never the token. */
    private fun refusal(json: JsonObject?, status: Int): EnrollmentError {
        val tag = json?.get("_tag").stringOrNull() ?: ""
        val message = json?.get("message").stringOrNull()?.takeIf { it.isNotEmpty() } ?: ""
        return when (tag) {
            "DevicePairingRefused" -> {
                val check = json?.get("check").stringOrNull() ?: "unknown"
                EnrollmentError(
                    EnrollmentFailure.Refused,
                    message.ifEmpty { "The machine refused the sign-in ($check)." },
                    check = check,
                    status = status,
                )
            }
            "CapabilityUnavailable" -> EnrollmentError(
                EnrollmentFailure.NoOwner,
                "This machine has no Antasphere login. Sign in on it first, then pair.",
                status = status,
            )
            "DeviceNotFound", "DeviceSessionRequired" -> EnrollmentError(
                EnrollmentFailure.Revoked,
                message.ifEmpty { "This phone is no longer paired with the machine." },
                status = status,
            )
            else -> EnrollmentError(
                EnrollmentFailure.Protocol,
                message.ifEmpty { "The machine refused (${tag.ifEmpty { "422" }})." },
                status = status,
            )
        }
    }
}

private fun seconds(ms: Long): String {
    val s = ms / 1000.0
    return if (s == Math.floor(s)) s.toLong().toString() else s.toString()
}

private fun required(value: JsonElement?, what: String): String =
    value.stringOrNull()?.takeIf { it.isNotEmpty() }
        ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The server's answer lacks $what.")

private fun decodeDeviceSession(value: JsonElement?): DeviceSession {
    val json = value.objectOrNull() ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The device session is unreadable.")
    return DeviceSession(
        token = required(json["token"], "the session token"),
        deviceId = required(json["deviceId"], "the device id"),
        serverId = required(json["serverId"], "the server id"),
        serverName = json["serverName"].stringOrNull() ?: "",
    )
}

private fun decodeDeviceView(value: JsonElement?): DeviceView {
    val json = value.objectOrNull() ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The device record is unreadable.")
    val platform = json["platform"].stringOrNull()?.let { DevicePlatform.of(it) }
        ?: throw EnrollmentError(EnrollmentFailure.Protocol, "The device record's platform is unreadable.")
    return DeviceView(
        id = required(json["id"], "the device id"),
        name = required(json["name"], "the device name"),
        platform = platform,
        appVersion = json["appVersion"].stringOrNull() ?: "",
        createdAt = json["createdAt"].numberOrNull()?.toLong() ?: 0,
        lastSeenAt = json["lastSeenAt"].numberOrNull()?.toLong(),
    )
}
