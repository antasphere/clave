package com.clave.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.android.fake.FakeMachineServer
import com.clave.android.ui.ChatSession
import com.clave.core.chat.attachmentDraftKey
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A chat left while its send is out (a recreation: the old chat session closes and a new one
 * opens over the same conversation) never shows the sent text again, in the new composer or in
 * the draft store, however the send's end interleaves with the close and the open. Scratch
 * reviewer test: drives ChatSession directly against the stand-in with each write held.
 */
@RunWith(AndroidJUnit4::class)
class DraftRaceTest {
    private lateinit var server: FakeMachineServer
    private var machineId: String? = null
    private val app get() = services(InstrumentationRegistry.getInstrumentation().targetContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Before fun start() { server = FakeMachineServer("test-token") }

    @After fun stop() {
        runBlocking {
            val owner = withTimeout(15_000) { app.restoredOwner() }
            machineId?.let { id ->
                clear(owner, id)
                owner.store.removeDeveloperMachine(id)
            }
        }
        scope.cancel()
        server.close()
    }

    private suspend fun clear(owner: OwnerSession, id: String) {
        val delivery = owner.services.delivery
        for (send in delivery.sends.list()) if (send.machineId == id) delivery.sends.remove(send.clientMessageId)
        delivery.marks.clear(id, FakeMachineServer.SESSION_ID)
        owner.services.drafts.clear(id, FakeMachineServer.SESSION_ID)
        owner.kv.remove(attachmentDraftKey(id, FakeMachineServer.SESSION_ID))
    }

    private fun chat(owner: OwnerSession, id: String) =
        ChatSession(owner, id, FakeMachineServer.SESSION_ID, app.files, scope, { true }, {})

    private fun writes() = server.requests.count { it.method == "POST" && it.path == "/sessions/write" }

    @Test
    fun aSentTextNeverComesBackAfterTheChatIsLeftMidSend() = runBlocking {
        val owner = withTimeout(15_000) { app.restoredOwner() }
        val id = owner.store.addDeveloperMachine(server.url, "test-token", "Stand-in race").id.also { machineId = it }
        val stale = mutableListOf<String>()
        repeat(24) { i ->
            clear(owner, id)
            val text = "race-$i"
            val hold = CountDownLatch(1)
            server.holdWrites = hold
            val before = writes()
            val a = withContext(Dispatchers.Main) { chat(owner, id).also { it.open() } }
            delay(300)
            withContext(Dispatchers.Main) {
                a.setDraft(text)
                a.send()
            }
            withTimeout(10_000) { while (writes() == before) delay(5) }
            // The write is out: the end lands before, between or after the close and the open.
            val b = when (i % 4) {
                0 -> withContext(Dispatchers.Main) { a.close(); hold.countDown(); chat(owner, id).also { it.open() } }
                1 -> withContext(Dispatchers.Main) { hold.countDown(); a.close(); chat(owner, id).also { it.open() } }
                2 -> withContext(Dispatchers.Main) { a.close(); chat(owner, id).also { it.open(); hold.countDown() } }
                else -> {
                    hold.countDown()
                    delay((i % 7).toLong())
                    withContext(Dispatchers.Main) { a.close(); chat(owner, id).also { it.open() } }
                }
            }
            withTimeout(10_000) { while (a.state.value.sending) delay(10) }
            delay(800)
            val composer = b.state.value.draft
            val stored = owner.services.drafts.get(id, FakeMachineServer.SESSION_ID)
            if (composer.isNotEmpty() || stored.isNotEmpty()) stale += "#$i (case ${i % 4}): composer='$composer' stored='$stored'"
            withContext(Dispatchers.Main) { b.close() }
            server.holdWrites = null
            delay(200)
        }
        android.util.Log.i("VERIFY", "stale=${stale.size}: $stale")
        assertEquals("no sent text comes back: $stale", emptyList<String>(), stale)
    }

    /** Text typed while the send is out is kept when the chat is left, whatever the send's end. */
    @Test
    fun textTypedDuringASendSurvivesLeavingTheChat() = runBlocking {
        val owner = withTimeout(15_000) { app.restoredOwner() }
        val id = owner.store.addDeveloperMachine(server.url, "test-token", "Stand-in typed").id.also { machineId = it }
        clear(owner, id)
        val hold = CountDownLatch(1)
        server.holdWrites = hold
        val before = writes()
        val a = withContext(Dispatchers.Main) { chat(owner, id).also { it.open() } }
        delay(300)
        withContext(Dispatchers.Main) { a.setDraft("first"); a.send() }
        withTimeout(10_000) { while (writes() == before) delay(5) }
        val b = withContext(Dispatchers.Main) {
            a.setDraft("typed while sending")
            a.close()
            hold.countDown()
            chat(owner, id).also { it.open() }
        }
        withTimeout(10_000) { while (a.state.value.sending) delay(10) }
        delay(800)
        assertEquals("typed while sending", owner.services.drafts.get(id, FakeMachineServer.SESSION_ID))
        assertEquals("typed while sending", b.state.value.draft)
        withContext(Dispatchers.Main) { b.close() }
        server.holdWrites = null
    }

    /** A failed send left mid-flight keeps its text as the draft, for the person to send again. */
    @Test
    fun aFailedSendLeftMidFlightKeepsItsText() = runBlocking {
        val owner = withTimeout(15_000) { app.restoredOwner() }
        val id = owner.store.addDeveloperMachine(server.url, "test-token", "Stand-in failed").id.also { machineId = it }
        clear(owner, id)
        val hold = CountDownLatch(1)
        server.holdWrites = hold
        server.refuseWritesWith = 403
        val before = writes()
        val a = withContext(Dispatchers.Main) { chat(owner, id).also { it.open() } }
        delay(300)
        withContext(Dispatchers.Main) { a.setDraft("refused text"); a.send() }
        withTimeout(10_000) { while (writes() == before) delay(5) }
        val b = withContext(Dispatchers.Main) { a.close(); hold.countDown(); chat(owner, id).also { it.open() } }
        withTimeout(10_000) { while (a.state.value.sending) delay(10) }
        delay(800)
        assertEquals("refused text", owner.services.drafts.get(id, FakeMachineServer.SESSION_ID))
        assertEquals("refused text", b.state.value.draft)
        withContext(Dispatchers.Main) { b.close() }
        server.holdWrites = null
        server.refuseWritesWith = null
    }
}
