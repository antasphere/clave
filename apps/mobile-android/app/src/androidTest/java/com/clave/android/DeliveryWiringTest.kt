package com.clave.android

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.android.fake.FakeMachineServer
import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendEnd
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.toUri
import com.clave.core.state.ARRIVED_NOTHING_SENT
import com.clave.core.state.LAST_MACHINE_KEY
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

/** The prefix the evidence and flow tests clean up, so an interrupted run of this one is cleaned too. */
private const val WIRING_STAND_IN = "Stand-in "

private const val WIRING_WAIT_MS = 15_000L

private const val WIRING_PACKAGE = "com.clave.app.android.debug"

/** No last machine to open on and no stand-in left by an interrupted run. */
private class WiringCleanStart : ExternalResource() {
    override fun before() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        val owner = withTimeout(WIRING_WAIT_MS) { app.restoredOwner() }
        owner.kv.remove(LAST_MACHINE_KEY)
        owner.store.loadMachines()
        for (machine in owner.store.state.value.machines) {
            if (machine.id.startsWith("dev:") && machine.name.startsWith(WIRING_STAND_IN)) owner.store.removeDeveloperMachine(machine.id)
        }
    }
}

/**
 * The app's side of the delivery ledger, on the device against the stand-in machine: what the core
 * finishes and says reaches the screen through the owner session and the chat session, not only
 * through the core's own tests.
 *
 * - The owner session finishes, when it opens and before any screen reads the stores, a send's end
 *   that a previous process recorded and did not finish (OwnerSession.open).
 * - The chat session re-reads the delivery state when a settled send's entry leaves the ledger, the
 *   last write of its settle, so the "Delivery unknown" card goes then (ChatSession's subscription).
 * - A files-only send refused keeps its file in the composer, to be sent again.
 * - A Send again answered "it had arrived" keeps an edit made since, which was never sent.
 *
 * Every machine added here is a stand-in on the loopback; its conversation's ledger entries, mark,
 * draft and attachment draft are cleared before and after each test.
 */
@RunWith(AndroidJUnit4::class)
class DeliveryWiringTest {
    private val rule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(WiringCleanStart()).around(rule)

    private lateinit var server: FakeMachineServer
    private var machineId: String? = null

    private val nonce = Integer.toHexString((System.nanoTime() and 0xffffff).toInt())
    private val machineName = "${WIRING_STAND_IN}wiring $nonce"

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = services(instrumentation.targetContext)

    @Before
    fun startServer() {
        server = FakeMachineServer(TOKEN)
    }

    @After
    fun cleanUp() {
        try {
            runBlocking {
                val id = machineId ?: return@runBlocking
                val owner = owner()
                clearConversation(owner, id)
                owner.store.removeDeveloperMachine(id)
            }
        } finally {
            server.close()
        }
    }

    private suspend fun owner(): OwnerSession = withTimeout(WIRING_WAIT_MS) { app.restoredOwner() }

    private suspend fun addStandIn(): String =
        owner().store.addDeveloperMachine(server.url, TOKEN, machineName).id.also { machineId = it }

    /** Nothing of an earlier run in this conversation: its sends, its mark, its draft, its attachment draft. */
    private suspend fun clearConversation(owner: OwnerSession, machineId: String) {
        val delivery = owner.services.delivery
        for (send in delivery.sends.list()) if (send.machineId == machineId) delivery.sends.remove(send.clientMessageId)
        delivery.marks.clear(machineId, FakeMachineServer.SESSION_ID)
        owner.services.drafts.clear(machineId, FakeMachineServer.SESSION_ID)
        owner.kv.remove(attachmentDraftKey(machineId, FakeMachineServer.SESSION_ID))
    }

    private fun openChat(machineId: String) {
        instrumentation.context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(DeepLink.Chat(machineId, FakeMachineServer.SESSION_ID, "Echo chat").toUri()))
                .setPackage(WIRING_PACKAGE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        rule.waitUntil("the composer on screen", WIRING_WAIT_MS) {
            rule.onAllNodesWithContentDescription("Message").fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
        }
    }

    private fun waitForText(text: String, timeoutMs: Long = WIRING_WAIT_MS) = rule.waitUntil("the text \"$text\" on screen", timeoutMs) {
        rule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
    }

    private fun waitForNoText(text: String, timeoutMs: Long = WIRING_WAIT_MS) = rule.waitUntil("the text \"$text\" gone", timeoutMs) {
        rule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes(atLeastOneRootRequired = false).isEmpty()
    }

    private fun shown(text: String): Boolean = rule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()

    private fun screen(): String = rule.onRoot(useUnmergedTree = true).printToString()

    private fun SemanticsNodeInteraction.editableText(): String? =
        fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    private fun composerText(): String? = rule.onNodeWithContentDescription("Message").editableText()

    private fun writes() = server.requests.filter { it.method == "POST" && it.path == "/sessions/write" }

