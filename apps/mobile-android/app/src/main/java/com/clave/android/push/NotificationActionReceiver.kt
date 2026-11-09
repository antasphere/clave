package com.clave.android.push

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.clave.android.AppServices
import com.clave.android.MainActivity
import com.clave.android.R
import com.clave.android.services
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.HandleResult
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.parsePayload
import com.clave.core.notifications.toUri
import com.clave.platform.push.NotificationIntents
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** A broadcast may run this long; the system allows a receiver ten seconds in the background. */
private const val RESPONSE_TIMEOUT_MS: Long = 10_000

/** The channel ClaveNotifications posts on, so the follow-up lands beside the push it replaces. */
private const val CHANNEL_ID: String = "clave"

/**
 * A notification's Allow, Deny or Reply, answered in the background: the response goes to
 * the current account's inbox, which settles it through the core with the credential of the
 * machine the push's own server resolves to. A settled response removes its notification. One
 * the notification cannot settle keeps its link in the inbox for the next launch and, while
 * the app is not in front, replaces the push with a plain "Open Clave to answer" whose tap
 * opens that link. Nothing posted here carries a credential.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val response = NotificationIntents.incomingResponse(intent) ?: return
        val services = services(context)
        val pending = goAsync()
        services.scope.launch {
            try {
                withTimeout(RESPONSE_TIMEOUT_MS) {
                    val result = services.restoredOwner().receive(response)
                    val notification = NotificationIntents.notificationOf(intent)
                    when (result) {
                        HandleResult.Settled -> notification?.let { (tag, id) -> services.notifications.cancel(tag, id) }
                        is HandleResult.Open -> if (services.foreground.isForeground) {
                            notification?.let { (tag, id) -> services.notifications.cancel(tag, id) }
                        } else {
                            askToOpen(context, services, response, result.link, notification)
                        }
                        HandleResult.Ignored, null -> Unit
                    }
                }
            } catch (_: TimeoutCancellationException) {
                services.log.event("notification.response_timeout")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                services.log.event("notification.response_failed", mapOf("error" to e::class.simpleName))
            } finally {
                pending.finish()
            }
        }
    }

    /** Replaces the push with a plain notification that opens the app on [link]. */
    private fun askToOpen(
        context: Context,
        services: AppServices,
        response: IncomingResponse,
        link: DeepLink,
        notification: Pair<String, Int>?,
    ) {
        services.notifications.ensureChannel()
        val (tag, id) = notification ?: ("clave" to link.hashCode())
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(link.toUri()))
            .setClass(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val content = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val built = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_open_to_answer))
            .setContentText(parsePayload(response.data)?.text.orEmpty())
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(content)
            .build()
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(tag, id, built)
        } catch (_: SecurityException) {
            // The permission was withdrawn between the check and the post: nothing is shown.
        }
    }
}
