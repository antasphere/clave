package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import com.clave.core.ports.Clock
import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * controller.test.ts drives the controller through the app store and an HTTP fixture; the
 * store and the client live in other modules here, so each case drives the same sequence
 * the store runs (begin, the write through sendMessage, finish) with the write and status
 * as lambdas, and keeps the TypeScript assertions.
 */
class DeliveryControllerTest {
    private val fixedClock = Clock { 42 }

    private class Env {
        val kv = MemoryKeyValueStore()
        val drafts = Drafts(kv)
        val delivery = DeliveryController(UnknownSends(kv), DeliveryMarks(kv), drafts, kv, Clock { 42 })
    }

    private fun sendOf(id: String) = UnknownSend("m", "s", id, "original bytes", 1, draftText = "  original bytes  ")

    /** The store's send: the ledger first, then the write and its table, then the settlement. */
    private suspend fun Env.send(send: UnknownSend, ports: SendPorts): SendOutcome {
        delivery.begin(send)
        val outcome = sendMessage(send.clientMessageId, ports)
        delivery.finish(send, outcome)
        return outcome
    }

    private fun ports(
        write: suspend (String) -> WriteAnswer,
        status: suspend (String) -> WriteStatus,
        sleep: suspend (Long) -> Unit = {},
    ): SendPorts {
        val writeFn = write
        val statusFn = status
        val sleepFn = sleep
        return object : SendPorts {
            var clock = 0L
            override suspend fun write(clientMessageId: String) = writeFn(clientMessageId)
            override suspend fun status(clientMessageId: String) = statusFn(clientMessageId)
            override suspend fun sleep(ms: Long) { clock += ms; sleepFn(ms) }
            override fun now(): Long = clock
        }
    }

    @Test
    fun `persists original bytes and ID before dispatch and restores the unknown warning after a process restart`() = runTest {
        val env = Env()
        env.drafts.set("m", "s", "  original bytes  ")
        var writes = 0
        val result = env.send(
            sendOf("message-1000"),
            ports(
                write = {
                    writes++
                    val kept = env.delivery.sends.list().single()
                    assertEquals("message-1000", kept.clientMessageId)
                    assertEquals("original bytes", kept.text)
                    assertEquals("  original bytes  ", kept.draftText)
                    // A malformed acknowledgement after a possible accepted write.
                    throw SendFailure(SendFailure.Kind.Protocol, "The server answered something unreadable.", status = 200)
                },
                status = { WriteStatus(WriteStatusKind.Unknown) },
            ),
        )
        assertTrue(result is SendOutcome.Unknown)
        assertEquals(1, writes)
        val restored = DeliveryController(UnknownSends(env.kv), DeliveryMarks(env.kv), Drafts(env.kv), env.kv, fixedClock)
        assertEquals(1, restored.sends.list().size)
        val mark = restored.marks.get("m", "s")!!
        assertEquals(DeliveryMark.Kind.Unknown, mark.kind)
        assertEquals("message-1000", mark.clientMessageId)
        assertEquals("  original bytes  ", Drafts(env.kv).get("m", "s"))
    }

    @Test
    fun `a pending 200 never clears the draft or tracking until status proves acceptance`() = runTest {
        val env = Env()
        env.drafts.set("m", "s", "  original bytes  ")
        var accepted = false
        val firstWait = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        val sending = async {
            env.send(
                sendOf("message-1001"),
                ports(
                    write = { WriteAnswer(WriteAnswerStatus.Pending) },
                    status = { WriteStatus(if (accepted) WriteStatusKind.Accepted else WriteStatusKind.Pending) },
                    sleep = { firstWait.complete(Unit); proceed.await() },
                ),
            )
        }
        firstWait.await()
        assertFalse(sending.isCompleted)
        assertEquals("  original bytes  ", env.drafts.get("m", "s"))
        assertEquals(1, env.delivery.sends.list().size)
        accepted = true
        proceed.complete(Unit)
        assertTrue(sending.await() is SendOutcome.Sent)
        assertEquals("", env.drafts.get("m", "s"))
        assertEquals(emptyList<UnknownSend>(), env.delivery.sends.list())
    }

