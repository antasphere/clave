package com.clave.platform.push

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import com.clave.core.notifications.ActionIds
import com.clave.core.notifications.DEEP_LINK_SCHEME
import com.clave.core.notifications.DEFAULT_ACTION_IDENTIFIER
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.NotificationActionSpec
import com.clave.core.notifications.categoryDeclarations
import com.clave.core.notifications.categoryIdentifier
import com.clave.core.notifications.parsePayload
import com.clave.core.notifications.toUri
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The extras a notification's action broadcast carries and their reading back: the action's
 * identifier, the push's data as a bundle of strings (what [parsePayload] reads), the machine,
 * the notification's tag and id (to cancel it) and when it was posted (to tell a second
 * delivery of one tap from a new one). The app's receiver turns an intent into the core's
 * [IncomingResponse] with [incomingResponse] and hands it to the core.
 */
object NotificationIntents {
    const val EXTRA_ACTION_IDENTIFIER: String = "com.clave.platform.extra.ACTION_IDENTIFIER"
    const val EXTRA_PAYLOAD: String = "com.clave.platform.extra.PAYLOAD"
    const val EXTRA_MACHINE_ID: String = "com.clave.platform.extra.MACHINE_ID"
    const val EXTRA_NOTIFICATION_TAG: String = "com.clave.platform.extra.NOTIFICATION_TAG"
    const val EXTRA_NOTIFICATION_ID: String = "com.clave.platform.extra.NOTIFICATION_ID"
    const val EXTRA_POSTED_AT: String = "com.clave.platform.extra.POSTED_AT"
    const val REMOTE_INPUT_REPLY: String = "com.clave.platform.REPLY"

    /** The person's answer an action broadcast carries; null for an intent without Clave's payload. */
    fun incomingResponse(intent: Intent): IncomingResponse? {
        val bundle = intent.getBundleExtra(EXTRA_PAYLOAD) ?: return null
        val data = JsonObject(bundle.keySet().mapNotNull { key -> bundle.getString(key)?.let { key to JsonPrimitive(it) } }.toMap())
        val tag = intent.getStringExtra(EXTRA_NOTIFICATION_TAG).orEmpty()
        val id = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        return IncomingResponse(
            notificationId = "$tag/$id",
            date = intent.getLongExtra(EXTRA_POSTED_AT, 0L),
            actionIdentifier = intent.getStringExtra(EXTRA_ACTION_IDENTIFIER) ?: DEFAULT_ACTION_IDENTIFIER,
            data = data,
            userText = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REMOTE_INPUT_REPLY)?.toString(),
        )
    }

    /** The machine the notification was posted for, when it named one. */
    fun machineId(intent: Intent): String? = intent.getStringExtra(EXTRA_MACHINE_ID)

    /** The tag and id the notification was posted under, for [ClaveNotifications.cancel]. */
    fun notificationOf(intent: Intent): Pair<String, Int>? {
        val tag = intent.getStringExtra(EXTRA_NOTIFICATION_TAG) ?: return null
        if (!intent.hasExtra(EXTRA_NOTIFICATION_ID)) return null
        return tag to intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
    }
}

/**
 * The app's notifications: one high-importance channel, and a push posted with the actions
 * its category declares in the core (allow and deny on a permission, a reply on a question)
 * and the payload offers. A tap opens [openActivity] on the deep link of the conversation, or
 * of the request when the notification could not settle one, or Machines when the server is
 * not paired; an action answers [actionReceiver] in the background with the push's data, never
 * a credential. One notification per request (else per session), tagged by its server.
 */
