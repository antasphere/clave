package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A same-id completion the machine refused with a declared 422 refuses that write alone. The write
 * route's declared failures are SessionNotFound, SessionWriteRefused and SessionWriteUnknown
 * (packages/contract/src/sessions.ts:531, decoded by their `_tag`, Decode.serverFailure). The send
 * whose first answer was lost may still arrive, so it stays unknown, held from any further
 * completion in this process and the next, and the person decides; a status read answering accepted
 * or rejected still settles it, rejected through its recorded end.
 *
 * Scope as in SettleRecordedEndTest: a fresh controller and store over the same stores, not an OS
 * restart and not a power loss.
 */
class CompletionRefusalTest {
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

    private fun Harness.routes(write: (Call) -> MockResponse, status: (id: String, Call) -> MockResponse) {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> write(call)
                "/sessions/writes" -> {
                    val asked = call.query["clientMessageId"] ?: ""
                    if (asked == KEEPER) answer(200, ACCEPTED) else status(asked, call)
                }
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
    }

    private fun Harness.writtenIds(): List<String> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map {
        json(it.body).jsonObject["input"]!!.jsonObject["clientMessageId"]!!.jsonPrimitive.content
    }

    /** The first send's answer is lost and its status cannot be asked: unknown, its entry and mark stay. */
    private suspend fun Harness.lostSend() {
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(504, "{}") })
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        assertTrue("the first send ends unknown: $outcome", outcome is SendOutcome.Unknown)
        assertEquals(probed, outcome.clientMessageId)
    }

    /** The push channel opens again (or for the first time), which runs a pass; returns once it settled a keeper placed last. */
    private suspend fun Harness.pass() {
        sends.add(UnknownSend(machineId, "s9", KEEPER, "keeper", clock.nowMs))
        machine.welcome = true
        machine.closePeers()
        store.connect(machineId)
        until(60_000, what = "the pass") { runBlocking { sends.list().none { it.clientMessageId == KEEPER } } }
    }

    private fun Harness.processEnds() {
        store.disconnectAll()
        scope.cancel()
        http.connectionPool.evictAll()
    }

    private fun Harness.overSameStores(): Harness =
        Harness(machine = machine, mint = { id(minted.incrementAndGet()) }, kv = kv, ownsMachine = false)

    /** A lost send, then a pass that hears `absent` and sends the completion, refused with a declared 422 [tag]. */
    private suspend fun Harness.completionRefusedWith(tag: String) {
        lostSend()
        routes(write = { answer(422, """{"_tag":"$tag","message":"Not accepted."}""") }, status = { _, _ -> answer(200, ABSENT) })
        pass()
        assertEquals("the lost write, then the completion the machine refused", listOf(probed, probed), writtenIds())
        val entry = sends.list().singleOrNull { it.sessionId == S1 }
        assertNotNull("the earlier send stays in the ledger: a refused completion proves nothing of it", entry)
        assertTrue("held from any further completion", entry!!.completionRefused)
        assertFalse("not ended", entry.decided)
        assertEquals("still unknown, never rejected", DeliveryMark.Kind.Unknown, marks.get(machineId, S1)?.kind)
        assertEquals(TEXT, drafts.get(machineId, S1))
    }

    private fun neverWrittenAgain(tag: String) = guarded {
        completionRefusedWith(tag)
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
        pass()
        assertEquals("the next pass of this process sends nothing", listOf(probed, probed), writtenIds())
        processEnds()
        val next = overSameStores()
        try {
            next.start()
            assertEquals("the card and its choice", probed, next.delivery!!.unsettled(machineId, S1)?.clientMessageId)
            assertEquals(DeliveryMark.Kind.Unknown, next.marks.get(machineId, S1)?.kind)
            assertEquals("no plain send meanwhile", SendOutcome.Failed(probed, DELIVERY_UNKNOWN_FIRST), next.store.send(machineId, S1, TEXT))
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
            next.pass()
            assertEquals("never written again after the restart", listOf(probed, probed), writtenIds())
            assertEquals(listOf(probed), next.sends.list().map { it.clientMessageId })
        } finally {
            next.close()
        }
    }

    @Test
    fun `Q1 a completion refused with a 422 SessionWriteRefused stays unknown and is never written again, in this process or after a restart`() =
        neverWrittenAgain("SessionWriteRefused")

    @Test
    fun `Q2 a completion refused with a 422 SessionNotFound stays unknown and is never written again, in this process or after a restart`() =
        neverWrittenAgain("SessionNotFound")

    @Test
    fun `Q3 a completion refused with a 422, the process ends, and the next controller hears the late first write accepted, settled delivered with no Rejected mark`() = guarded {
        completionRefusedWith("SessionWriteRefused")
        processEnds()
        val writes = writtenIds().size
        val next = overSameStores()
        try {
            next.start()
            next.routes(write = { answer(200, ACCEPTED) }, status = { asked, call -> if (asked == probed) machine.hold(call) else answer(200, ACCEPTED) })
            machine.welcome = true
            next.store.connect(machineId)
            until(60_000, what = "the next controller's pass to ask about the send") { machine.held.size == 1 }
            assertEquals("before the answer, the card and its choice", probed, next.delivery!!.unsettled(machineId, S1)?.clientMessageId)
            assertEquals(DeliveryMark.Kind.Unknown, next.marks.get(machineId, S1)?.kind)
            assertEquals("no write meanwhile", writes, writtenIds().size)
            // The first write, held somewhere, arrived after all.
            machine.respond(0, answer(200, ACCEPTED))
            until(60_000, what = "the send to settle") { runBlocking { next.sends.list().isEmpty() } }
            assertNull("delivered: no notice, and no Rejected one", next.marks.get(machineId, S1))
            assertNull(next.delivery.unsettled(machineId, S1))
            assertEquals("the delivered draft goes", "", next.drafts.get(machineId, S1))
            assertNull("its files go", next.kv.get(attachmentDraftKey(machineId, S1)))
            assertEquals("no completion and no duplicate", writes, writtenIds().size)
        } finally {
            next.close()
        }
    }

    @Test
    fun `Q4 after a completion refused with a 422, a status read answering rejected is authoritative and ends the send Rejected`() = guarded {
        completionRefusedWith("SessionWriteRefused")
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
        pass()
        assertEquals("ended: out of the ledger", listOf<String>(), sends.list().filter { it.sessionId == S1 }.map { it.clientMessageId })
        val mark = marks.get(machineId, S1)
        assertEquals(DeliveryMark.Kind.Rejected, mark?.kind)
        assertEquals(probed, mark?.clientMessageId)
        assertEquals("the status read's own reason", "The session is closed.", mark?.reason)
        assertEquals("the draft stays", TEXT, drafts.get(machineId, S1))
        assertEquals("its files stay", AttachmentJson.encodeList(listOf(file)), kv.get(attachmentDraftKey(machineId, S1)))
        assertEquals("nothing more written", listOf(probed, probed), writtenIds())
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val KEEPER = "m-ffffffffffffffffffffffff"
        const val ACCEPTED = """{"status":"accepted"}"""
        const val ABSENT = """{"status":"absent"}"""
    }
}