    @Test
    fun `a reconnect queries unknown sends and preserves edits, without sending an ordinary offline draft`() = runTest {
        val env = Env()
        env.drafts.set("m", "s", "  original bytes  ")
        env.send(
            sendOf("message-1002"),
            ports(
                write = { throw SendFailure(SendFailure.Kind.Protocol, "unreadable", status = 200) },
                status = { WriteStatus(WriteStatusKind.Unknown) },
            ),
        )
        env.drafts.set("m", "s", "edited after dispatch")
        env.drafts.set("m", "plain", "unsent offline draft")
        var writes = 0
        val refreshes = mutableListOf<String>()
        env.delivery.reconnect(
            machineId = "m",
            openConversations = listOf("s"),
            write = { writes++; WriteAnswer(WriteAnswerStatus.Accepted) },
            status = { WriteStatus(WriteStatusKind.Accepted) },
            refreshRequests = { refreshes.add("requests") },
            refreshHistory = { _, _ -> refreshes.add("history") },
        )
        assertEquals(0, writes)
        assertEquals("edited after dispatch", env.drafts.get("m", "s"))
        assertEquals("unsent offline draft", env.drafts.get("m", "plain"))
        assertNull(env.delivery.marks.get("m", "s"))
        assertEquals(listOf("requests", "history"), refreshes)
    }

    // Beyond the TypeScript suite: the one-pass-per-machine rule, the in-flight send left
    // alone, and the attachment draft cleared only when it is still the records sent.

    @Test
    fun `a second reconnect of one machine joins the pass under way`() = runTest {
        val env = Env()
        env.delivery.sends.add(sendOf("message-2000"))
        val asked = CompletableDeferred<Unit>()
        val answer = CompletableDeferred<WriteStatus>()
        var asks = 0
        var passes = 0
        suspend fun reconnect() = env.delivery.reconnect(
            "m", emptyList(),
            write = { error("never written") },
            status = { asks++; asked.complete(Unit); answer.await() },
            refreshRequests = { passes++ },
            refreshHistory = { _, _ -> },
        )
        val first = async { reconnect() }
        asked.await()
        val second = async { reconnect() }
        answer.complete(WriteStatus(WriteStatusKind.Unknown))
        assertSame(first.await(), second.await())
        assertEquals(1, asks)
        assertEquals(1, passes)
        reconnect()
        assertEquals(2, passes)
    }

    @Test
    fun `a send still in flight is left to its sender by the pass`() = runTest {
        val env = Env()
        val inFlight = sendOf("message-3000")
        env.delivery.begin(inFlight)
        var asks = 0
        val report = env.delivery.reconnect(
            "m", emptyList(),
            write = { error("never written") },
            status = { asks++; WriteStatus(WriteStatusKind.Accepted) },
            refreshRequests = {},
            refreshHistory = { _, _ -> },
        )
        assertEquals(0, asks)
        assertTrue(report.outcomes.isEmpty())
        env.delivery.finish(inFlight, SendOutcome.Failed(inFlight.clientMessageId, "token refused"))
        assertEquals(emptyList<UnknownSend>(), env.delivery.sends.list())
        assertNull(env.delivery.marks.get("m", "s"))
    }

    @Test
    fun `a sent message clears its attachment draft only when it is still the records sent`() = runTest {
        val env = Env()
        val record = com.clave.core.contract.FileAttachment(
            id = "f-1", label = "Image #1", path = "/p.png", name = "p.png", mimeType = "image/png", size = 3,
            delivery = com.clave.core.contract.FileDelivery.Image,
        )
        val withFile = sendOf("message-4000").copy(attachments = listOf(record))
        env.kv.set(attachmentDraftKey("m", "s"), AttachmentJson.encodeList(listOf(record)))
        env.delivery.begin(withFile)
        env.delivery.finish(withFile, SendOutcome.Sent(withFile.clientMessageId, reconciled = false))
        assertNull(env.kv.get(attachmentDraftKey("m", "s")))
        val other = sendOf("message-4001").copy(attachments = listOf(record))
        env.kv.set(attachmentDraftKey("m", "s"), "[]")
        env.delivery.begin(other)
        env.delivery.finish(other, SendOutcome.Sent(other.clientMessageId, reconciled = false))
        assertEquals("[]", env.kv.get(attachmentDraftKey("m", "s")))
    }

    @Test
    fun `a sent message's records leave its attachment draft and a file added since stays`() = runTest {
        val env = Env()
        val record = com.clave.core.contract.FileAttachment(
            id = "f-1", label = "Image #1", path = "/p.png", name = "p.png", mimeType = "image/png", size = 3,
            delivery = com.clave.core.contract.FileDelivery.Image,
        )
        val added = record.copy(id = "f-2", label = "Image #2", path = "/q.png", name = "q.png")
        val withFile = sendOf("message-4100").copy(attachments = listOf(record))
        env.kv.set(attachmentDraftKey("m", "s"), AttachmentJson.encodeList(listOf(record, added)))
        env.delivery.begin(withFile)
        env.delivery.finish(withFile, SendOutcome.Sent(withFile.clientMessageId, reconciled = false))
        assertEquals("the file added since, alone", AttachmentJson.encodeList(listOf(added)), env.kv.get(attachmentDraftKey("m", "s")))
    }
}