class ClaveNotifications(
    private val context: Context,
    private val channelName: String,
    private val channelDescription: String,
    private val openActivity: Class<out Activity>,
    private val actionReceiver: Class<out BroadcastReceiver>,
    /** The app's own monochrome icon; this module cannot name the app's resources. */
    private val smallIcon: Int,
    private val channelId: String = "clave",
    private val deepLinkScheme: String = DEEP_LINK_SCHEME,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Volatile
    private var channelReady = false

    fun ensureChannel() {
        if (channelReady) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(channelId) == null) {
            val channel = NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_HIGH)
            channel.description = channelDescription
            manager.createNotificationChannel(channel)
        }
        channelReady = true
    }

    /** Posts [payload]; its data is re-encoded in the FCM shape for the action broadcasts. */
    fun post(payload: NotificationPayload, machineId: String?, requestId: String? = payload.requestId) {
        show(payload, build(payload, machineId, requestId, dataOf(payload)), requestId)
    }

    /** Posts a push's data as FCM hands it; false when the data is not Clave's. */
    fun post(data: Map<String, String>, machineId: String?): Boolean {
        val payload = parsePayload(data) ?: return false
        show(payload, build(payload, machineId, payload.requestId, data), payload.requestId)
        return true
    }

    fun cancel(serverId: String, id: Int) {
        NotificationManagerCompat.from(context).cancel(serverId, id)
    }

    /** The id a payload is posted under: its request's, else its session's. */
    fun idOf(payload: NotificationPayload, requestId: String? = payload.requestId): Int =
        requestId?.hashCode() ?: payload.sessionId.hashCode()

    private fun show(payload: NotificationPayload, notification: Notification, requestId: String?) {
        ensureChannel()
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        // Android 13 and later: posting needs the runtime permission; without it nothing is shown.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        try {
            manager.notify(payload.serverId, idOf(payload, requestId), notification)
        } catch (_: SecurityException) {
            // The permission was withdrawn between the check and the post: nothing is shown.
        }
    }

    internal fun build(
        payload: NotificationPayload,
        machineId: String?,
        requestId: String?,
        data: Map<String, String>,
    ): Notification {
        val id = idOf(payload, requestId)
        val postedAt = now()
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon)
            .setContentTitle(payload.sessionTitle)
            .setContentText(payload.text)
            .setSubText(payload.serverName)
            .setWhen(postedAt)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(androidCategoryOf(payload.category))
            .setContentIntent(contentIntent(payload, machineId, requestId, id))
        val identifier = categoryIdentifier(payload.category)
        val specs = categoryDeclarations().firstOrNull { it.identifier == identifier }?.actions.orEmpty()
        for (spec in specs) {
            if (offered(spec, payload)) builder.addAction(action(spec, payload, machineId, data, id, postedAt))
        }
        return builder.build()
    }

    private fun contentIntent(payload: NotificationPayload, machineId: String?, requestId: String?, id: Int): PendingIntent {
        val link: DeepLink = when {
            machineId == null -> DeepLink.Machines("")
            requestId != null && payload.category in REQUEST_CATEGORIES -> DeepLink.Requests(machineId, requestId)
            payload.sessionId.isNotEmpty() -> DeepLink.Chat(machineId, payload.sessionId, payload.sessionTitle)
            else -> DeepLink.Workspaces(machineId)
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link.toUri(deepLinkScheme)))
            .setClass(context, openActivity)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun action(
        spec: NotificationActionSpec,
        payload: NotificationPayload,
        machineId: String?,
        data: Map<String, String>,
        id: Int,
        postedAt: Long,
    ): NotificationCompat.Action {
        val bundle = Bundle().apply { for ((key, value) in data) putString(key, value) }
        // The action and the data make each broadcast its own PendingIntent: extras alone would not.
        val intent = Intent("com.clave.platform.action.${spec.identifier}")
            .setClass(context, actionReceiver)
            .setData(Uri.parse("clave-notification://${Uri.encode(payload.serverId)}/$id"))
            .putExtra(NotificationIntents.EXTRA_ACTION_IDENTIFIER, spec.identifier)
            .putExtra(NotificationIntents.EXTRA_PAYLOAD, bundle)
            .putExtra(NotificationIntents.EXTRA_NOTIFICATION_TAG, payload.serverId)
            .putExtra(NotificationIntents.EXTRA_NOTIFICATION_ID, id)
            .putExtra(NotificationIntents.EXTRA_POSTED_AT, postedAt)
        if (machineId != null) intent.putExtra(NotificationIntents.EXTRA_MACHINE_ID, machineId)
        val input = spec.textInput
        // A reply's PendingIntent must be mutable: the system writes the typed text into it.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (input != null) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, id, intent, flags)
        val builder = NotificationCompat.Action.Builder(0, spec.buttonTitle, pending)
            .setShowsUserInterface(spec.options?.opensAppToForeground == true)
            .setAuthenticationRequired(spec.options?.isAuthenticationRequired == true)
        if (input != null) {
            builder.addRemoteInput(RemoteInput.Builder(NotificationIntents.REMOTE_INPUT_REPLY).setLabel(input.placeholder).build())
            builder.setAllowGeneratedReplies(false)
        }
        return builder.build()
    }

    private companion object {
        val REQUEST_CATEGORIES = setOf(NotificationCategory.Permission, NotificationCategory.Question, NotificationCategory.Secret)

        /** An action the payload does not offer is not shown: the core would read it as a plain open. */
        fun offered(spec: NotificationActionSpec, payload: NotificationPayload): Boolean = when (spec.identifier) {
            ActionIds.allow -> NotificationAction.Allow in payload.actions
            ActionIds.deny -> NotificationAction.Deny in payload.actions
            ActionIds.reply -> NotificationAction.Reply in payload.actions
            else -> false
        }

        fun androidCategoryOf(category: NotificationCategory): String = when (category) {
            NotificationCategory.Question, NotificationCategory.Permission, NotificationCategory.Secret ->
                NotificationCompat.CATEGORY_MESSAGE
            NotificationCategory.Failed -> NotificationCompat.CATEGORY_ERROR
            NotificationCategory.Finished, NotificationCategory.AccountLimit, NotificationCategory.Test ->
                NotificationCompat.CATEGORY_STATUS
        }

        /** The payload in the FCM data shape [parsePayload] reads: every value a string. */
        fun dataOf(payload: NotificationPayload): Map<String, String> = buildMap {
            put("category", payload.category.wire)
            put("serverId", payload.serverId)
            put("serverName", payload.serverName)
            put("sessionId", payload.sessionId)
            put("sessionTitle", payload.sessionTitle)
            payload.workspaceName?.let { put("workspaceName", it) }
            payload.requestId?.let { put("requestId", it) }
            put("text", payload.text)
            put("actions", payload.actions.joinToString(",") { it.wire })
            put("categoryId", categoryIdentifier(payload.category))
        }
    }
}
