package com.clave.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToString
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.clave.android.fake.FakeMachineServer
import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.toUri
import com.clave.core.state.LAST_MACHINE_KEY
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

/** The prefix of every machine this test adds, the flow test's, so either cleans the other's leftovers. */
private const val EVIDENCE_STAND_IN = "Stand-in "

/** How long a step waits for the app to show what it should. */
private const val EVIDENCE_WAIT_MS = 15_000L

/** The debug build's application id, the one the links are addressed to. */
private const val APP_PACKAGE = "com.clave.app.android.debug"

/** The flow test's clean start: no last machine to open on, no stand-in left by an interrupted run. */
private class EvidenceCleanStart : ExternalResource() {
    override fun before() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        val owner = withTimeout(EVIDENCE_WAIT_MS) { app.restoredOwner() }
        owner.kv.remove(LAST_MACHINE_KEY)
        owner.store.loadMachines()
        for (machine in owner.store.state.value.machines) {
            if (machine.id.startsWith("dev:") && machine.name.startsWith(EVIDENCE_STAND_IN)) owner.store.removeDeveloperMachine(machine.id)
        }
    }
}

/**
 * The evidence the decision brief asks of the composed app, on the emulator against the
 * stand-in machine ([FakeMachineServer]): the composer above the keyboard edge to edge and
 * the four themes with their status bar; Stop interrupting the agent's turn; the machine not
 * reachable and coming back; a send whose outcome the phone cannot confirm shown as a choice
 * and never sent again on its own; the notification links into a conversation and into the
 * requests. Each step a reviewer reads afterwards is a screenshot in the app's external
 * files, under `evidence/`; none is ever taken of the developer connection screen.
 */
@RunWith(AndroidJUnit4::class)
class AppEvidenceTest {
    private val rule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(EvidenceCleanStart()).around(rule)

    private lateinit var server: FakeMachineServer

    private val nonce = Integer.toHexString((System.nanoTime() and 0xffffff).toInt())
    private val machineName = "$EVIDENCE_STAND_IN$nonce"

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val targetContext get() = instrumentation.targetContext

    @Before
    fun startServer() {
        server = FakeMachineServer(TOKEN)
    }

    @After
    fun stopServer() {
        server.close()
    }

    // ── the flow test's helpers ──

    // Each wait names what it waits for, so a timeout says which step did not come. A moment with
    // no resumed compose root (the activity paused around a link's onNewIntent: the test library
    // drops the root at every lifecycle event but ON_RESUME) reads as "not on screen yet", never
    // as an IllegalStateException that ends the wait; the text must still come within the timeout.
    private fun waitForText(text: String, substring: Boolean = false, timeoutMs: Long = EVIDENCE_WAIT_MS) = rule.waitUntil("the text \"$text\" on screen", timeoutMs) {
        rule.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
    }

    private fun waitForNoText(text: String, timeoutMs: Long = EVIDENCE_WAIT_MS) = rule.waitUntil("the text \"$text\" gone", timeoutMs) {
        rule.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty()
    }

