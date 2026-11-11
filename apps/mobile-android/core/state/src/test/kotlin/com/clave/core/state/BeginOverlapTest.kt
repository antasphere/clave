package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.ReconnectReport
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.chat.deliveryMarkKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.WriteStatusKind
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reconnection pass overlapping a send whose begin failed: its mark write refused, its entry taken
 * out again (or not), and the person then told "Nothing was sent" or that it is unknown. Whatever the
 * order, a send answered "Nothing was sent" is never written, by its own write or by a pass's same-id
 * completion; the id stays in flight until the answer is decided, so no pass completes the send in
 * that window; and every way out of the begin, a cancellation included, lets the id go.
 *
 * The send runs through the store ([ClaveStore.send]); the pass is the controller's own
 * ([com.clave.core.chat.DeliveryController.reconnect]: its lock, its in-flight set, its live ledger
 * reads), with write and status ports the test holds, so each order is driven exactly. Orders (a) to
 * (d) are the four the round-12 verifier drove; (c) is the one that sent a message the person was told
 * was not sent. The controls after them take each way out of the begin once.
 */
class BeginOverlapTest {
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

    private fun refused(): Nothing = throw IOException("The disk refused the write.")

    /** A step the test holds: [reached] once the store got there, then it waits for [release]. */
    private class Gate {
        val reached = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        suspend fun hold() {
            reached.complete(Unit)
            release.await()
        }
    }

    /** Held for ever: only a cancellation ends it. */
    private suspend fun forEver(reached: CompletableDeferred<Unit>) {
        reached.complete(Unit)
        CompletableDeferred<Unit>().await()
    }

    /**
     * The store's behaviour for one begin, each step run once and after the one before it: the mark's
     * write runs [mark] (it throws to refuse the write, suspends to hold it), the undoing's ledger
     * removal runs [undo], and the read-back after a refused removal runs [readBack].
     */
    private fun Harness.steps(mark: suspend () -> Unit, undo: suspend () -> Unit = {}, readBack: suspend () -> Unit = {}) {
        val markKey = deliveryMarkKey(machineId, S1)
        val quoted = "\"$probed\""
        val markRan = AtomicBoolean()
        val undoRan = AtomicBoolean()
        val readBackRan = AtomicBoolean()
        kv.beforeWrite = { key, value ->
            if (key == markKey && markRan.compareAndSet(false, true)) mark()
            if (key == UNKNOWN_SENDS_KEY && markRan.get() && !value.contains(quoted) && undoRan.compareAndSet(false, true)) undo()
        }
        kv.beforeRemove = { key -> if (key == UNKNOWN_SENDS_KEY && markRan.get() && undoRan.compareAndSet(false, true)) undo() }
        kv.beforeRead = { key -> if (key == UNKNOWN_SENDS_KEY && undoRan.get() && readBackRan.compareAndSet(false, true)) readBack() }
    }

    /** What a pass did, through ports the test holds: every status asked, every completion written. */
    private class PassPorts(val status: suspend (UnknownSend) -> WriteStatus) {
        val asked = CopyOnWriteArrayList<String>()
        val written = CopyOnWriteArrayList<String>()
    }

    private fun Harness.pass(ports: PassPorts): Deferred<ReconnectReport> = scope.async {
        delivery!!.reconnect(
            machineId = machineId,
            openConversations = emptyList(),
            write = { send ->
                ports.written += send.clientMessageId
                WriteAnswer(WriteAnswerStatus.Accepted)
            },
            status = { send ->
                ports.asked += send.clientMessageId
                ports.status(send)
            },
            refreshRequests = {},
            refreshHistory = { _, _ -> },
        )
    }

    /**
     * Inside the window before the answer is decided: the id is still in flight, and a pass that the
     * machine would answer `absent` (so that reaching the send would complete it) leaves it alone.
     */
    private suspend fun Harness.passInTheWindow() {
        assertTrue("the id stays in flight until the answer is decided", delivery!!.inFlight(probed))
        val ports = PassPorts { WriteStatus(WriteStatusKind.Absent) }
        val passing = pass(ports)
        until(10_000, what = "the pass to complete the send, or to leave it") { ports.written.isNotEmpty() || passing.isCompleted }
        assertTrue("no pass completes the send in the window: it wrote ${ports.written}", ports.written.none { it == probed })
        awaitGate("the pass", passing)
    }

    private suspend fun Harness.composerHolds() {
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
    }

    private fun Harness.send(): Deferred<SendOutcome> = scope.async { store.send(machineId, S1, TEXT, attachments = listOf(file)) }

