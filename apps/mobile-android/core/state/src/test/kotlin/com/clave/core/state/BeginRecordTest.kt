package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.chat.deliveryMarkKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A send's begin, before its write leaves: the ledger entry, then its mark. When the store refuses
 * the mark's write, the person is never told "Nothing was sent" while an entry remains that a pass
 * can send: the entry is taken out again first and the sentence is said only once the ledger holds
 * none of it; when that undoing is refused too and the entry stays, the answer is unknown, with its
 * card. The store stand-in throws on the writes each case names, as a disk refusing them would.
 */
class BeginRecordTest {
    private val minted = AtomicInteger()

    private fun id(n: Int) = "m-%024x".format(n)

    private val probed: String get() = id(1)

    private val file = FileAttachment(
        id = "f-1", label = "Image #1", path = "/tmp/p.png", name = "p.png", mimeType = "image/png", size = 3,
        delivery = FileDelivery.Image,
    )

    private fun guarded(block: suspend Harness.() -> Unit) {
        val h = Harness(mint = { id(minted.incrementAndGet()) })
        h.machine.welcome = false
        try {
            runBlocking { h.start().block() }
        } finally {
            h.close()
        }
    }

    /** The machine accepts every write; asked about any send but the keeper it answers `absent`, so a pass would complete it. */
    private fun Harness.routes() {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> answer(200, ACCEPTED)
                "/sessions/writes" -> if (call.query["clientMessageId"] == KEEPER) answer(200, ACCEPTED) else answer(200, """{"status":"absent"}""")
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
    }

    private fun Harness.writtenIds(): List<String> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map {
        json(it.body).jsonObject["input"]!!.jsonObject["clientMessageId"]!!.jsonPrimitive.content
    }

    private fun Harness.askedIds(): List<String> = machine.calls.filter { it.path == "/sessions/writes" }.map { it.query["clientMessageId"] ?: "" }

    private suspend fun Harness.composerHolds() {
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
    }

    private suspend fun Harness.pass() {
        sends.add(UnknownSend(machineId, "s9", KEEPER, "keeper", clock.nowMs))
        machine.welcome = true
        machine.closePeers()
        store.connect(machineId)
        until(60_000, what = "the pass") { runBlocking { sends.list().none { it.clientMessageId == KEEPER } } }
    }

    private fun refused(): Nothing = throw IOException("The disk refused the write.")

    @Test
    fun `P1 the begin's mark write refused, its entry is taken out again, the person is told nothing was sent, and no pass sends it`() = guarded {
        routes()
        composerHolds()
        val markKey = deliveryMarkKey(machineId, S1)
        kv.beforeWrite = { key, _ -> if (key == markKey) refused() }
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        kv.beforeWrite = null
        assertEquals(SendOutcome.Failed(probed, NOTHING_SENT), outcome)
        assertEquals("no entry is left that a pass could send", listOf<String>(), sends.list().map { it.clientMessageId })
        assertEquals("nothing left the phone", listOf<String>(), writtenIds())
        assertNull(marks.get(machineId, S1))
        assertEquals("the draft stays", TEXT, drafts.get(machineId, S1))
        pass()
        assertEquals("and no pass sends it", listOf<String>(), writtenIds())
        assertEquals("nor asks about it", listOf<String>(), askedIds().filter { it == probed })
        assertEquals("the person's next send is a plain one", SendOutcome.Sent(id(2), reconciled = false), store.send(machineId, S1, TEXT))
    }

    @Test
    fun `P2 the begin's mark write and its undoing both refused, the entry stays, so the person is told unknown, never that nothing was sent, and a pass may send it`() = guarded {
        routes()
        composerHolds()
        val markKey = deliveryMarkKey(machineId, S1)
        val quoted = "\"$probed\""
        kv.beforeWrite = { key, value ->
            if (key == markKey) refused()
            // The undoing: a ledger write that would take the entry out again.
            if (key == UNKNOWN_SENDS_KEY && kv.map[key]?.contains(quoted) == true && !value.contains(quoted)) refused()
        }
        kv.beforeRemove = { key -> if (key == UNKNOWN_SENDS_KEY) refused() }
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        kv.beforeWrite = null
        kv.beforeRemove = null
        assertEquals("the entry stays", listOf(probed), sends.list().map { it.clientMessageId })
        assertTrue("never told nothing was sent while a pass can send it: $outcome", outcome is SendOutcome.Unknown && outcome.clientMessageId == probed)
        assertEquals("the card and its choice", probed, delivery!!.unsettled(machineId, S1)?.clientMessageId)
        assertEquals("no plain send meanwhile", SendOutcome.Failed(probed, DELIVERY_UNKNOWN_FIRST), store.send(machineId, S1, TEXT))
        assertEquals("nothing left the phone yet", listOf<String>(), writtenIds())
        assertEquals(TEXT, drafts.get(machineId, S1))
        pass()
        assertEquals("a pass sends it, under its own id: why the answer had to be unknown", listOf(probed), writtenIds())
        assertEquals(listOf<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `P3 the begin's ledger write itself refused, and its undoing too, nothing was kept, so the person is told nothing was sent`() = guarded {
        routes()
        composerHolds()
        kv.beforeWrite = { key, _ -> if (key == UNKNOWN_SENDS_KEY) refused() }
        kv.beforeRemove = { key -> if (key == UNKNOWN_SENDS_KEY) refused() }
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        kv.beforeWrite = null
        kv.beforeRemove = null
        assertEquals(SendOutcome.Failed(probed, NOTHING_SENT), outcome)
        assertEquals(listOf<String>(), sends.list().map { it.clientMessageId })
        assertEquals(listOf<String>(), writtenIds())
        assertEquals(TEXT, drafts.get(machineId, S1))
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val KEEPER = "m-ffffffffffffffffffffffff"
        const val ACCEPTED = """{"status":"accepted"}"""
        const val NOTHING_SENT = "The send could not be saved safely. Nothing was sent."
    }
}