    private fun waitForDescription(description: String, timeoutMs: Long = EVIDENCE_WAIT_MS) = rule.waitUntil("the element \"$description\" on screen", timeoutMs) {
        rule.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    private fun requests(route: String) = server.requests.filter { "${it.method} ${it.path}" == route }

    /** The writes whose input is of [type]: `user_message`, `interrupt`. */
    private fun writesOf(type: String) = requests("POST /sessions/write").filter {
        JSONObject(it.body).optJSONObject("input")?.optString("type") == type
    }

    /** The header's Back once the screen behind it has finished leaving, so exactly one is on screen. */
    private fun tapBack() {
        rule.waitUntil(EVIDENCE_WAIT_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().size == 1 }
        rule.onNodeWithContentDescription("Back").performClick()
    }

    private fun SemanticsNodeInteraction.editableText(): String? =
        fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    /** The screen as the person sees it, status bar included, into the app's `evidence/` folder. */
    private fun screenshot(name: String) {
        rule.waitForIdle()
        val folder = File(targetContext.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val file = File(folder, name)
        assertTrue("the screenshot $name was written", UiDevice.getInstance(instrumentation).takeScreenshot(file))
    }

    // ── the flow ──

    /** The stand-in added from the developer card (never photographed: the token is typed there), back on Machines. */
    private fun addMachine() {
        waitForText("Sign in with Antasphere")
        waitForText("Developer connection")
        rule.onNodeWithText("Developer connection").performScrollTo().performClick()
        waitForDescription("Server address")
        rule.onNodeWithContentDescription("Server address").performTextInput(server.url)
        rule.onNodeWithContentDescription("Server token").performTextInput(TOKEN)
        rule.onNodeWithContentDescription("Name").performTextReplacement(machineName)
        rule.onNodeWithText("Connect").performClick()
        waitForText(machineName)
        waitForText("Sign in with Antasphere")
    }

    /** The machine added, then its workspace, the echo chat, the past read and the socket subscribed. */
    private fun openEchoChat() {
        addMachine()
        rule.onNodeWithText(machineName).performClick()
        waitForText("Scratch")
        rule.onNodeWithText("Scratch").performClick()
        waitForText("Echo chat")
        rule.onNodeWithText("Echo chat").performClick()
        waitForText("Hello from the test")
        waitForText("Hello back.")
        waitForDescription("Message")
        rule.waitUntil(EVIDENCE_WAIT_MS) { server.subscribers > 0 }
    }

    /** Back until Machines, the screen without a Back. */
    private fun backToMachines() {
        repeat(8) {
            rule.waitForIdle()
            if (rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isEmpty()) return@repeat
            tapBack()
        }
        rule.waitUntil(EVIDENCE_WAIT_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isEmpty() }
        waitForText("Sign in with Antasphere")
    }

    /** The stand-in forgotten from Machines, the flow test's way, so the next test starts clean. */
    private fun forgetMachine() {
        backToMachines()
        rule.onNodeWithContentDescription("More about $machineName").performScrollTo().performClick()
        waitForText("Forget this machine")
        rule.onNodeWithText("Forget this machine").performClick()
        rule.waitUntil(EVIDENCE_WAIT_MS) { rule.onAllNodesWithText(machineName).fetchSemanticsNodes().isEmpty() }
    }

    private fun imeBottom(): Int = rule.runOnUiThread {
        ViewCompat.getRootWindowInsets(rule.activity.window.decorView)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    }

    // ── the tests ──

    @Test
    fun theComposerStaysAboveTheKeyboardEdgeToEdge() {
        openEchoChat()
        screenshot("keyboard-closed.png")

        // The keyboard opens on a tap of the composer; the send control stays above it.
        rule.onNodeWithContentDescription("Message").performClick()
        rule.waitUntil(EVIDENCE_WAIT_MS) { imeBottom() > 0 }
        // The keyboard's own animation done: the inset read twice the same, a beat apart.
        rule.waitUntil(EVIDENCE_WAIT_MS) {
            val first = imeBottom()
            SystemClock.sleep(300)
            first == imeBottom()
        }
        rule.waitForIdle()
        val ime = imeBottom()
        val windowHeight = rule.runOnUiThread { rule.activity.window.decorView.height }
        val send = rule.onNodeWithContentDescription("Send message").fetchSemanticsNode().boundsInWindow
        assertTrue("the keyboard is open: its inset is $ime px", ime > 0)
        assertTrue(
            "Send message ends at ${send.bottom} px, above the keyboard's top at ${windowHeight - ime} px (window $windowHeight, keyboard $ime)",
            send.bottom <= windowHeight - ime,
        )
        screenshot("keyboard-open.png")

        // The keyboard put away, then the four themes, each photographed on Machines with its status bar.
        rule.runOnUiThread {
            WindowCompat.getInsetsController(rule.activity.window, rule.activity.window.decorView).hide(WindowInsetsCompat.Type.ime())
        }
        rule.waitUntil(EVIDENCE_WAIT_MS) { imeBottom() == 0 }
        backToMachines()
        for (theme in listOf("Dark", "Light", "Coffee", "Charcoal")) {
            rule.onNodeWithContentDescription("Appearance").performClick()
            waitForDescription(theme)
            rule.onNodeWithContentDescription(theme).performScrollTo().performClick()
            waitForDescription("$theme, selected")
            tapBack()
            rule.waitUntil(EVIDENCE_WAIT_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isEmpty() }
            waitForText(machineName)
            SystemClock.sleep(300)
            screenshot("theme-${theme.lowercase()}-machines.png")
        }
        rule.onNodeWithContentDescription("Appearance").performClick()
        waitForDescription("Match the system")
        rule.onNodeWithContentDescription("Match the system").performScrollTo().performClick()
        waitForDescription("Match the system, selected")
        tapBack()

        forgetMachine()
    }

    @Test
    fun stopInterruptsTheTurn() {
        openEchoChat()
        server.setSessionState("working")
        waitForDescription("Interrupt")
        waitForText("$machineName · Working")
        screenshot("stop-working.png")

        rule.onNodeWithContentDescription("Interrupt").performClick()
        rule.waitUntil(EVIDENCE_WAIT_MS) { writesOf("interrupt").isNotEmpty() }
        waitForText("$machineName · Idle")
        rule.waitForIdle()
        val interrupts = writesOf("interrupt")
        assertEquals("one Stop is one interrupt write: ${interrupts.map { it.body }}", 1, interrupts.size)
        assertEquals(FakeMachineServer.SESSION_ID, JSONObject(interrupts.single().body).getString("id"))
        assertTrue("the turn's end gives the composer its Send back", rule.onAllNodesWithContentDescription("Interrupt").fetchSemanticsNodes().isEmpty())

        forgetMachine()
    }

    @Test
    fun anUnreachableMachineIsSaidAndComesBack() {
        openEchoChat()
        val notices = listOf(
            "Not reachable: the machine is not answering right now.",
            "Connecting: the machine is not answering right now.",
        )
        fun noticeShown() = notices.any { rule.onAllNodesWithText(it).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
        assertTrue("a reachable machine has no notice", !noticeShown())

        server.pushDown = true
        server.dropPush()
        rule.waitUntil(30_000) { noticeShown() }
        screenshot("unreachable-chat.png")

        server.pushDown = false
        rule.waitUntil(45_000) { !noticeShown() }
        rule.waitForIdle()
        assertTrue("the notice is gone once the machine answers again", !noticeShown())

        forgetMachine()
    }

    @Test
    fun anUnknownDeliveryIsAChoiceAndNeverResentOnItsOwn() {
        openEchoChat()
        server.failWrites = true
        rule.onNodeWithContentDescription("Message").performTextInput("will this land?")
        rule.tapSendAtRest(EVIDENCE_WAIT_MS)
        val asked = SystemClock.elapsedRealtime()
        // Normally shown within a second (264 ms and 342 ms in the runs of 10 November); a timeout
        // here says what the screen showed.
        try {
            waitForText("Delivery unknown", timeoutMs = 75_000)
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("no unknown delivery after the failed write; the screen: ${rule.onRoot(useUnmergedTree = true).printToString()}", e)
        }
        val tookMs = SystemClock.elapsedRealtime() - asked
        android.util.Log.i("AppEvidenceTest", "Delivery unknown shown $tookMs ms after the send")
        waitForText("Send again (may duplicate)")
        waitForText("Discard")
        assertEquals("the failed send is one write", 1, requests("POST /sessions/write").size)
        SystemClock.sleep(5_000)
        rule.waitForIdle()
        assertEquals("nothing is sent again on its own: ${requests("POST /sessions/write").map { it.body }}", 1, requests("POST /sessions/write").size)
        // The draft stays in the field, and Send is disabled until the person picks the card's
        // "Send again" or "Discard": a plain send would be a second message under a new id.
        assertEquals("will this land?", rule.onNodeWithContentDescription("Message").editableText())
        rule.onNodeWithContentDescription("Send message").assertIsNotEnabled()
        screenshot("delivery-unknown.png")

        rule.onNodeWithText("Discard").performClick()
        waitForNoText("Delivery unknown")
        rule.waitUntil(EVIDENCE_WAIT_MS) { rule.onNodeWithContentDescription("Message").editableText() == "" }
        assertEquals("a discard sends nothing", 1, requests("POST /sessions/write").size)

        server.failWrites = false
        rule.onNodeWithContentDescription("Message").performTextInput("now it lands")
        rule.tapSendAtRest(EVIDENCE_WAIT_MS)
        // The stand-in answers the follow-up with "pong" once its write is accepted: the reply on
        // screen is what shows the next send landed. A timeout says what the screen showed and how
        // many writes the stand-in had.
        try {
            waitForText("pong")
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("no reply to the follow-up send; writes ${requests("POST /sessions/write").size}; the screen: ${rule.onRoot(useUnmergedTree = true).printToString()}", e)
        }
        rule.waitForIdle()
        assertEquals("the next send is one more write: ${requests("POST /sessions/write").map { it.body }}", 2, requests("POST /sessions/write").size)
        assertEquals("now it lands", JSONObject(requests("POST /sessions/write").last().body).getJSONObject("input").getString("text"))

        forgetMachine()
    }

    @Test
    fun aLinkOpensTheConversationAndTheRequests() {
        addMachine()
        val app = services(targetContext)
        val id = app.owner.value!!.store.state.value.machines.first { it.name == machineName }.id

        fun open(link: DeepLink) = instrumentation.context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(link.toUri())).setPackage(APP_PACKAGE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )

        open(DeepLink.Chat(id, FakeMachineServer.SESSION_ID, "Echo chat"))
        waitForText("Hello from the test")
        waitForText("Hello back.")
        screenshot("link-chat.png")

        open(DeepLink.Requests(id, FakeMachineServer.REQUEST_ID))
        waitForText("Run ./gradlew test")
        waitForText("Allow")
        screenshot("link-requests.png")

        // A real notification, through the app's own poster: one, with the session's title, then cancelled.
        // The runtime permission exists from Android 13; older systems post without one, and
        // UiAutomation.grantRuntimePermission itself only exists from Android 9 (API 28).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.uiAutomation.grantRuntimePermission(targetContext.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        val payload = NotificationPayload(
            category = NotificationCategory.Finished,
            serverId = "stand-in",
            serverName = "Stand-in",
            sessionId = FakeMachineServer.SESSION_ID,
            sessionTitle = "Echo chat",
            text = "Finished",
            actions = listOf(NotificationAction.Open),
        )
        app.notifications.post(payload, machineId = id)
        val manager = targetContext.getSystemService(NotificationManager::class.java)
        fun posted() = manager.activeNotifications.filter {
            it.tag == "stand-in" && it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == "Echo chat"
        }
        rule.waitUntil(EVIDENCE_WAIT_MS) { posted().isNotEmpty() }
        assertEquals("one notification for the echo chat", 1, posted().size)
        assertEquals(app.notifications.idOf(payload), posted().single().id)
        assertTrue("the notification opens something when tapped", posted().single().notification.contentIntent != null)
        app.notifications.cancel("stand-in", app.notifications.idOf(payload))
        rule.waitUntil(EVIDENCE_WAIT_MS) { posted().isEmpty() }

        forgetMachine()
    }

    private companion object {
        const val TOKEN = "test-token"
    }
}
