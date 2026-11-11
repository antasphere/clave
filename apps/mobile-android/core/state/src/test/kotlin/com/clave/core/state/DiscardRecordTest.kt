package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.chat.deliveryMarkKey
import com.clave.core.chat.draftKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The person's Discard, ledger-backed: its entry records the choice (Discard, not Send again), and
 * before that anchor is dropped its cleanup takes out of the composer's stores what the discarded
 * message carried: the draft while it is still that text, that message's files; an edit and a file
 * added since stay. A Send again's record keeps the drafts: its text is being sent anew. A process
 * that ends after the record finds the next controller finishing it at its start, with no call to the
 * machine. Scope as in SettleRecordedEndTest: a fresh controller and store over the same stores.
 */
class DiscardRecordTest {
    private val minted = AtomicInteger()

    private fun id(n: Int) = "m-%024x".format(n)

    private val probed: String get() = id(1)

    private val file = FileAttachment(
        id = "f-1", label = "Image #1", path = "/tmp/p.png", name = "p.png", mimeType = "image/png", size = 3,
        delivery = FileDelivery.Image,
    )

    private val added = file.copy(id = "f-2", label = "Image #2", path = "/tmp/q.png", name = "q.png")

    private fun guarded(block: suspend Harness.() -> Unit) {
        val h = Harness(mint = { id(minted.incrementAndGet()) })
        h.machine.welcome = false
        try {
            runBlocking { h.start().block() }
        } finally {
            h.close()
        }
    }

    private fun Harness.routes(status: String = ABSENT) {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> answer(200, ACCEPTED)
                "/sessions/writes" -> if (call.query["clientMessageId"] == KEEPER) answer(200, ACCEPTED) else answer(200, status)
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
    }

    private fun Harness.writtenIds(): List<String> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map {
        json(it.body).jsonObject["input"]!!.jsonObject["clientMessageId"]!!.jsonPrimitive.content
    }

    private fun Harness.askedIds(): List<String> = machine.calls.filter { it.path == "/sessions/writes" }.map { it.query["clientMessageId"] ?: "" }

    /** The first send's answer is lost and its status cannot be asked: unknown, its entry and mark stay. */
    private suspend fun Harness.lostSend() {
        machine.handler = { call -> if (call.path == "/sessions/write" || call.path == "/sessions/writes") answer(504, "{}") else answer(200, """{"revision":1,"pending":[]}""") }
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        assertTrue("the first send ends unknown: $outcome", outcome is SendOutcome.Unknown)
        assertEquals(probed, outcome.clientMessageId)
    }

    private suspend fun Harness.keeper() = sends.add(UnknownSend(machineId, "s9", KEEPER, "keeper", clock.nowMs))

    private suspend fun Harness.pass() {
        keeper()
        machine.welcome = true
        machine.closePeers()
        store.connect(machineId)
        until(60_000, what = "the pass") { runBlocking { sends.list().none { it.clientMessageId == KEEPER } } }
    }

    /**
     * The process ends once the discard is recorded in the probed entry: at the first write after it
     * of the conversation's draft, attachment draft or mark, or of the ledger taking the entry out.
     * That write never lands ([landRemoval] false); or, [landRemoval] true, the ledger's removal of the
     * entry lands and the process ends right after it. Either way the writer waits for ever.
     */
    private class EndAfterTheRecord(private val kv: SyncKv, private val id: String, private val conversationKeys: Set<String>, private val landRemoval: Boolean) {
        val left = CompletableDeferred<Map<String, String>>()
        private val never = CompletableDeferred<Unit>()

        private fun recorded(): Boolean = kv.map[UNKNOWN_SENDS_KEY]?.let { raw ->
            (json(raw) as JsonArray).any {
                val o = it.jsonObject
                o["clientMessageId"]?.jsonPrimitive?.content == id && (o["discarded"] as? JsonPrimitive)?.booleanOrNull == true
            }
        } == true

        private suspend fun hold(key: String, value: String?) {
            if (left.isCompleted || !recorded()) return
            val removal = key == UNKNOWN_SENDS_KEY && (value == null || !value.contains("\"$id\""))
            if (landRemoval) {
                if (!removal) return
                if (value == null) kv.map.remove(key) else kv.map[key] = value
            } else if (key !in conversationKeys && !removal) {
                return
            }
            left.complete(storesOf(kv))
            withContext(NonCancellable) { never.await() }
        }

        fun arm() {
            kv.beforeWrite = { key, value -> hold(key, value) }
            kv.beforeRemove = { key -> hold(key, null) }
        }
    }

    private fun Harness.endAfterTheRecord(landRemoval: Boolean = false) = EndAfterTheRecord(
        kv, probed, setOf(draftKey(machineId, S1), attachmentDraftKey(machineId, S1), deliveryMarkKey(machineId, S1)), landRemoval,
    ).also { it.arm() }

    private suspend fun Harness.endsHere(end: EndAfterTheRecord, what: String): Map<String, String> {
        val left = awaitGate("the crash point: $what", end.left, 60_000)
        kv.beforeWrite = null
        kv.beforeRemove = null
        store.disconnectAll()
        scope.cancel()
        http.connectionPool.evictAll()
        delay(500)
        assertEquals("nothing of the ended process wrote after its end", left, storesOf(kv))
        return left
    }

    private fun Harness.overSameStores(): Harness =
        Harness(machine = machine, mint = { id(minted.incrementAndGet()) }, kv = kv, ownsMachine = false)

    private data class Seen(val inLedger: Boolean, val draft: String, val files: String?, val mark: DeliveryMark?)

