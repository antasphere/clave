package com.clave.core.notifications

import com.clave.core.contract.DevicePlatform
import com.clave.core.devices.EnrollmentClient
import com.clave.core.ports.KeyValueStore
import kotlin.coroutines.cancellation.CancellationException

/**
 * The device token, registered with the paired machine so its server can push to this
 * phone (decision 9 of the spec): the raw FCM token from the platform, sent through
 * `POST /devices/me/push-token` with the device session, once per token value and again
 * when the platform hands a new one. The last token registered with each machine is kept
 * in the key-value store, so a boot that gets the same token sends nothing. A build
 * without Firebase hands no token: said as such, never as a failure of the machine.
 */
public fun pushTokenKey(machineId: String): String = "clave.push-token:$machineId"

public sealed interface TokenRegistration {
    public data class Registered(val token: String) : TokenRegistration {
        override fun toString(): String = "Registered(token=<redacted>)"
    }
    public data object Unchanged : TokenRegistration
    /** No native token on this platform, or the platform refused to hand one. */
    public data class Unsupported(val reason: String) : TokenRegistration
    public data class Failed(val reason: String) : TokenRegistration
}

/** The platform's token: `type` names the platform (`android`, `ios`, anything else). */
public data class DeviceToken(val type: String, val data: String?) {
    override fun toString(): String = "DeviceToken(type=$type, data=<redacted>)"
}

public fun interface PushTokenSource {
    /** Null when this build or device hands out no token. */
    public suspend fun deviceToken(): DeviceToken?
}

public interface PushTokenClient {
    public suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform)
    public suspend fun clearPushToken(bearer: String)
}

/** The enrollment client as the token's client. */
public fun EnrollmentClient.asPushTokenClient(): PushTokenClient {
    val client = this
    return object : PushTokenClient {
        override suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform) =
            client.setPushToken(bearer, token, platform)

        override suspend fun clearPushToken(bearer: String) = client.clearPushToken(bearer)
    }
}

public data class TokenTarget(val machineId: String, val bearer: String, val platform: DevicePlatform) {
    override fun toString(): String = "TokenTarget(machineId=$machineId, bearer=<redacted>, platform=$platform)"
}

public suspend fun registerDeviceToken(
    target: TokenTarget,
    source: PushTokenSource,
    client: PushTokenClient,
    kv: KeyValueStore,
): TokenRegistration {
    val got = try {
        source.deviceToken()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return TokenRegistration.Unsupported("This device hands out no push token (${e.message ?: e::class.simpleName}).")
    } ?: return TokenRegistration.Unsupported("This device hands out no push token.")
    val platform = DevicePlatform.of(got.type)
    val data = got.data
    if (platform == null || data.isNullOrEmpty()) {
        return TokenRegistration.Unsupported("No native push token on this platform (${got.type}).")
    }
    if (platform != target.platform) {
        return TokenRegistration.Unsupported("The token is ${got.type}'s and the device registered as ${target.platform.wire}.")
    }
    val key = pushTokenKey(target.machineId)
    if (kv.get(key) == data) return TokenRegistration.Unchanged
    try {
        client.setPushToken(target.bearer, data, target.platform)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return TokenRegistration.Failed(e.message ?: "The machine refused the push token.")
    }
    kv.set(key, data)
    return TokenRegistration.Registered(data)
}

/** The phone no longer wants notifications from this machine. */
public suspend fun clearDeviceToken(machineId: String, bearer: String, client: PushTokenClient, kv: KeyValueStore) {
    client.clearPushToken(bearer)
    kv.remove(pushTokenKey(machineId))
}
