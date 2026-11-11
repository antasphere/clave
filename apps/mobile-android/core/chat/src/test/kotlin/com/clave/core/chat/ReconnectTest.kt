package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val send = UnknownSend(machineId = "m-1", sessionId = "s-1", clientMessageId = "message-0001", text = "hello", at = 1)

/** The TypeScript suite's beforeEach: a ledger holding one unknown send, its draft kept. */
private class Fixture {
    val kv = MemoryKeyValueStore()
    val writes = mutableListOf<UnknownSend>()
    val refreshed = mutableListOf<String>()
    var time = 0L
    val sleeps = mutableListOf<Long>()
    var statuses: MutableList<WriteStatus> = mutableListOf(WriteStatus(WriteStatusKind.Unknown))
    var ports = ReconnectPorts(
        sends = UnknownSends(kv),
        marks = DeliveryMarks(kv),
        drafts = Drafts(kv),
        status = { if (statuses.size > 1) statuses.removeAt(0) else statuses[0] },
        write = { s -> writes.add(s); WriteAnswer(WriteAnswerStatus.Accepted) },
        now = { time },
        sleep = { ms -> sleeps.add(ms); time += ms },
        refreshRequests = { id -> refreshed.add("requests:$id") },
        refreshHistory = { m, s -> refreshed.add("history:$m:$s") },
    )

    suspend fun setUp(): Fixture {
        recordUnknownSend(send, "Connection lost", ports.sends, ports.marks)
        Drafts(kv).set("m-1", "s-1", "hello")
        return this
    }

    suspend fun run(): ReconnectReport = reconnectPass(ReconnectInput("m-1", listOf("s-1")), ports)

    fun statuses(vararg s: WriteStatus) { statuses = s.toMutableList() }
}

private fun st(kind: WriteStatusKind, reason: String? = null, at: Long? = null) = WriteStatus(kind, at, reason)

