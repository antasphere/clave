package com.clave.android.push

import com.clave.android.services
import com.clave.core.contract.DevicePlatform
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.parsePayload
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/** How long a push waits for the stored login, in a process the push itself started. */
private const val OWNER_WAIT_MS: Long = 8_000

/**
 * Firebase's delivery of a push and of a new token. A push that is Clave's is posted with the
 * machine its server resolves to through the current account's pairing records (none when the
 * phone is not paired with it: the tap then lands on Machines with the reason); anything else
 * is dropped. A new token is registered with every paired machine. Without a Firebase project
 * this service is never started, and nothing here touches FirebaseMessaging itself.
 */
class ClaveMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val services = services(this)
        val payload = parsePayload(message.data) ?: return
        // Firebase calls this on its own worker thread and waits for it to return. The machine
        // is the owner services' choice (OwnerServices.machineForServer, tested there).
        val machineId = runBlocking {
            withTimeoutOrNull(OWNER_WAIT_MS) {
                services.restoredOwner().services.machineForServer(payload.serverId)
            }
        }
        services.notifications.post(message.data, machineId)
    }

    // Deprecated in firebase-messaging 26 with no replacement that hands the new FCM token.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        val services = services(this)
        services.scope.launch {
            try {
                val owner = withTimeoutOrNull(OWNER_WAIT_MS) { services.restoredOwner() } ?: return@launch
                owner.scope.launch { owner.services.syncPushTokens(DeviceToken(DevicePlatform.Android.wire, token)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                services.log.event("push.token_sync_failed", mapOf("error" to e::class.simpleName))
            }
        }
    }
}