    @Test
    fun aSendEndRecordedEarlierIsFinishedWhenTheOwnerSessionOpensBeforeTheChatReadsIt() = runBlocking {
        val machineId = addStandIn()
        val before = owner()
        clearConversation(before, machineId)
        // As a process leaves the stores when it ends after a send's Sent end record, before its cleanup.
        val delivery = before.services.delivery
        delivery.sends.add(UnknownSend(machineId, FakeMachineServer.SESSION_ID, ENDED_ID, DELIVERED, 1, draftText = DELIVERED))
        assertTrue("the end is recorded", delivery.sends.markEnded(ENDED_ID, SendEnd(SendEnd.Kind.Sent, at = 2)) != null)
        delivery.marks.set(machineId, FakeMachineServer.SESSION_ID, DeliveryMark(DeliveryMark.Kind.Unknown, ENDED_ID, UNCONFIRMED, 1))
        before.services.drafts.set(machineId, FakeMachineServer.SESSION_ID, DELIVERED)
        // No pass can run: the push stays down, so only the owner session's own start may finish it.
        server.pushDown = true
        app.rebuildAuth()
        assertNotSame("a new owner session over the same stores", before, owner())
        openChat(machineId)
        SystemClock.sleep(2_000)
        rule.waitForIdle()
        assertTrue("no Delivery unknown card for a send that had ended: ${screen()}", !shown("Delivery unknown"))
        assertTrue("no stale notice: ${screen()}", !shown(UNCONFIRMED))
        assertEquals("the delivered text is not in the composer", "", composerText())
        assertEquals("nothing reached the machine's write route", 0, writes().size)
    }

    @Test
    fun theCardGoesWhenAPassSettlesTheSendWhileTheChatIsOpen() = runBlocking {
        val machineId = addStandIn()
        val owner = owner()
        clearConversation(owner, machineId)
        // A send of unknown outcome and no mark (a begin whose mark write was refused): only the ledger says it waits.
        owner.services.delivery.sends.add(UnknownSend(machineId, FakeMachineServer.SESSION_ID, WAITING_ID, KEPT, 1, draftText = KEPT))
        owner.services.drafts.set(machineId, FakeMachineServer.SESSION_ID, KEPT)
        server.accept(WAITING_ID)
        server.holdStatusOf(WAITING_ID)
        openChat(machineId)
        waitForText("Delivery unknown")
        assertTrue("the pass asks the machine about the send", server.statusHeld(45_000))
        // The machine says it arrived: the pass ends it, with no mark to clear, its entry leaving the ledger last.
        server.releaseStatus()
        waitForNoText("Delivery unknown")
        rule.waitUntil("the delivered text out of the composer", WIRING_WAIT_MS) { composerText() == "" }
        assertEquals("nothing written: the machine had it", 0, writes().size)
    }

    @Test
    fun aFilesOnlySendRefusedKeepsItsFileInTheComposer() = runBlocking {
        val machineId = addStandIn()
        val owner = owner()
        clearConversation(owner, machineId)
        owner.kv.set(attachmentDraftKey(machineId, FakeMachineServer.SESSION_ID), AttachmentJson.encodeList(listOf(DOC)))
        openChat(machineId)
        waitForText("Hello back.")
        waitForText(CHIP)
        server.refuseWritesWith = 403
        rule.onNodeWithContentDescription("Message").performClick()
        rule.tapSendAtRest(WIRING_WAIT_MS)
        waitForText(REFUSED)
        SystemClock.sleep(1_000)
        rule.waitForIdle()
        assertEquals("the refused send is one write", 1, writes().size)
        assertTrue("the refused file stays in the composer, to send again: ${screen()}", shown(CHIP))
        assertEquals("and in the stored attachment draft", AttachmentJson.encodeList(listOf(DOC)), owner.kv.get(attachmentDraftKey(machineId, FakeMachineServer.SESSION_ID)))
    }

    @Test
    fun aSendAgainAnsweredItHadArrivedKeepsAnEditMadeSince() = runBlocking {
        val machineId = addStandIn()
        val owner = owner()
        clearConversation(owner, machineId)
        openChat(machineId)
        waitForText("Hello back.")
        rule.waitUntil("the chat subscribed", WIRING_WAIT_MS) { server.subscribers > 0 }
        server.failWrites = true
        rule.onNodeWithContentDescription("Message").performTextInput(FIRST)
        rule.tapSendAtRest(WIRING_WAIT_MS)
        waitForText("Delivery unknown", timeoutMs = 75_000)
        val first = JSONObject(writes().single().body).getJSONObject("input").getString("clientMessageId")
        // The person goes on writing: this text has never been sent.
        rule.onNodeWithContentDescription("Message").performTextReplacement(EDITED)
        // The first write arrived after all; the pass hears it while the person picks Send again.
        server.failWrites = false
        server.accept(first)
        server.holdStatusOf(first)
        server.dropPush()
        assertTrue("the pass asks about the first send", server.statusHeld(45_000))
        rule.onNodeWithText("Send again (may duplicate)").performClick()
        SystemClock.sleep(500)
        server.releaseStatus()
        waitForText(ARRIVED_NOTHING_SENT)
        rule.waitForIdle()
        assertEquals("the edit made since was never sent, and stays: ${screen()}", EDITED, composerText())
        assertEquals("nothing more was written", 1, writes().size)
    }

    private companion object {
        const val TOKEN = "test-token"
        const val ENDED_ID = "m-0000000000000000000000a1"
        const val WAITING_ID = "m-0000000000000000000000b1"
        const val DELIVERED = "this one was delivered"
        const val KEPT = "kept while unknown"
        const val FIRST = "first"
        const val EDITED = "first, then edited"
        const val UNCONFIRMED = "Delivery has not been confirmed."
        const val REFUSED = "This device may not write to that session."
        const val CHIP = "File notes.txt"
        val DOC = FileAttachment(
            id = "f-doc", path = "/tmp/scratch/notes.txt", name = "notes.txt", mimeType = "text/plain", size = 3,
            delivery = FileDelivery.Reference,
        )
    }
}
