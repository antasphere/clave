package com.clave.core.chat

import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ports over scripts: what each write attempt does, what each status ask answers. The
 *  write port counts, which is the proof that `unknown` sends nothing. */
private class ScriptedPorts(writes: List<String>, statuses: List<Any>) : SendPorts {
    private val writeScript = ArrayDeque(writes)
    private val statusScript = ArrayDeque(statuses)
    private var clock = 0L
    val writes = mutableListOf<String>()
    var asks = 0
    val slept = mutableListOf<Long>()

    override suspend fun write(clientMessageId: String): WriteAnswer {
        writes.add(clientMessageId)
        return when (writeScript.removeFirstOrNull() ?: "ok") {
            "ok" -> WriteAnswer(WriteAnswerStatus.Accepted)
            "network" -> throw SendFailure(SendFailure.Kind.Network, "The server could not be reached.")
            "timeout" -> throw SendFailure(SendFailure.Kind.Timeout, "The server did not answer within 10 s.")
            "refused" -> throw SendFailure(
                SendFailure.Kind.Refused, "The provider refused the message.", status = 422, failureTag = "SessionWriteRefused",
            )
            else -> throw SendFailure(SendFailure.Kind.Unauthenticated, "The server refused the token.", status = 401)
        }
    }

    override suspend fun status(clientMessageId: String): WriteStatus {
        asks += 1
        return when (val step = statusScript.removeFirstOrNull() ?: "network") {
            "network" -> throw SendFailure(SendFailure.Kind.Network, "The server could not be reached.")
            "404" -> throw SendFailure(SendFailure.Kind.Protocol, "The server answered 404.", status = 404)
            else -> step as WriteStatus
        }
    }

    override suspend fun sleep(ms: Long) {
        slept.add(ms)
        clock += ms
    }

    override fun now(): Long = clock
}

private fun st(kind: WriteStatusKind, reason: String? = null, at: Long? = null) = WriteStatus(kind, at, reason)

class SendTest {
    @Test
    fun `a write that answers is sent, nothing asked`() = runTest {
        val p = ScriptedPorts(listOf("ok"), emptyList())
        assertEquals(SendOutcome.Sent("m-1", reconciled = false), sendMessage("m-1", p))
        assertEquals(0, p.asks)
    }

    @Test
    fun `a refusal keeps the draft with the reason and never asks`() = runTest {
        val p = ScriptedPorts(listOf("refused"), emptyList())
        assertEquals(SendOutcome.Rejected("m-1", "The provider refused the message."), sendMessage("m-1", p))
        assertEquals(0, p.asks)
    }

    @Test
    fun `a refused token is a failure, not a reconciliation`() = runTest {
        val p = ScriptedPorts(listOf("unauthenticated"), emptyList())
        assertTrue(sendMessage("m-1", p) is SendOutcome.Failed)
        assertEquals(0, p.asks)
    }

    @Test
    fun `accepted, the lost answer is found landed`() = runTest {
        val p = ScriptedPorts(listOf("network"), listOf(st(WriteStatusKind.Accepted, at = 5)))
        assertEquals(SendOutcome.Sent("m-1", reconciled = true), sendMessage("m-1", p))
        assertEquals(listOf("m-1"), p.writes)
    }

    @Test
    fun `pending is asked again with backoff, then accepted`() = runTest {
        val p = ScriptedPorts(
            listOf("timeout"),
            listOf(st(WriteStatusKind.Pending), st(WriteStatusKind.Pending), st(WriteStatusKind.Accepted)),
        )
        assertTrue(sendMessage("m-1", p, SendOptions(backoffMs = 1_000)) is SendOutcome.Sent)
        assertEquals(listOf(1_000L, 2_000L), p.slept)
        assertEquals(3, p.asks)
    }

    @Test
    fun `pending past the budget counts as unknown and sends nothing`() = runTest {
        val p = ScriptedPorts(listOf("network"), List(50) { st(WriteStatusKind.Pending) })
        val outcome = sendMessage("m-1", p, SendOptions(pendingBudgetMs = 60_000, backoffMs = 1_000, maxBackoffMs = 8_000))
        assertTrue(outcome is SendOutcome.Unknown)
        assertEquals(listOf("m-1"), p.writes)
        assertTrue(p.slept.sum() <= 60_000)
        assertTrue(p.slept.last() <= 8_000)
    }