    /** Answered "Nothing was sent": then nothing of it was written, nor will be, and the draft stays for the person. */
    private suspend fun Harness.nothingWasSent(outcome: SendOutcome, ports: PassPorts?) {
        assertEquals(SendOutcome.Failed(probed, NOTHING_SENT), outcome)
        if (ports != null) assertTrue("a send answered \"Nothing was sent\" was never written: the pass wrote ${ports.written}", ports.written.none { it == probed })
        assertEquals("nothing of it is kept for a later pass", listOf<String>(), sends.list().filter { it.sessionId == S1 }.map { it.clientMessageId })
        assertEquals("the draft stays: nothing went", TEXT, drafts.get(machineId, S1))
        assertFalse("released once answered", delivery!!.inFlight(probed))
    }

    /** Cancelled: it was never answered, and the id was let go. */
    private suspend fun Harness.cancelledAndReleased(sending: Deferred<SendOutcome>) {
        sending.cancel()
        sending.join()
        assertTrue("never answered, so never \"Nothing was sent\"", sending.isCancelled)
        until(5_000, what = "the id let go after the cancellation") { !delivery!!.inFlight(probed) }
    }

    // ── the verifier's orders ──

    @Test
    fun `a the pass runs while the begin's mark write is held, finds the send in flight and leaves it, then the write is refused`() = guarded {
        composerHolds()
        val mark = Gate()
        steps(mark = { mark.hold(); refused() })
        val sending = send()
        awaitGate("the begin's mark write", mark.reached)
        val ports = PassPorts { WriteStatus(WriteStatusKind.Absent) }
        val report = awaitGate("the pass", pass(ports))
        assertEquals("the send in flight is never asked about", listOf<String>(), ports.asked.filter { it == probed })
        assertTrue(report.outcomes.none { it.send.clientMessageId == probed })
        mark.release.complete(Unit)
        nothingWasSent(awaitGate("the send's answer", sending), ports)
    }

    @Test
    fun `b the pass asks about the send while its undoing is held, and hears absent only once the entry left`() = guarded {
        composerHolds()
        val undo = Gate()
        steps(mark = { refused() }, undo = { undo.hold() })
        val sending = send()
        awaitGate("the undoing's ledger write", undo.reached)
        val statusAsked = CompletableDeferred<Unit>()
        val answerStatus = CompletableDeferred<Unit>()
        val ports = PassPorts {
            statusAsked.complete(Unit)
            answerStatus.await()
            WriteStatus(WriteStatusKind.Absent)
        }
        val passing = pass(ports)
        until(10_000, what = "the pass to ask about the send, or to leave it") { statusAsked.isCompleted || passing.isCompleted }
        undo.release.complete(Unit)
        val outcome = awaitGate("the send's answer", sending)
        answerStatus.complete(Unit)
        awaitGate("the pass", passing)
        nothingWasSent(outcome, ports)
    }

    @Test
    fun `c the pass hears absent and is let complete the send while its undoing is held, before the entry leaves`() = guarded {
        composerHolds()
        val undo = Gate()
        steps(mark = { refused() }, undo = { undo.hold() })
        val sending = send()
        awaitGate("the undoing's ledger write", undo.reached)
        // The status answers absent at once: the entry is still in the ledger when the pass decides.
        val ports = PassPorts { WriteStatus(WriteStatusKind.Absent) }
        val passing = pass(ports)
        until(10_000, what = "the pass to complete the send, or to leave it") { ports.written.isNotEmpty() || passing.isCompleted }
        undo.release.complete(Unit)
        val outcome = awaitGate("the send's answer", sending)
        awaitGate("the pass", passing)
        nothingWasSent(outcome, ports)
    }

    @Test
    fun `d the pass is held on another send while the undoing lands, then reaches the send gone`() = guarded {
        composerHolds()
        sends.add(UnknownSend(machineId, "s2", OTHER, "other", clock.nowMs))
        val undo = Gate()
        steps(mark = { refused() }, undo = { undo.hold() })
        val sending = send()
        awaitGate("the undoing's ledger write", undo.reached)
        val otherAsked = CompletableDeferred<Unit>()
        val answerOther = CompletableDeferred<Unit>()
        val ports = PassPorts { send ->
            if (send.clientMessageId == OTHER) {
                otherAsked.complete(Unit)
                answerOther.await()
                WriteStatus(WriteStatusKind.Unknown)
            } else {
                WriteStatus(WriteStatusKind.Absent)
            }
        }
        val passing = pass(ports)
        awaitGate("the pass held on the other send", otherAsked)
        undo.release.complete(Unit)
        val outcome = awaitGate("the send's answer", sending)
        answerOther.complete(Unit)
        awaitGate("the pass", passing)
        assertEquals("the send is never asked about", listOf(OTHER), ports.asked.toList())
        nothingWasSent(outcome, ports)
        assertEquals("the other send stays", listOf(OTHER), sends.list().map { it.clientMessageId })
    }

