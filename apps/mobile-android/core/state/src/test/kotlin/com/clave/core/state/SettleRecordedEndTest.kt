package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.COMPLETION_REFUSED
import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.END_NOT_SAVED
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.chat.buildUserMessage
import com.clave.core.chat.deliveryMarkKey
import com.clave.core.chat.draftKey
import com.clave.core.contract.Attachment
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
 * The fix of SettleCrashBoundaryTest's boundary, one write earlier each time: every end of a send
 * (sent, rejected, the composer's own write refused, a discard) is recorded in its ledger entry
 * before any cleanup, so a process that ends after that record and before a cleanup write (the
 * draft, the attachment draft, the mark) leaves the next controller enough to finish it at its
 * start, with no call to the machine, and a recorded end is never asked about or written again.
 * Beside it: a refused same-id completion stays unknown and is not sent again by itself, and a
 * notice an older build left without its send fails closed.
 *
 * Scope, as in SettleCrashBoundaryTest: a fresh controller and store over the SAME stores, as a
 * process death leaves them; not an OS restart and not a power loss. The entry, the mark, the draft
 * and the attachment draft are separate awaited writes, not one transaction. The screen is read as
 * the core gives it: the card from the ledger's send ([DeliveryController.unsettled]) or a notice
 * left without its send ([DeliveryController.orphan]), the notice from the mark.
 */
class SettleRecordedEndTest {
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

    private fun Harness.writtenTexts(): List<String> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map {
        json(it.body).jsonObject["input"]!!.jsonObject["text"]?.jsonPrimitive?.content ?: ""
    }

    private fun Harness.askedIds(): List<String> = machine.calls.filter { it.path == "/sessions/writes" }.map { it.query["clientMessageId"] ?: "" }

    private suspend fun Harness.composerHolds(files: List<Attachment> = listOf(file)) {
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(files))
    }

    /** The first send's answer is lost and its status cannot be asked: unknown, its entry and mark stay. */
    private suspend fun Harness.lostSend() {
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(504, "{}") })
        composerHolds()
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        assertTrue("the first send ends unknown: $outcome", outcome is SendOutcome.Unknown)
        assertEquals(probed, outcome.clientMessageId)
    }

    private suspend fun Harness.keeper() = sends.add(UnknownSend(machineId, "s9", KEEPER, "keeper", clock.nowMs))

    /** The push channel opens again (or for the first time), which runs a pass; returns once it settled the keeper. */
    private suspend fun Harness.pass() {
        keeper()
        machine.welcome = true
        machine.closePeers()
        store.connect(machineId)
        until(60_000, what = "the pass") { runBlocking { sends.list().none { it.clientMessageId == KEEPER } } }
    }

    /**
     * The process ends at the instant a write matching [matches] is about to land: the write never
     * lands, the writer waits for ever under NonCancellable, so nothing after it in the same settle
     * happens. [matches] gets the key and the value, null for a removal.
     */
    private class EndBefore(private val kv: SyncKv, private val matches: (key: String, value: String?) -> Boolean) {
        val left = CompletableDeferred<Map<String, String>>()
        private val never = CompletableDeferred<Unit>()

        private suspend fun hold(key: String, value: String?) {
            if (!left.isCompleted && matches(key, value)) {
                left.complete(storesOf(kv))
                withContext(NonCancellable) { never.await() }
            }
        }

        fun arm() {
            kv.beforeWrite = { key, value -> hold(key, value) }
            kv.beforeRemove = { key -> hold(key, null) }
        }
    }

    private suspend fun Harness.endsHere(end: EndBefore, what: String): Map<String, String> {
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

    /** The probed send's ledger entry in what the ended process left. */
    private fun entryIn(left: Map<String, String>, clientMessageId: String = probed): JsonObject? =
        left[UNKNOWN_SENDS_KEY]?.let { raw ->
            (json(raw) as JsonArray).map { it.jsonObject }.firstOrNull { it["clientMessageId"]?.jsonPrimitive?.content == clientMessageId }
        }

    private fun endKindIn(left: Map<String, String>): String? =
        (entryIn(left)?.get("end") as? JsonObject)?.get("kind")?.jsonPrimitive?.content

    private fun Harness.overSameStores(): Harness =
        Harness(machine = machine, mint = { id(minted.incrementAndGet()) }, kv = kv, ownsMachine = false)

    /** What the next controller reads of the conversation, through its own objects. */
    private data class Seen(
        val ledger: List<String>,
        val card: String?,
        val orphan: String?,
        val mark: DeliveryMark?,
        val draft: String,
        val attachmentDraft: String?,
    )

    private suspend fun Harness.seen(): Seen = Seen(
        ledger = sends.list().map { it.clientMessageId },
        card = delivery!!.unsettled(machineId, S1)?.clientMessageId,
        orphan = delivery.orphan(machineId, S1)?.clientMessageId,
        mark = marks.get(machineId, S1),
        draft = drafts.get(machineId, S1),
        attachmentDraft = kv.get(attachmentDraftKey(machineId, S1)),
    )

    /**
     * The next process over the stores the ended one left: its start alone (no connection, no call to
     * the machine) must have finished the probed send, [expect] says how. Then its first pass runs
     * against a machine that would answer `absent` about the probed send (a pass that asked would
     * complete it) and neither asks about it nor writes it.
     */
    private suspend fun Harness.nextFinishesAtStart(expect: (Seen) -> Unit) {
        val calls = machine.calls.size
        val writes = writtenIds().size
        val asks = askedIds().count { it == probed }
        val next = overSameStores()
        try {
            next.start()
            val atStart = next.seen()
            assertEquals("the start calls nothing on the machine", calls, machine.calls.size)
            assertFalse("the probed send left the ledger at the start: ${atStart.ledger}", probed in atStart.ledger)
            assertNull("no card", atStart.card)
            assertNull("no notice left without its send", atStart.orphan)
            expect(atStart)
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
            next.pass()
            assertEquals("the first pass never asks about the probed send", asks, askedIds().count { it == probed })
            assertEquals("nothing is written after the restart", writes, writtenIds().size)
        } finally {
            next.close()
        }
    }

    // ── Sent, by the pass: the end, then the draft, the attachment draft, the mark ──

    @Test
    fun `S1 sent, the process ends after the end record and before the draft write, and the next start finishes it`() = guarded {
        lostSend()
        val end = EndBefore(kv) { key, value -> key == draftKey(machineId, S1) && value == null }.also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
        keeper()
        machine.welcome = true
        machine.closePeers()
        val left = endsHere(end, "the draft's clear")
        assertEquals("the end was recorded before the crash", "sent", endKindIn(left))
        assertEquals("the draft was still the text sent", TEXT, left[draftKey(machineId, S1)])
        nextFinishesAtStart { seen ->
            assertEquals("the delivered draft goes", "", seen.draft)
            assertNull("its files go", seen.attachmentDraft)
            assertNull("no stale notice", seen.mark)
        }
    }

    @Test
    fun `S2 sent, the process ends before the attachment draft's write, and the next start takes out only the records sent`() = guarded {
        lostSend()
        // A file the person added while the send was unknown: it stays.
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file, added)))
        val end = EndBefore(kv) { key, _ -> key == attachmentDraftKey(machineId, S1) }.also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
        keeper()
        machine.welcome = true
        machine.closePeers()
        val left = endsHere(end, "the attachment draft's write")
        assertEquals("sent", endKindIn(left))
        assertNull("the draft was cleared before the crash", left[draftKey(machineId, S1)])
        nextFinishesAtStart { seen ->
            assertEquals("", seen.draft)
            assertEquals("the file added since, alone", AttachmentJson.encodeList(listOf(added)), seen.attachmentDraft)
            assertNull(seen.mark)
        }
    }

    @Test
    fun `S3 sent, the process ends before the mark's clear, and the next start clears it`() = guarded {
        lostSend()
        val end = EndBefore(kv) { key, value -> key == deliveryMarkKey(machineId, S1) && value == null }.also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
        keeper()
        machine.welcome = true
        machine.closePeers()
        val left = endsHere(end, "the mark's clear")
        assertEquals("sent", endKindIn(left))
        assertNotNull("the Unknown mark was still there", left[deliveryMarkKey(machineId, S1)])
        nextFinishesAtStart { seen ->
            assertNull("no stale notice", seen.mark)
            assertEquals("", seen.draft)
            assertNull(seen.attachmentDraft)
        }
    }

    @Test
    fun `S4 sent with the draft edited since, the process ends before the mark's clear, and the edited draft stays`() = guarded {
        lostSend()
        drafts.set(machineId, S1, "edited since")
        val end = EndBefore(kv) { key, value -> key == deliveryMarkKey(machineId, S1) && value == null }.also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
        keeper()
        machine.welcome = true
        machine.closePeers()
        val left = endsHere(end, "the mark's clear")
        assertEquals("sent", endKindIn(left))
        nextFinishesAtStart { seen ->
            assertEquals("the person's new text is never cleared", "edited since", seen.draft)
            assertNull(seen.attachmentDraft)
            assertNull(seen.mark)
        }
    }

    // ── Rejected, Failed, Discard: the end, then the mark ──

    @Test
    fun `R1 rejected, the process ends after the end record and before the Rejected mark, and the next start sets it`() = guarded {
        lostSend()
        val end = EndBefore(kv) { key, value -> key == deliveryMarkKey(machineId, S1) && value?.contains("\"rejected\"") == true }.also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
        keeper()
        machine.welcome = true
        machine.closePeers()
        val left = endsHere(end, "the Rejected mark's write")
        assertEquals("rejected", endKindIn(left))
        nextFinishesAtStart { seen ->
            assertEquals("the rejection's notice, not an Unknown one", DeliveryMark.Kind.Rejected, seen.mark?.kind)
            assertEquals(probed, seen.mark?.clientMessageId)
            assertEquals("The session is closed.", seen.mark?.reason)
            assertEquals("the draft stays", TEXT, seen.draft)
            assertEquals("the files stay", AttachmentJson.encodeList(listOf(file)), seen.attachmentDraft)
        }
    }

    @Test
    fun `F1 the own send refused with a 403, the process ends after the Failed record and before the mark's clear, and the next start clears it`() = guarded {
        composerHolds()
        routes(write = { answer(403, """{"message":"This device may not write to that session."}""") }, status = { _, _ -> answer(200, ACCEPTED) })
        val end = EndBefore(kv) { key, value -> key == deliveryMarkKey(machineId, S1) && value == null }.also { it.arm() }
        val send = scope.async { store.send(machineId, S1, TEXT, attachments = listOf(file)) }
        val left = endsHere(end, "the mark's clear after the Failed record")
        assertFalse(send.isCompleted)
        assertEquals("failed", endKindIn(left))
        nextFinishesAtStart { seen ->
            assertNull("no \"Delivery has not been confirmed.\" over a send that failed", seen.mark)
            assertEquals("the draft stays", TEXT, seen.draft)
            assertEquals(AttachmentJson.encodeList(listOf(file)), seen.attachmentDraft)
        }
    }

    @Test
    fun `D1 a Discard, the process ends after its record and before the mark's clear, and the next start carries it out`() = guarded {
        lostSend()
        val end = EndBefore(kv) { key, value -> key == deliveryMarkKey(machineId, S1) && value == null }.also { it.arm() }
        val discard = scope.async { store.discardUnknown(machineId, S1, probed) }
        val left = endsHere(end, "the Discard's mark clear")
        assertFalse(discard.isCompleted)
        assertEquals("the discard was recorded", JsonPrimitive(true), entryIn(left)?.get("discarded"))
        nextFinishesAtStart { seen ->
            assertNull(seen.mark)
            // Ruled in round three (finding 5): a Discard's record says it was a Discard, and its
            // cleanup took the discarded text and file out before the mark's clear.
            assertEquals("the discarded text left the draft", "", seen.draft)
            assertNull("and its file", seen.attachmentDraft)
        }
    }

    /**
     * A recorded Failed or Rejected end whose finishing the next controller's store refuses: the entry
     * stays recorded, and no pass asks about it or writes it, the machine answering `absent`.
     */
    private fun recordedEndTheNextStoreRefuses(kind: String, settle: suspend Harness.() -> Unit, refuse: SyncKv.(markKey: String) -> Unit) = guarded {
        val markKey = deliveryMarkKey(machineId, S1)
        val end = EndBefore(kv) { key, value -> key == markKey && (value == null || value.contains("\"rejected\"")) }.also { it.arm() }
        settle()
        val left = endsHere(end, "the mark's write after the $kind record")
        assertEquals(kind, endKindIn(left))
        val writes = writtenIds().size
        val asks = askedIds().count { it == probed }
        kv.refuse(markKey)
        val next = overSameStores()
        suspend fun conversation() = next.sends.list().filter { it.sessionId == S1 }
        try {
            next.start()
            assertEquals("the record stays when its finishing fails", listOf(probed), conversation().map { it.clientMessageId })
            assertTrue("and it is decided", conversation().single().decided)
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
            next.pass()
            assertEquals("no pass asks about a recorded end", asks, askedIds().count { it == probed })
            assertEquals("no pass writes a recorded end", writes, writtenIds().size)
            assertEquals("still recorded, for the next start or pass", listOf(probed), conversation().map { it.clientMessageId })
        } finally {
            kv.beforeWrite = null
            kv.beforeRemove = null
            next.close()
        }
    }

    @Test
    fun `F2 a recorded Failed end the next store cannot finish is never asked about nor written after the restart`() =
        recordedEndTheNextStoreRefuses(
            "failed",
            settle = {
                composerHolds()
                routes(write = { answer(403, """{"message":"This device may not write to that session."}""") }, status = { _, _ -> answer(200, ACCEPTED) })
                scope.async { store.send(machineId, S1, TEXT, attachments = listOf(file)) }
            },
            refuse = { markKey -> beforeRemove = { key -> if (key == markKey) throw IOException("The disk refused the write.") } },
        )

    @Test
    fun `R2 a recorded Rejected end the next store cannot finish is never asked about nor written after the restart`() =
        recordedEndTheNextStoreRefuses(
            "rejected",
            settle = {
                lostSend()
                routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
                keeper()
                machine.welcome = true
                machine.closePeers()
            },
            refuse = { markKey -> beforeWrite = { key, _ -> if (key == markKey) throw IOException("The disk refused the write.") } },
        )

    // ── The end's record fails: nothing is cleaned up, and the answer is unknown ──

    /** The store throws on the ledger write that would record an end, as a disk refusing it would. */
    private fun SyncKv.refuseTheEndRecord() {
        beforeWrite = { key, value -> if (key == UNKNOWN_SENDS_KEY && value.contains("\"end\"")) throw IOException("The disk refused the write.") }
    }

    @Test
    fun `W1 the own send refused with a 403 whose Failed record the store refuses stays unknown with its card, and nothing is cleaned up`() = guarded {
        composerHolds()
        routes(write = { answer(403, """{"message":"This device may not write to that session."}""") }, status = { _, _ -> answer(200, ACCEPTED) })
        kv.refuseTheEndRecord()
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        kv.beforeWrite = null
        assertEquals("told unknown, never failed", SendOutcome.Unknown(probed, END_NOT_SAVED), outcome)
        val entry = sends.list().single()
        assertEquals("the send stays in the ledger as it was", probed, entry.clientMessageId)
        assertNull(entry.end)
        assertFalse(entry.decided)
        assertEquals("its card", probed, delivery!!.unsettled(machineId, S1)?.clientMessageId)
        assertEquals("its own notice", DeliveryMark(DeliveryMark.Kind.Unknown, probed, "Delivery has not been confirmed.", clock.nowMs), marks.get(machineId, S1))
        assertEquals(TEXT, drafts.get(machineId, S1))
        assertEquals(AttachmentJson.encodeList(listOf(file)), kv.get(attachmentDraftKey(machineId, S1)))
        assertEquals("a plain send waits for the person's choice", SendOutcome.Failed(probed, DELIVERY_UNKNOWN_FIRST), store.send(machineId, S1, TEXT))
        assertEquals(listOf(probed), writtenIds())
    }

    @Test
    fun `W2 the own send accepted whose Sent record the store refuses stays unknown, keeps its draft, and the next pass settles it`() = guarded {
        composerHolds()
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
        kv.refuseTheEndRecord()
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        kv.beforeWrite = null
        assertEquals(SendOutcome.Unknown(probed, END_NOT_SAVED), outcome)
        assertEquals("not cleared: the phone does not hold the end", TEXT, drafts.get(machineId, S1))
        assertEquals(probed, delivery!!.unsettled(machineId, S1)?.clientMessageId)
        pass()
        assertEquals("the pass asked and settled it under its own id", listOf<String>(), sends.list().map { it.clientMessageId })
        assertEquals("", drafts.get(machineId, S1))
        assertNull(marks.get(machineId, S1))
        assertEquals("written once", listOf(probed), writtenIds())
    }

    // ── A refused same-id completion: unknown, and never sent again by itself ──

    /** A lost send, then a pass that hears `absent` and sends the completion, refused with a 403. */
    private suspend fun Harness.completionRefused() {
        lostSend()
        routes(
            write = { answer(403, """{"message":"This device may not write to that session."}""") },
            status = { _, _ -> answer(200, ABSENT) },
        )
        pass()
        assertEquals("the lost write, then the completion the machine refused", listOf(probed, probed), writtenIds())
        val entry = sends.list().single()
        assertEquals(probed, entry.clientMessageId)
        assertTrue("held from any further completion", entry.completionRefused)
        assertFalse("not ended: the first may still arrive", entry.decided)
        val mark = marks.get(machineId, S1)!!
        assertEquals("still unknown, never failed", DeliveryMark.Kind.Unknown, mark.kind)
        assertTrue(mark.reason, mark.reason.contains("This device may not write to that session."))
    }

    /** The process ends now: its sockets go, its work is cancelled. */
    private fun Harness.processEnds() {
        store.disconnectAll()
        scope.cancel()
        http.connectionPool.evictAll()
    }

    @Test
    fun `C1 a completion refused with a 403 stays unknown and is never sent again by a pass, in this process or after a restart`() = guarded {
        completionRefused()
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
        pass()
        assertEquals("the next pass of this process sends nothing", listOf(probed, probed), writtenIds())
        assertEquals(COMPLETION_REFUSED, marks.get(machineId, S1)?.reason)
        processEnds()
        val next = overSameStores()
        try {
            next.start()
            val atStart = next.seen()
            assertEquals("the card and its choice", probed, atStart.card)
            assertEquals(DeliveryMark.Kind.Unknown, atStart.mark?.kind)
            assertEquals(TEXT, atStart.draft)
            assertEquals("no plain send meanwhile", SendOutcome.Failed(probed, DELIVERY_UNKNOWN_FIRST), next.store.send(machineId, S1, TEXT))
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
            next.pass()
            assertEquals("never sent again after the restart", listOf(probed, probed), writtenIds())
            assertEquals(listOf(probed), next.sends.list().map { it.clientMessageId })
        } finally {
            next.close()
        }
    }

    @Test
    fun `C2 a completion refused with a 403, the process ends, and the next controller hears the late first write accepted, settled as delivered`() = guarded {
        completionRefused()
        processEnds()
        val writes = writtenIds().size
        val next = overSameStores()
        try {
            next.start()
            next.routes(write = { answer(200, ACCEPTED) }, status = { asked, call -> if (asked == probed) machine.hold(call) else answer(200, ACCEPTED) })
            machine.welcome = true
            next.store.connect(machineId)
            until(60_000, what = "the next controller's pass to ask about the send") { machine.held.size == 1 }
            val before = next.seen()
            assertEquals("before the answer, the card and its choice", probed, before.card)
            assertEquals(DeliveryMark.Kind.Unknown, before.mark?.kind)
            assertEquals(TEXT, before.draft)
            assertEquals("no write meanwhile", writes, writtenIds().size)
            // The first write, held somewhere, arrived after all.
            machine.respond(0, answer(200, ACCEPTED))
            until(60_000, what = "the send to settle") { runBlocking { next.sends.list().isEmpty() } }
            val after = next.seen()
            assertNull("the truthful notice: none, the message arrived; no Unknown, no Failed", after.mark)
            assertNull(after.card)
            assertNull(after.orphan)
            assertEquals("the delivered draft goes", "", after.draft)
            assertNull("its files go", after.attachmentDraft)
            assertEquals("no completion and no duplicate", writes, writtenIds().size)
            val sent = writtenTexts().first()
            assertTrue("no write of the delivered text under a new id", writtenIds().zip(writtenTexts()).none { (id, text) -> id != probed && text == sent })
        } finally {
            next.close()
        }
    }

    @Test
    fun `C3 a completion whose answer is lost (a 504) stays unknown and may be completed again after a restart`() = guarded {
        lostSend()
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(200, ABSENT) })
        pass()
        assertEquals(listOf(probed, probed), writtenIds())
        val entry = sends.list().single()
        assertFalse("an ambiguous outcome is not a refusal", entry.completionRefused)
        assertEquals(DeliveryMark.Kind.Unknown, marks.get(machineId, S1)?.kind)
        processEnds()
        val next = overSameStores()
        try {
            next.start()
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ABSENT) })
            next.pass()
            assertEquals("completed once more under its own id", listOf(probed, probed, probed), writtenIds())
            assertEquals(listOf<String>(), next.sends.list().map { it.clientMessageId })
        } finally {
            next.close()
        }
    }

    // ── A notice an older build left without its send: fails closed ──

    /** As a build before this one leaves it: the entry taken out, the process ended before the mark's write. */
    private suspend fun Harness.orphanAsTheOldBuildLeftIt() {
        composerHolds()
        marks.set(machineId, S1, DeliveryMark(DeliveryMark.Kind.Unknown, OLD, "Delivery has not been confirmed.", clock.nowMs))
        assertNull("no ledger at all", kv.get(UNKNOWN_SENDS_KEY))
    }

    @Test
    fun `O1 an Unknown notice left without its send by an older build fails closed after the upgrade, and Discard clears that mark alone`() = guarded {
        orphanAsTheOldBuildLeftIt()
        val next = overSameStores()
        try {
            next.start()
            val atStart = next.seen()
            assertEquals("shown as a send of unknown delivery", OLD, atStart.orphan)
            assertEquals(DeliveryMark.Kind.Unknown, atStart.mark?.kind)
            assertEquals("the draft stays", TEXT, atStart.draft)
            assertEquals("the files stay", AttachmentJson.encodeList(listOf(file)), atStart.attachmentDraft)
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
            assertEquals("no plain send of the kept draft", SendOutcome.Failed(OLD, DELIVERY_UNKNOWN_FIRST), next.store.send(machineId, S1, TEXT, attachments = listOf(file)))
            next.pass()
            assertEquals("nothing written, nothing asked", listOf<String>(), writtenIds())
            assertEquals(listOf<String>(), askedIds().filter { it != KEEPER })
            assertEquals("nothing says it arrived", DeliveryMark.Kind.Unknown, next.marks.get(machineId, S1)?.kind)
            assertEquals(DeliveryController.DiscardResult.OrphanCleared, next.store.discardUnknown(machineId, S1, OLD))
            val after = next.seen()
            assertNull("that mark went", after.mark)
            assertNull(after.orphan)
            assertEquals("the draft stays", TEXT, after.draft)
            assertEquals("the files stay", AttachmentJson.encodeList(listOf(file)), after.attachmentDraft)
            assertEquals("the ledger is untouched", listOf<String>(), after.ledger)
            assertEquals("then the conversation takes a message", SendOutcome.Sent(id(1), reconciled = false), next.store.send(machineId, S1, TEXT))
        } finally {
            next.close()
        }
    }

    @Test
    fun `O2 Send again on a notice left without its send sends the draft under a new id, as the person chose`() = guarded {
        orphanAsTheOldBuildLeftIt()
        val next = overSameStores()
        try {
            next.start()
            next.routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, ACCEPTED) })
            assertEquals(SendOutcome.Sent(id(1), reconciled = false), next.store.resend(machineId, S1, OLD, TEXT, listOf(file)))
            assertEquals("one write, under a new id", listOf(id(1)), writtenIds())
            assertEquals("the kept draft and its file", listOf(buildUserMessage(TEXT, listOf(file), id(1)).text), writtenTexts())
            assertNull(next.marks.get(machineId, S1))
            assertNull(next.delivery!!.orphan(machineId, S1))
        } finally {
            next.close()
        }
    }

    @Test
    fun `O3 a newer send's mark and a rejection's notice are never taken for a notice left without its send`() = guarded {
        lostSend()
        assertEquals("the newer send's own mark", probed, marks.get(machineId, S1)?.clientMessageId)
        assertNull("its entry is in the ledger: not an orphan", delivery!!.orphan(machineId, S1))
        assertEquals("the gate is the ledger's", SendOutcome.Failed(probed, DELIVERY_UNKNOWN_FIRST), store.send(machineId, S1, TEXT))
        routes(write = { answer(200, ACCEPTED) }, status = { _, _ -> answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
        pass()
        assertEquals(DeliveryMark.Kind.Rejected, marks.get(machineId, S1)?.kind)
        assertNull("a rejection's notice is no orphan", delivery.orphan(machineId, S1))
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), store.send(machineId, S1, "something else"))
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val KEEPER = "m-ffffffffffffffffffffffff"
        const val OLD = "m-0000000000000000000000aa"
        const val ACCEPTED = """{"status":"accepted"}"""
        const val ABSENT = """{"status":"absent"}"""
    }
}

/** Every key the stores hold, copied under the map's own lock. */
private fun storesOf(kv: SyncKv): Map<String, String> = synchronized(kv.map) { LinkedHashMap(kv.map) }