class ReconnectTest {
    @Test
    fun `accepted removes only the matching draft and delivery record without sending`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Accepted, at = 5))
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Sent)
        assertEquals(emptyList<UnknownSend>(), f.writes)
        assertEquals(emptyList<UnknownSend>(), f.ports.sends.list())
        assertEquals("", f.ports.drafts.get("m-1", "s-1"))
        assertNull(f.ports.marks.get("m-1", "s-1"))
    }

    @Test
    fun `accepted preserves text edited since the lost send`() = runTest {
        val f = Fixture().setUp()
        Drafts(f.kv).set("m-1", "s-1", "new draft")
        f.statuses(st(WriteStatusKind.Accepted))
        f.run()
        assertEquals("new draft", f.ports.drafts.get("m-1", "s-1"))
    }

    @Test
    fun `pending waits with backoff up to 60 seconds, retains the draft, then marks unknown`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Pending))
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Unknown)
        assertEquals(60_000L, f.time)
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L), f.sleeps.take(4))
        assertEquals(8000L, f.sleeps.max())
        assertEquals("hello", f.ports.drafts.get("m-1", "s-1"))
        assertEquals(emptyList<UnknownSend>(), f.writes)
        assertEquals(DeliveryMark.Kind.Unknown, f.ports.marks.get("m-1", "s-1")?.kind)
    }

    @Test
    fun `pending later accepted clears without a retry`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Pending), st(WriteStatusKind.Accepted))
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Sent)
        assertEquals(emptyList<UnknownSend>(), f.writes)
    }

    @Test
    fun `rejected retains text and the reason, it never reuses that ID`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Rejected, "server restarted before dispatch"))
        f.run()
        assertEquals("hello", f.ports.drafts.get("m-1", "s-1"))
        val mark = f.ports.marks.get("m-1", "s-1")!!
        assertEquals(DeliveryMark.Kind.Rejected, mark.kind)
        assertEquals("server restarted before dispatch", mark.reason)
        assertEquals(emptyList<UnknownSend>(), f.ports.sends.list())
        assertEquals(emptyList<UnknownSend>(), f.writes)
    }

    @Test
    fun `absent completes the same bytes and ID once`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Absent))
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Sent)
        assertEquals(listOf(send), f.writes)
        assertEquals(emptyList<UnknownSend>(), f.ports.sends.list())
    }

    @Test
    fun `a second lost absent write is unknown, it cannot send a second retry`() = runTest {
        val f = Fixture().setUp()
        f.statuses(st(WriteStatusKind.Absent))
        f.ports = f.ports.copy(write = { s -> f.writes.add(s); throw SendFailure(SendFailure.Kind.Network, "Connection lost") })
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Unknown)
        assertEquals(listOf(send), f.writes)
        assertEquals(listOf(send), f.ports.sends.list())
    }

    @Test
    fun `unknown sends nothing across a restart or repeated reconnections`() = runTest {
        val f = Fixture().setUp()
        f.ports = f.ports.copy(sends = UnknownSends(f.kv), marks = DeliveryMarks(f.kv), drafts = Drafts(f.kv))
        f.run()
        f.run()
        assertEquals(emptyList<UnknownSend>(), f.writes)
        assertEquals(listOf(send), f.ports.sends.list())
        assertEquals("hello", f.ports.drafts.get("m-1", "s-1"))
        assertEquals(DeliveryMark.Kind.Unknown, f.ports.marks.get("m-1", "s-1")?.kind)
    }

    @Test
    fun `an unavailable status route never becomes permission to retry`() = runTest {
        val f = Fixture().setUp()
        f.ports = f.ports.copy(status = { throw SendFailure(SendFailure.Kind.Protocol, "Not found", status = 404) })
        assertTrue(f.run().outcomes[0].outcome is SendOutcome.Unknown)
        assertEquals(emptyList<UnknownSend>(), f.writes)
    }

    @Test
    fun `does not reconcile another machine or send a plain unsent draft`() = runTest {
        val f = Fixture().setUp()
        f.ports.sends.add(send.copy(machineId = "other", clientMessageId = "other-message"))
        Drafts(f.kv).set("m-1", "unsent", "do not send")
        f.run()
        assertEquals(emptyList<UnknownSend>(), f.writes)
        assertEquals(1, f.ports.sends.forMachine("other").size)
        assertEquals("do not send", f.ports.drafts.get("m-1", "unsent"))
        assertEquals(listOf("requests:m-1", "history:m-1:s-1"), f.refreshed)
    }

    @Test
    fun `refreshes pending requests and open history even when delivery stays unknown`() = runTest {
        val f = Fixture().setUp()
        val report = f.run()
        assertTrue(report.requestsRefreshed)
        assertEquals(listOf("s-1"), report.historyRefreshed)
        assertEquals(emptyList<String>(), report.refreshFailures)
        assertEquals(emptyList<UnknownSend>(), f.writes)
    }

    @Test
    fun `a request refresh failure does not skip open history`() = runTest {
        val f = Fixture().setUp()
        f.ports = f.ports.copy(refreshRequests = { throw IllegalStateException("offline") })
        val report = f.run()
        assertFalse(report.requestsRefreshed)
        assertEquals(listOf("s-1"), report.historyRefreshed)
        assertEquals(1, report.refreshFailures.size)
    }

    @Test
    fun `an explicit discard removes the tracking and delivery mark`() = runTest {
        val f = Fixture().setUp()
        discardUnknownSend(send.machineId, send.sessionId, send.clientMessageId, f.ports.sends, f.ports.marks)
        assertEquals(emptyList<UnknownSend>(), f.ports.sends.list())
        assertNull(f.ports.marks.get("m-1", "s-1"))
        assertEquals(emptyList<UnknownSend>(), f.writes)
    }

    @Test
    fun `concurrent lost sends survive storage read-modify-write without dropping an ID`() = runTest {
        val f = Fixture().setUp()
        val sends = UnknownSends(f.kv)
        listOf("parallel-one", "parallel-two").map { id -> async { sends.add(send.copy(clientMessageId = id)) } }.awaitAll()
        assertTrue(sends.list().map { it.clientMessageId }.containsAll(listOf("parallel-one", "parallel-two")))
    }

    // Beyond the TypeScript suite: the stored shapes read back whole.

    @Test
    fun `a send with attachments and a draft text reads back equal, and a mark change is heard`() = runTest {
        val kv = MemoryKeyValueStore()
        val sends = UnknownSends(kv)
        val withFiles = send.copy(
            draftText = "  hello  ",
            attachments = listOf(
                com.clave.core.contract.FileAttachment(
                    id = "f-1", label = "Image #1", path = "/tmp/p.png", name = "p.png",
                    mimeType = "image/png", size = 3, delivery = com.clave.core.contract.FileDelivery.Image,
                ),
                com.clave.core.contract.SessionAttachment(id = "s", sessionId = "s-2", name = "n", agent = "claude", cwd = "/"),
            ),
        )
        sends.add(withFiles)
        assertEquals(listOf(withFiles), UnknownSends(kv).list())
        val marks = DeliveryMarks(kv)
        var heard = 0
        val unsubscribe = marks.subscribe { heard++ }
        marks.set("m", "s", DeliveryMark(DeliveryMark.Kind.Rejected, "id", "why", 7))
        assertEquals(DeliveryMark(DeliveryMark.Kind.Rejected, "id", "why", 7), marks.get("m", "s"))
        unsubscribe()
        marks.clear("m", "s")
        assertEquals(1, heard)
        kv.set(deliveryMarkKey("m", "s"), "not json")
        assertNull(marks.get("m", "s"))
    }
}