    @Test
    fun `rejected on the ledger keeps the draft with the recorded reason`() = runTest {
        val p = ScriptedPorts(listOf("network"), listOf(st(WriteStatusKind.Rejected, "server restarted before dispatch")))
        assertEquals(SendOutcome.Rejected("m-1", "server restarted before dispatch"), sendMessage("m-1", p))
        assertEquals(listOf("m-1"), p.writes)
    }

    @Test
    fun `absent, the same send is completed once with the same id`() = runTest {
        val p = ScriptedPorts(listOf("network", "ok"), listOf(st(WriteStatusKind.Absent)))
        assertEquals(SendOutcome.Sent("m-1", reconciled = true), sendMessage("m-1", p))
        assertEquals(listOf("m-1", "m-1"), p.writes)
    }

    @Test
    fun `absent twice, the one retry is spent, the second loss is unknown`() = runTest {
        val p = ScriptedPorts(listOf("network", "network"), listOf(st(WriteStatusKind.Absent), st(WriteStatusKind.Absent)))
        assertTrue(sendMessage("m-1", p) is SendOutcome.Unknown)
        assertEquals(listOf("m-1", "m-1"), p.writes)
        assertEquals(2, p.asks)
    }

    @Test
    fun `unknown sends nothing by itself and keeps the id for the person's choice`() = runTest {
        val p = ScriptedPorts(listOf("network"), listOf(st(WriteStatusKind.Unknown)))
        assertEquals(SendOutcome.Unknown("m-1", "The server cannot say whether the message arrived."), sendMessage("m-1", p))
        assertEquals(listOf("m-1"), p.writes)
    }

    @Test
    fun `a server without the status route cannot tell, unknown, nothing sent`() = runTest {
        val p = ScriptedPorts(listOf("timeout"), listOf("404"))
        val outcome = sendMessage("m-1", p)
        assertEquals(SendOutcome.Unknown("m-1", "This server cannot say whether the message arrived."), outcome)
        assertEquals(listOf("m-1"), p.writes)
    }

    @Test
    fun `a status ask that fails is unknown, nothing sent`() = runTest {
        val p = ScriptedPorts(listOf("network"), listOf("network"))
        assertTrue(sendMessage("m-1", p) is SendOutcome.Unknown)
        assertEquals(listOf("m-1"), p.writes)
    }

    @Test
    fun `the crash between the dispatch and the acknowledgement keeps the draft and sends nothing by itself`() = runTest {
        // The write's answer is lost with the server; the restarted server recovers the
        // entry as unknown (the seam's recovery rule).
        val p = ScriptedPorts(listOf("network"), listOf(st(WriteStatusKind.Unknown)))
        assertTrue(sendMessage("m-1", p) is SendOutcome.Unknown)
        assertEquals(1, p.writes.size)
        // Asked again later (a reconnection), still unknown: still nothing sent.
        val later = ScriptedPorts(emptyList(), listOf(st(WriteStatusKind.Unknown)))
        assertTrue(reconcile("m-1", later) is SendOutcome.Unknown)
        assertEquals(0, later.writes.size)
    }

    @Test
    fun `an unrecognized typed HTTP refusal does not prove the message was rejected`() = runTest {
        val p = object : SendPorts by ScriptedPorts(emptyList(), emptyList()) {
            override suspend fun write(clientMessageId: String): WriteAnswer =
                throw SendFailure(SendFailure.Kind.Refused, "Gateway failed.", status = 422, failureTag = "GatewayFailed")
        }
        assertTrue(sendMessage("message-123", p) is SendOutcome.Unknown)
    }

    // Beyond the TypeScript suite: the two other refusal tags the brief names.
    @Test
    fun `a write refused as unknown or for a missing session maps by its tag`() = runTest {
        fun refusing(tag: String) = object : SendPorts by ScriptedPorts(emptyList(), emptyList()) {
            override suspend fun write(clientMessageId: String): WriteAnswer =
                throw SendFailure(SendFailure.Kind.Refused, "No.", status = 422, failureTag = tag)
        }
        assertTrue(sendMessage("m", refusing("SessionWriteUnknown")) is SendOutcome.Unknown)
        assertTrue(sendMessage("m", refusing("SessionNotFound")) is SendOutcome.Rejected)
    }
}
