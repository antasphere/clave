package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import com.clave.core.ports.Clock
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.MemoryKeyValueStore
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A store whose disk refuses the ledger write that would record an end. */
private class RefusesEndRecord(private val inner: KeyValueStore = MemoryKeyValueStore()) : KeyValueStore {
    override suspend fun get(key: String): String? = inner.get(key)
    override suspend fun set(key: String, value: String) {
        if (key == UNKNOWN_SENDS_KEY && value.contains("\"end\"")) throw IOException("The disk refused the write.")
        inner.set(key, value)
    }
    override suspend fun remove(key: String) = inner.remove(key)
}

/** The ledger's end record, the cleanup anchored to it, the mark's ownership, and the refused completion. */
class RecordedEndTest {
    private fun sendOf(id: String) = UnknownSend("m", "s", id, "original bytes", 1, draftText = "  original bytes  ")

    private fun controller(kv: KeyValueStore, now: Long = 42) = DeliveryController(UnknownSends(kv), DeliveryMarks(kv), Drafts(kv), kv, Clock { now })

    @Test
    fun `an entry written before the end existed reads as before, and fields this build does not know are ignored`() = runTest {
        val kv = MemoryKeyValueStore()
        kv.set(
            UNKNOWN_SENDS_KEY,
            """[{"machineId":"m","sessionId":"s","clientMessageId":"message-1","text":"hello","at":5,"draftText":" hello ","discarded":true},""" +
                """{"machineId":"m","sessionId":"s2","clientMessageId":"message-2","text":"hi","at":6,"later":{"x":1},""" +
                """"end":{"kind":"rejected","reason":"closed","at":7,"later":true},"completionRefused":true,"another":"x"},""" +
                """{"machineId":"m","sessionId":"s3","clientMessageId":"message-3","text":"yo","at":8,"end":{"kind":"a-later-kind"}}]""",
        )
        assertEquals(
            listOf(
                UnknownSend("m", "s", "message-1", "hello", 5, draftText = " hello ", discarded = true),
                UnknownSend("m", "s2", "message-2", "hi", 6, end = SendEnd(SendEnd.Kind.Rejected, "closed", 7), completionRefused = true),
                UnknownSend("m", "s3", "message-3", "yo", 8),
            ),
            UnknownSends(kv).list(),
        )
    }

    @Test
    fun `an ended entry and a refused completion read back whole, and an entry without them writes neither field`() = runTest {
        val kv = MemoryKeyValueStore()
        val sends = UnknownSends(kv)
        sends.add(sendOf("message-1"))
        assertFalse(kv.get(UNKNOWN_SENDS_KEY)!!.contains("end"))
        assertFalse(kv.get(UNKNOWN_SENDS_KEY)!!.contains("completionRefused"))
        sends.add(sendOf("message-2"))
        assertTrue(sends.markCompletionRefused("message-2"))
        val ended = sends.markEnded("message-1", SendEnd(SendEnd.Kind.Sent, at = 9))
        assertEquals(sendOf("message-1").copy(end = SendEnd(SendEnd.Kind.Sent, at = 9)), ended)
        assertEquals("the first end recorded stays", ended, sends.markEnded("message-1", SendEnd(SendEnd.Kind.Failed, "no", 10)))
        assertNull("a send no longer in the ledger records nothing", sends.markEnded("message-9", SendEnd(SendEnd.Kind.Sent)))
        assertEquals(listOf(ended, sendOf("message-2").copy(completionRefused = true)), UnknownSends(kv).list())
        assertFalse("an ended send takes no discard", sends.markDiscarded("message-1"))
    }

    @Test
    fun `an older send's end or discard never clears nor overwrites a newer send's mark`() = runTest {
        val kv = MemoryKeyValueStore()
        // Two controllers of one owner over the same stores (a screen rebuilt, a boot after a sign-in),
        // each admitting a send of the conversation at once: the conversation has one mark.
        val first = controller(kv)
        val second = controller(kv, now = 43)
        val older = listOf(sendOf("message-sent"), sendOf("message-rejected"), sendOf("message-failed"), sendOf("message-discarded"))
        older.forEach { first.begin(it) }
        val newer = sendOf("message-newer")
        second.begin(newer)
        val mark = DeliveryMarks(kv).get("m", "s")
        assertEquals("message-newer", mark?.clientMessageId)
        first.finish(older[0], SendOutcome.Sent(older[0].clientMessageId, reconciled = false))
        first.finish(older[1], SendOutcome.Rejected(older[1].clientMessageId, "no"))
        first.finish(older[2], SendOutcome.Failed(older[2].clientMessageId, "refused"))
        discardUnknownSend("m", "s", older[3].clientMessageId, UnknownSends(kv), DeliveryMarks(kv))
        assertEquals("the newer send's mark, as it was", mark, DeliveryMarks(kv).get("m", "s"))
        assertEquals(listOf(newer), UnknownSends(kv).list())
        // The newer one's own end clears its own mark.
        second.finish(newer, SendOutcome.Sent(newer.clientMessageId, reconciled = false))
        assertNull(DeliveryMarks(kv).get("m", "s"))
    }