    /** The next controller's start alone (no call to the machine), then [expect] on what it left of the conversation. */
    private suspend fun Harness.nextStart(expect: suspend Harness.(Seen) -> Unit) {
        val calls = machine.calls.size
        val next = overSameStores()
        try {
            next.start()
            assertEquals("the start calls nothing on the machine", calls, machine.calls.size)
            val seen = Seen(
                inLedger = next.sends.list().any { it.clientMessageId == probed },
                draft = next.drafts.get(machineId, S1),
                files = next.kv.get(attachmentDraftKey(machineId, S1)),
                mark = next.marks.get(machineId, S1),
            )
            assertFalse("the discarded send left the ledger at the start", seen.inLedger)
            assertNull("its mark went", seen.mark)
            next.expect(seen)
        } finally {
            next.close()
        }
    }

    @Test
    fun `DD1 a Discard, the process ends right after its record, and the next start takes the discarded text and file out, so nothing of it is one tap away`() = guarded {
        lostSend()
        keeper()
        val end = endAfterTheRecord()
        val discard = scope.async { store.discardUnknown(machineId, S1, probed) }
        endsHere(end, "the first write after the Discard's record")
        assertFalse(discard.isCompleted)
        val writes = writtenIds().size
        nextStart { seen ->
            assertEquals("the discarded text left the draft", "", seen.draft)
            assertNull("the discarded file left the attachment draft", seen.files)
            routes()
            pass()
            assertEquals("never asked about again", listOf<String>(), askedIds().filter { it == probed }.drop(1))
            assertEquals(
                "a plain send of what the composer holds sends nothing of the discarded message",
                "Nothing to send.",
                (store.send(machineId, S1, drafts.get(machineId, S1)) as SendOutcome.Failed).reason,
            )
            assertEquals(writes, writtenIds().size)
        }
    }

    @Test
    fun `DD2 a Discard with the draft edited and a file added since, the process ends right after its record, and the next start keeps the edit and the new file`() = guarded {
        lostSend()
        drafts.set(machineId, S1, "edited since")
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file, added)))
        keeper()
        val end = endAfterTheRecord()
        scope.async { store.discardUnknown(machineId, S1, probed) }
        endsHere(end, "the first write after the Discard's record")
        nextStart { seen ->
            assertEquals("the person's newer text stays", "edited since", seen.draft)
            assertEquals("only the discarded message's file goes", AttachmentJson.encodeList(listOf(added)), seen.files)
        }
    }

    @Test
    fun `DD3 a Send again, the process ends right after its record, and the next start keeps the text and file being sent anew`() = guarded {
        lostSend()
        keeper()
        routes()
        val end = endAfterTheRecord()
        scope.async { store.resend(machineId, S1, probed, TEXT, listOf(file)) }
        endsHere(end, "the first write after the Send again's record")
        assertEquals("the new id never left", listOf(probed), writtenIds())
        nextStart { seen ->
            assertEquals("the text the person chose to send again stays", TEXT, seen.draft)
            assertEquals("and its file", AttachmentJson.encodeList(listOf(file)), seen.files)
        }
    }

    @Test
    fun `DD4 a discard an older build recorded, without saying Discard or Send again, keeps the drafts as they are`() = guarded {
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
        // As the build before this one wrote a discard: the flag alone.
        kv.set(
            UNKNOWN_SENDS_KEY,
            """[{"machineId":"$machineId","sessionId":"$S1","clientMessageId":"$probed","text":"$TEXT","at":1,"draftText":"$TEXT",""" +
                """"attachments":[${AttachmentJson.encode(file)}],"discarded":true}]""",
        )
        marks.set(machineId, S1, DeliveryMark(DeliveryMark.Kind.Unknown, probed, "Delivery has not been confirmed.", 1))
        nextStart { seen ->
            assertEquals("it may have been a Send again: the text stays", TEXT, seen.draft)
            assertEquals(AttachmentJson.encodeList(listOf(file)), seen.files)
        }
    }

    @Test
    fun `DD5 a Discard with no interruption takes out of the stores only what the discarded message carried`() = guarded {
        lostSend()
        drafts.set(machineId, S1, "edited since")
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file, added)))
        assertEquals(DeliveryController.DiscardResult.Discarded, store.discardUnknown(machineId, S1, probed))
        assertEquals(listOf<String>(), sends.list().map { it.clientMessageId })
        assertNull(marks.get(machineId, S1))
        assertEquals("the newer text stays", "edited since", kv.get(draftKey(machineId, S1)))
        assertEquals("only the discarded file goes", AttachmentJson.encodeList(listOf(added)), kv.get(attachmentDraftKey(machineId, S1)))
    }

    @Test
    fun `DD6 a Discard, the process ends right after its entry's removal lands, and the discarded text had already left`() = guarded {
        lostSend()
        keeper()
        val end = endAfterTheRecord(landRemoval = true)
        scope.async { store.discardUnknown(machineId, S1, probed) }
        val left = endsHere(end, "the Discard's entry removal, landed")
        assertNull("the draft's cleanup came before the anchor was dropped", left[draftKey(machineId, S1)])
        assertNull("and the file's", left[attachmentDraftKey(machineId, S1)])
        nextStart { seen ->
            assertEquals("", seen.draft)
            assertNull(seen.files)
        }
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val KEEPER = "m-ffffffffffffffffffffffff"
        const val ACCEPTED = """{"status":"accepted"}"""
        const val ABSENT = """{"status":"absent"}"""
    }
}

/** Every key the stores hold, copied under the map's own lock. */
private fun storesOf(kv: SyncKv): Map<String, String> = synchronized(kv.map) { LinkedHashMap(kv.map) }