    // ── one control per way out of the begin ──

    @Test
    fun `the begin recorded, the id is in flight while its write is out, a pass leaves it, and it is let go once the send answered`() = guarded {
        composerHolds()
        machine.handler = { call ->
            if (call.path == "/sessions/write") machine.hold(call) else answer(200, """{"status":"accepted"}""")
        }
        val sending = send()
        until(10_000, what = "the send's write out") { machine.held.size == 1 }
        passInTheWindow()
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertEquals(SendOutcome.Sent(probed, reconciled = false), awaitGate("the send's answer", sending))
        assertFalse("let go once answered", delivery!!.inFlight(probed))
    }

    @Test
    fun `the mark refused and the undoing landed, the id is in flight until "Nothing was sent" is decided`() = guarded {
        composerHolds()
        val undo = Gate()
        steps(mark = { refused() }, undo = { undo.hold() })
        val sending = send()
        awaitGate("the undoing's ledger write", undo.reached)
        passInTheWindow()
        undo.release.complete(Unit)
        nothingWasSent(awaitGate("the send's answer", sending), null)
    }

    @Test
    fun `the undoing refused and read back as kept, the id is in flight until the answer is unknown`() = guarded {
        composerHolds()
        val readBack = Gate()
        steps(mark = { refused() }, undo = { refused() }, readBack = { readBack.hold() })
        val sending = send()
        awaitGate("the undoing's read-back", readBack.reached)
        passInTheWindow()
        readBack.release.complete(Unit)
        assertEquals("kept: unknown, never \"Nothing was sent\"", SendOutcome.Unknown(probed, KEPT_NOT_SAVED), awaitGate("the send's answer", sending))
        assertEquals("kept for a later pass", listOf(probed), sends.list().map { it.clientMessageId })
        assertFalse("let go once answered", delivery!!.inFlight(probed))
    }

    @Test
    fun `the undoing refused and its read-back refused too, the id is in flight until the answer is unknown`() = guarded {
        composerHolds()
        val readBack = Gate()
        steps(mark = { refused() }, undo = { refused() }, readBack = { readBack.hold(); refused() })
        val sending = send()
        awaitGate("the undoing's read-back", readBack.reached)
        passInTheWindow()
        readBack.release.complete(Unit)
        assertEquals("not known whether it stays: unknown", SendOutcome.Unknown(probed, KEPT_NOT_SAVED), awaitGate("the send's answer", sending))
        assertFalse("let go once answered", delivery!!.inFlight(probed))
    }

    @Test
    fun `cancelled during the mark write, the id is let go, the send is never answered, and a later pass may still send it once`() = guarded {
        composerHolds()
        val markReached = CompletableDeferred<Unit>()
        steps(mark = { forEver(markReached) })
        val sending = send()
        awaitGate("the begin's mark write", markReached)
        passInTheWindow()
        cancelledAndReleased(sending)
        kv.beforeWrite = null
        kv.beforeRemove = null
        kv.beforeRead = null
        // Never told anything: its entry is kept, and a pass may complete it, under its own id, once.
        val ports = PassPorts { WriteStatus(WriteStatusKind.Absent) }
        awaitGate("the next pass", pass(ports))
        assertEquals(listOf(probed), ports.written.toList())
        assertEquals(listOf<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `cancelled during the undoing, the id is let go and the send is never answered`() = guarded {
        composerHolds()
        val undoReached = CompletableDeferred<Unit>()
        steps(mark = { refused() }, undo = { forEver(undoReached) })
        val sending = send()
        awaitGate("the undoing's ledger write", undoReached)
        passInTheWindow()
        cancelledAndReleased(sending)
        assertEquals("the removal never landed: the entry is kept", listOf(probed), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `cancelled during the undoing's read-back, the id is let go and the send is never answered`() = guarded {
        composerHolds()
        val readBackReached = CompletableDeferred<Unit>()
        steps(mark = { refused() }, undo = { refused() }, readBack = { forEver(readBackReached) })
        val sending = send()
        awaitGate("the undoing's read-back", readBackReached)
        passInTheWindow()
        cancelledAndReleased(sending)
        assertEquals(listOf(probed), sends.list().map { it.clientMessageId })
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val OTHER = "m-0000000000000000000000ff"
    }
}