    @Test
    fun `the next controller's start finishes an older send's recorded end and leaves a newer send's mark`() = runTest {
        val kv = MemoryKeyValueStore()
        val sends = UnknownSends(kv)
        val older = sendOf("message-older")
        val newer = sendOf("message-newer")
        sends.add(older)
        sends.add(newer)
        DeliveryMarks(kv).set("m", "s", DeliveryMark(DeliveryMark.Kind.Unknown, newer.clientMessageId, "Delivery has not been confirmed.", 2))
        Drafts(kv).set("m", "s", "  original bytes  ")
        // The process ended right after the older one's end record.
        sends.markEnded(older.clientMessageId, SendEnd(SendEnd.Kind.Rejected, "no", 3))
        controller(kv).finishRecordedEnds()
        assertEquals(listOf(newer), UnknownSends(kv).list())
        assertEquals(newer.clientMessageId, DeliveryMarks(kv).get("m", "s")?.clientMessageId)
        assertEquals(DeliveryMark.Kind.Unknown, DeliveryMarks(kv).get("m", "s")?.kind)
        assertEquals("  original bytes  ", Drafts(kv).get("m", "s"))
    }

    @Test
    fun `an end the store fails to record cleans nothing up, and the composer is told unknown`() = runTest {
        for (outcome in listOf<(String) -> SendOutcome>(
            { SendOutcome.Sent(it, reconciled = false) },
            { SendOutcome.Rejected(it, "The session is closed.") },
            { SendOutcome.Failed(it, "This device may not write to that session.") },
        )) {
            val kv = RefusesEndRecord()
            val delivery = controller(kv)
            val send = sendOf("message-1")
            Drafts(kv).set("m", "s", "  original bytes  ")
            delivery.begin(send)
            val mark = delivery.marks.get("m", "s")
            assertEquals(SendOutcome.Unknown(send.clientMessageId, END_NOT_SAVED), delivery.finish(send, outcome(send.clientMessageId)))
            assertEquals("the send stays in the ledger as it was", listOf(send), UnknownSends(kv).list())
            assertEquals("its unknown mark stays", mark, DeliveryMarks(kv).get("m", "s"))
            assertEquals("the draft stays", "  original bytes  ", Drafts(kv).get("m", "s"))
            assertFalse("it is no longer in flight: a pass may ask about it", delivery.inFlight(send.clientMessageId))
        }
    }

    /** Status asks answered by [statuses] in turn, the last one repeated; every write answered by [write]. */
    private class Ports(private val statuses: List<WriteStatusKind>, private val write: () -> WriteAnswer, private val refusedBefore: Boolean = false) : SendPorts {
        var writes = 0
        private var asks = 0
        override suspend fun write(clientMessageId: String): WriteAnswer {
            writes++
            return write()
        }
        override suspend fun status(clientMessageId: String): WriteStatus = WriteStatus(statuses[minOf(asks++, statuses.size - 1)])
        override suspend fun sleep(ms: Long) = Unit
        override fun now(): Long = 0
        override suspend fun completionRefused(clientMessageId: String): Boolean = refusedBefore
    }

    @Test
    fun `a same-id completion refused with a 401, a 403 or a declared 422 stays unknown and holds the send, the first write's own refusal keeps its reading`() = runTest {
        for (refusal in listOf(
            SendFailure(SendFailure.Kind.Policy, "This device may not write to that session.", status = 403),
            SendFailure(SendFailure.Kind.Unauthenticated, "The server refused the token.", status = 401),
            // The write route's declared failures (contract sessions.ts:531): none of them proves the first write absent.
            SendFailure(SendFailure.Kind.Refused, "The provider refused the message.", status = 422, failureTag = "SessionWriteRefused"),
            SendFailure(SendFailure.Kind.Refused, "No such session.", status = 422, failureTag = "SessionNotFound"),
            SendFailure(SendFailure.Kind.Refused, "Not known.", status = 422, failureTag = "SessionWriteUnknown"),
        )) {
            val ports = Ports(listOf(WriteStatusKind.Absent), write = { throw refusal })
            val outcome = reconcile("m-1", ports)
            assertEquals(SendOutcome.Unknown("m-1", completionRefusedReason(refusal.message!!), completionRefused = true), outcome)
            assertEquals(1, ports.writes)
        }
        // A lost completion stays an ambiguous outcome: asked again, never held.
        val lost = Ports(listOf(WriteStatusKind.Absent), write = { throw SendFailure(SendFailure.Kind.Protocol, "The server answered 502.", status = 502) })
        assertEquals(SendOutcome.Unknown("m-1", "The message was sent again once and its outcome is still not known."), reconcile("m-1", lost))
        // The composer's own first write refused: that write did not land, a terminal end by its reading.
        fun first(refusal: SendFailure) = Ports(listOf(WriteStatusKind.Unknown), write = { throw refusal })
        assertEquals(
            SendOutcome.Failed("m-1", "This device may not write to that session."),
            sendMessage("m-1", first(SendFailure(SendFailure.Kind.Policy, "This device may not write to that session.", status = 403))),
        )
        assertEquals(
            SendOutcome.Rejected("m-1", "The provider refused the message."),
            sendMessage("m-1", first(SendFailure(SendFailure.Kind.Refused, "The provider refused the message.", status = 422, failureTag = "SessionWriteRefused"))),
        )
    }

    @Test
    fun `a send whose completion was refused before is never completed again, while an accepted or rejected status still settles it`() = runTest {
        val held = Ports(listOf(WriteStatusKind.Absent), write = { WriteAnswer(WriteAnswerStatus.Accepted) }, refusedBefore = true)
        assertEquals(SendOutcome.Unknown("m-1", COMPLETION_REFUSED, completionRefused = true), reconcile("m-1", held))
        assertEquals("nothing written", 0, held.writes)
        assertEquals(SendOutcome.Sent("m-1", reconciled = true), reconcile("m-1", Ports(listOf(WriteStatusKind.Accepted), write = { error("never") }, refusedBefore = true)))
        assertTrue(reconcile("m-1", Ports(listOf(WriteStatusKind.Rejected), write = { error("never") }, refusedBefore = true)) is SendOutcome.Rejected)
    }
}
