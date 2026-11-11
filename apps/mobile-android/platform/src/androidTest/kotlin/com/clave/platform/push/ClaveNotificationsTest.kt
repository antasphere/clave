package com.clave.platform.push

import android.app.Activity
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.RemoteInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import com.clave.core.notifications.ActionIds
import com.clave.core.notifications.DEFAULT_ACTION_IDENTIFIER
import com.clave.core.notifications.NotificationIntent
import com.clave.core.notifications.interpretResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Targets for the intents the notifications build; never started by these checks. */
class OpenTarget : Activity()

class ActionTarget : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {}
}

@RunWith(AndroidJUnit4::class)
class ClaveNotificationsTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val notifications = ClaveNotifications(
        context = context,
        channelName = "Clave",
        channelDescription = "Questions, permissions and finished sessions.",
        openActivity = OpenTarget::class.java,
        actionReceiver = ActionTarget::class.java,
        smallIcon = android.R.drawable.ic_dialog_info,
        now = { 1_700_000_000_000 },
    )

    private fun payload(category: NotificationCategory, actions: List<NotificationAction>, requestId: String? = "req-1") =
        NotificationPayload(
            category = category,
            serverId = "server-1",
            serverName = "Studio Mac",
            sessionId = "session-1",
            sessionTitle = "Refactor the parser",
            requestId = requestId,
            text = "Run the tests?",
            actions = actions,
        )

    @Test
    fun ensureChannelCreatesTheChannel() {
        notifications.ensureChannel()
        val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel("clave")
        assertNotNull(channel)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
    }

    @Test
    fun aPermissionCarriesAllowAndDeny() {
        val payload = payload(NotificationCategory.Permission, listOf(NotificationAction.Allow, NotificationAction.Deny))
        val notification = notifications.build(payload, "machine-1", payload.requestId, mapOf("category" to "permission"))
        assertEquals(2, notification.actions.size)
        assertEquals(listOf("Allow", "Deny"), notification.actions.map { it.title.toString() })
        assertNotNull(notification.contentIntent)
        assertEquals("clave", notification.channelId)
        assertEquals("Refactor the parser", notification.extras.getCharSequence("android.title").toString())
    }

    @Test
    fun aPermissionShowsOnlyTheActionsItOffers() {
        val payload = payload(NotificationCategory.Permission, listOf(NotificationAction.Deny))
        val notification = notifications.build(payload, "machine-1", payload.requestId, emptyMap())
        assertEquals(listOf("Deny"), notification.actions.map { it.title.toString() })
    }

    @Test
    fun aQuestionCarriesAReplyField() {
        val payload = payload(NotificationCategory.Question, listOf(NotificationAction.Reply))
        val notification = notifications.build(payload, "machine-1", payload.requestId, emptyMap())
        assertEquals(1, notification.actions.size)
        assertEquals("Reply", notification.actions[0].title.toString())
        assertTrue(notification.actions[0].remoteInputs.isNotEmpty())
        assertEquals("Your answer", notification.actions[0].remoteInputs[0].label.toString())
    }

    @Test
    fun aFinishedSessionCarriesNoAction() {
        val payload = payload(NotificationCategory.Finished, listOf(NotificationAction.Open), requestId = null)
        val notification = notifications.build(payload, null, null, emptyMap())
        assertTrue(notification.actions.isNullOrEmpty())
        assertNotNull(notification.contentIntent)
    }

    @Test
    fun anActionBroadcastReadsBackAsTheCoresResponse() {
        val data = Bundle().apply {
            putString("category", "question")
            putString("serverId", "server-1")
            putString("serverName", "Studio Mac")
            putString("sessionId", "session-1")
            putString("sessionTitle", "Refactor the parser")
            putString("requestId", "req-1")
            putString("text", "Which file?")
            putString("actions", "reply")
        }
        val intent = Intent(context, ActionTarget::class.java)
            .putExtra(NotificationIntents.EXTRA_ACTION_IDENTIFIER, ActionIds.reply)
            .putExtra(NotificationIntents.EXTRA_PAYLOAD, data)
            .putExtra(NotificationIntents.EXTRA_MACHINE_ID, "machine-1")
            .putExtra(NotificationIntents.EXTRA_NOTIFICATION_TAG, "server-1")
            .putExtra(NotificationIntents.EXTRA_NOTIFICATION_ID, 42)
            .putExtra(NotificationIntents.EXTRA_POSTED_AT, 1_700_000_000_000)
        val input = RemoteInput.Builder(NotificationIntents.REMOTE_INPUT_REPLY).setLabel("Your answer").build()
        RemoteInput.addResultsToIntent(
            arrayOf(input),
            intent,
            Bundle().apply { putCharSequence(NotificationIntents.REMOTE_INPUT_REPLY, "parser.kt") },
        )

        val response = NotificationIntents.incomingResponse(intent)!!
        assertEquals(ActionIds.reply, response.actionIdentifier)
        assertEquals("parser.kt", response.userText)
        assertEquals("server-1/42", response.notificationId)
        assertEquals(1_700_000_000_000, response.date)
        assertEquals("machine-1", NotificationIntents.machineId(intent))
        assertEquals("server-1" to 42, NotificationIntents.notificationOf(intent))
        val intentOf = interpretResponse(response)
        assertTrue(intentOf is NotificationIntent.Reply)
        assertEquals("parser.kt", (intentOf as NotificationIntent.Reply).text)
        assertEquals("req-1", intentOf.payload.requestId)
    }

    @Test
    fun anIntentWithoutThePayloadIsNotClaves() {
        assertNull(NotificationIntents.incomingResponse(Intent(context, ActionTarget::class.java)))
        val tap = Intent().putExtra(NotificationIntents.EXTRA_PAYLOAD, Bundle())
        assertEquals(DEFAULT_ACTION_IDENTIFIER, NotificationIntents.incomingResponse(tap)!!.actionIdentifier)
    }
}
