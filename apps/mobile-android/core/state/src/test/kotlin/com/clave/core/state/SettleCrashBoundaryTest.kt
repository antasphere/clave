package com.clave.core.state

import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.contract.Attachment
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PROBE, not a fix (lane B follow-up, 11 November 2026): when a process ends between a settle's ledger
 * write and the writes after it, does the next process find a stale Unknown notice, and a delivered
 * draft one plain Send away from going again under a new id?
 *
 * Each case lets ONE write land: the ledger write that takes the probed send's entry out. The process
 * ends right there. The writer is suspended for ever (under NonCancellable, on a deferred nobody
 * completes), so the settle's next write (the draft, the attachment draft, the mark) never happens. The
 * old store's sockets are dropped and its scope cancelled, and the probe checks that nothing of it wrote
 * after that instant. Then a fresh controller and store are built over the SAME SyncKv, its first
 * reconnection pass runs, and a plain send of the stored draft and files is tried.
 *
 * Scope of the proof: recreation from what the stores hold, as a process death leaves them. It is not an
 * OS restart (in the app two PreferencesKeyValueStore wrappers share one process-wide DataStore) and not
 * a power loss. The ledger entry, the mark, the draft and the attachment draft are separate awaited
 * writes of the key-value store, not one transaction. The screen's rules live in the app and ui modules.
 * They are applied here as read, not run: the "Delivery unknown" card and the Send block come from the
 * ledger (ChatSession.kt:128, Mapping.kt:257, ChatScreen.kt:212-231, ChatPrimitives.kt:515), and the
 * composer's notice from the mark (Mapping.kt:251-255, ChatPrimitives.kt:460). The store's own gate
 * (Store.kt:692) is called for real.
 *
 * Each case asserts what SHOULD hold, so a red names the boundary. After the restart, no Unknown notice
 * for a send that has left the ledger. Where the server took the text, no plain send of the delivered
 * text under a new id while the draft is unedited. What does hold is printed to the test's output.
 */
class SettleCrashBoundaryTest {
    private val minted = AtomicInteger()

    private fun id(n: Int) = "m-%024x".format(n)

    /** The probed send: the first id every case mints. */
    private val probed: String get() = id(1)

    private val file = FileAttachment(
        id = "f-1", label = "Image #1", path = "/tmp/p.png", name = "p.png", mimeType = "image/png", size = 3,
        delivery = FileDelivery.Image,
    )

    /** A store on a machine whose push hub does not welcome yet, so no pass runs until a case lets it. */
    private fun guarded(block: suspend Harness.() -> Unit) {
        val h = Harness(mint = { id(minted.incrementAndGet()) })
        h.machine.welcome = false
        try {
            runBlocking { h.start().block() }
        } finally {
            h.close()
        }
    }

    /** The machine answers every route; the write and the status as the case says, the keeper accepted. */
    private fun Harness.routes(write: (Call) -> MockResponse, status: (id: String) -> MockResponse) {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> write(call)
                "/sessions/writes" -> {
                    val asked = call.query["clientMessageId"] ?: ""
                    if (asked == KEEPER) answer(200, ACCEPTED) else status(asked)
                }
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
    }

    private data class Write(val id: String, val text: String, val files: Int) {
        override fun toString(): String = "$id \"$text\" +$files file(s)"
    }

    /** Every message write the stand-in received, in order: its id, its text and its file count. */
    private fun Harness.writes(): List<Write> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map { call ->
        val input = json(call.body).jsonObject["input"]!!.jsonObject
        Write(
            id = input["clientMessageId"]?.jsonPrimitive?.content ?: "",
            text = input["text"]?.jsonPrimitive?.content ?: "",
            files = (input["attachments"] as? JsonArray)?.size ?: 0,
        )
    }

    /** The composer's text and its one file, as ChatSession stores them before a send (ChatSession.kt:193, :324). */
    private suspend fun Harness.composerHolds() {
        drafts.set(machineId, S1, TEXT)
        kv.set(attachmentDraftKey(machineId, S1), AttachmentJson.encodeList(listOf(file)))
    }

    /** The first send's answer is lost and its status cannot be asked: its outcome is unknown, its entry and mark stay. */
    private suspend fun Harness.lostSend() {
        routes(write = { answer(504, "{}") }, status = { answer(504, "{}") })
        composerHolds()
        val outcome = store.send(machineId, S1, TEXT, attachments = listOf(file))
        assertTrue("probe: the first send ends unknown: $outcome", outcome is SendOutcome.Unknown)
        assertEquals("probe: the probed send is the first id", probed, outcome.clientMessageId)
    }

    /**
     * Another conversation's send, put in the ledger before the crash point is armed. Then the write that
     * takes the probed entry out leaves a list and is a set: SyncKv runs no hook on a remove, which is what
     * an emptied ledger writes (Ledger.kt:121). The next controller's first pass settles it, and its leaving
     * the ledger is how the probe knows that pass is over.
     */
    private suspend fun Harness.keeper() = sends.add(UnknownSend(machineId, "s9", KEEPER, "keeper", clock.nowMs))

    /**
     * The process ends at the instant the ledger write that takes [target]'s entry out has landed. The hook
     * lands that one write itself, copies every key the stores hold, and never returns: the writer waits
     * under NonCancellable on a deferred nobody completes, so the same settle's next write never happens,
     * cancelled or not.
     */
    private class ProcessEnd(private val kv: SyncKv, target: String) {
        val left = CompletableDeferred<Map<String, String>>()
        private val never = CompletableDeferred<Unit>()
        private val quoted = "\"$target\""

        fun arm() {
            kv.beforeWrite = { key, value ->
                val before = kv.map[key]
                if (!left.isCompleted && key == UNKNOWN_SENDS_KEY && before != null && before.contains(quoted) && !value.contains(quoted)) {
                    kv.map[key] = value
                    left.complete(snapshot(kv))
                    withContext(NonCancellable) { never.await() }
                }
            }
        }
    }

    /** The process ends at [end]: nothing of it runs on, its sockets go. Answers what its stores hold. */
    private suspend fun Harness.endsHere(end: ProcessEnd, what: String): Map<String, String> {
        val left = awaitGate("the crash point: $what", end.left, 60_000)
        kv.beforeWrite = null
        store.disconnectAll()
        scope.cancel()
        http.connectionPool.evictAll()
        delay(500)
        assertEquals("probe: nothing of the ended process wrote after its end", left, snapshot(kv))
        return left
    }

    /** One conversation's stored state, read through the next controller's own objects. */
    private class Seen(
        val ledger: List<String>,
        /** What the store's gate reads for the conversation (Store.kt:692, DeliveryController.unsettled). */
        val unsettled: String?,
        val mark: DeliveryMark?,
        val draft: String,
        val attachmentDraft: String?,
    ) {
        private val files: Int get() = filesOf(attachmentDraft).size

        /** As read: ChatSession.kt:128 takes the ledger's send, Mapping.kt:257 and ChatScreen.kt:212-213 draw the card. */
        val card: Boolean get() = unsettled != null

        /** As read: Mapping.kt:251-255 makes the mark the composer's line, ChatPrimitives.kt:460 draws it as a notice. */
        val notice: String?
            get() {
                val m = mark ?: return null
                return when (m.kind) {
                    DeliveryMark.Kind.Unknown -> m.reason
                    DeliveryMark.Kind.Rejected -> "Not delivered: ${m.reason}"
                }
            }

        /** As read: ChatPrimitives.kt:515 with ChatScreen.kt:231 (Send blocked by the card), a live session, nothing sending. */
        val sendEnabled: Boolean get() = !card && (draft.isNotBlank() || files > 0)

        fun describe(): String =
            "ledger=$ledger, store gate unsettled(s1)=$unsettled, " +
                "mark=${mark?.let { "${it.kind}(${it.clientMessageId}, \"${it.reason}\")" }}, " +
                "draft=\"$draft\", attachment draft=$attachmentDraft; " +
                "screen as read: card 'Delivery unknown'=$card, composer notice=${notice?.let { "\"$it\"" }}, Send enabled=$sendEnabled"
    }

    private suspend fun Harness.seen(): Seen = Seen(
        ledger = sends.list().map { "${it.sessionId}:${it.clientMessageId}${if (it.discarded) " (discarded)" else ""}" },
        unsettled = delivery!!.unsettled(machineId, S1)?.clientMessageId,
        mark = marks.get(machineId, S1),
        draft = drafts.get(machineId, S1),
        attachmentDraft = kv.get(attachmentDraftKey(machineId, S1)),
    )

    /** A second controller and store over this harness's stores, on the same machine stand-in: the next process. */
    private fun Harness.overSameStores(): Harness =
        Harness(machine = machine, mint = { id(minted.incrementAndGet()) }, kv = kv, ownsMachine = false)

    /** The next controller's store connects, which runs its first pass; returns once that pass settled the keeper. */
    private suspend fun Harness.firstPass() {
        machine.welcome = true
        store.connect(machineId)
        until(60_000, what = "the next controller's first pass") { runBlocking { sends.list().none { it.clientMessageId == KEEPER } } }
    }

    /**
     * The next process over the stores [left] by the ended one: what it finds at once and after its first
     * pass, then a plain send of the stored draft and files, as the composer's Send would make it
     * (ChatSession.kt:168, :181-194). [delivered]: the server took the probed text, so a new id carrying
     * it is a duplicate.
     */
    private suspend fun Harness.restartAndProbe(case: String, left: Map<String, String>, delivered: Boolean) {
        val before = writes()
        val out = StringBuilder()
        fun note(line: String) {
            out.append('[').append(case).append("] ").append(line).append('\n')
        }
        note("OBSERVED the stores as the ended process left them: $left")
        note("OBSERVED the stand-in's writes before the restart: $before")
        val failures = mutableListOf<String>()
        val next = overSameStores()
        try {
            next.start()
            val atStart = next.seen()
            note("OBSERVED after the restart, before any connection: ${atStart.describe()}")
            next.routes(write = { answer(200, ACCEPTED) }, status = { answer(200, ACCEPTED) })
            next.firstPass()
            val afterPass = next.seen()
            note("OBSERVED after the next controller's first pass: ${afterPass.describe()}")
            val outcome = next.store.send(machineId, S1, afterPass.draft, attachments = filesOf(afterPass.attachmentDraft))
            val sinceRestart = next.writes().drop(before.size)
            note("OBSERVED a plain send of the stored draft and files: $outcome")
            note("OBSERVED the stand-in's writes since the restart: $sinceRestart")
            note("OBSERVED after that send: ${next.seen().describe()}")
            val stale = listOf("at the restart" to atStart, "after the first pass" to afterPass)
                .filter { (_, seen) -> seen.unsettled == null && seen.mark?.kind == DeliveryMark.Kind.Unknown }
            if (stale.isNotEmpty()) {
                failures += "$case: after the restart, no Unknown notice for a send that has left the ledger; observed " +
                    stale.joinToString("; ") { (moment, seen) -> "$moment no send in the ledger, mark ${seen.mark}, notice \"${seen.notice}\"" }
            }
            if (delivered) {
                val text = before.first { it.id == probed }.text
                val again = sinceRestart.filter { it.id != probed && it.text == text }
                if (again.isNotEmpty()) {
                    failures += "$case: after the restart, no plain send of the delivered text under a new id with the draft unedited; " +
                        "observed $again, the store answering $outcome"
                }
            } else {
                note("NOT ASSERTED: no duplicate check, the server never took the probed text")
            }
        } finally {
            next.close()
            println(out)
        }
        if (failures.isNotEmpty()) throw AssertionError(failures.joinToString("\n") + "\n" + out)
    }

    @Test
    fun `A1 the pass finds an unknown send accepted and the process ends right after settleSend Sent took its entry out`() = guarded {
        lostSend()
        keeper()
        val end = ProcessEnd(kv, probed).also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { answer(200, ACCEPTED) })
        machine.welcome = true
        machine.closePeers()
        restartAndProbe("A1", endsHere(end, "the pass's settleSend Sent entry removal"), delivered = true)
    }

    @Test
    fun `A2 the pass completes an absent send under its own id, accepted, and the process ends right after settleSend Sent took its entry out`() = guarded {
        lostSend()
        keeper()
        val end = ProcessEnd(kv, probed).also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { answer(200, """{"status":"absent"}""") })
        machine.welcome = true
        machine.closePeers()
        restartAndProbe("A2", endsHere(end, "the pass's settleSend Sent entry removal after its completion"), delivered = true)
    }

    /**
     * The reachable form of B. An Unknown mark of an EARLIER send cannot still be set when an own send
     * settles: the store admits a plain send only when the ledger holds no send of the conversation
     * (Store.kt:692-696), and the own send's begin writes its own Unknown mark over the conversation's one
     * mark key before its write leaves (Reconnect.kt:374-382, :166-169; Ledger.kt:133). So the mark the
     * crash leaves here is that send's own begin mark.
     */
    @Test
    fun `B the composer's own send is accepted and the process ends right after finish's settleSend Sent took its entry out`() = guarded {
        keeper()
        composerHolds()
        routes(write = { answer(200, ACCEPTED) }, status = { answer(200, ACCEPTED) })
        val end = ProcessEnd(kv, probed).also { it.arm() }
        val send = scope.async { store.send(machineId, S1, TEXT, attachments = listOf(file)) }
        val left = endsHere(end, "finish's settleSend Sent entry removal")
        assertFalse("probe: the ended process's send never returned", send.isCompleted)
        restartAndProbe("B", left, delivered = true)
    }

    @Test
    fun `C the pass finds an unknown send rejected and the process ends right after settleSend Rejected took its entry out, before the Rejected mark`() = guarded {
        lostSend()
        keeper()
        val end = ProcessEnd(kv, probed).also { it.arm() }
        routes(write = { answer(200, ACCEPTED) }, status = { answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
        machine.welcome = true
        machine.closePeers()
        restartAndProbe("C", endsHere(end, "the pass's settleSend Rejected entry removal"), delivered = false)
    }

    @Test
    fun `D a Discard and the process ends right after discardUnknownSend took the entry out, before the mark's clear`() = guarded {
        lostSend()
        keeper()
        val end = ProcessEnd(kv, probed).also { it.arm() }
        val discard = scope.async { store.discardUnknown(machineId, S1, probed) }
        val left = endsHere(end, "discardUnknownSend's entry removal")
        assertFalse("probe: the ended process's Discard never returned", discard.isCompleted)
        restartAndProbe("D", left, delivered = false)
    }

    @Test
    fun `E the composer's own send is refused with a 403, Failed, and the process ends right after finish took its entry out, before the mark's clear`() = guarded {
        keeper()
        composerHolds()
        routes(write = { answer(403, """{"message":"This device may not write to that session."}""") }, status = { answer(200, ACCEPTED) })
        val end = ProcessEnd(kv, probed).also { it.arm() }
        val send = scope.async { store.send(machineId, S1, TEXT, attachments = listOf(file)) }
        val left = endsHere(end, "finish's entry removal on Failed")
        assertFalse("probe: the ended process's send never returned", send.isCompleted)
        restartAndProbe("E", left, delivered = false)
    }

    private companion object {
        const val S1 = "s1"
        const val TEXT = "hello"
        const val KEEPER = "m-ffffffffffffffffffffffff"
        const val ACCEPTED = """{"status":"accepted"}"""
    }
}

/** Every key the stores hold, copied under the map's own lock. */
private fun snapshot(kv: SyncKv): Map<String, String> = synchronized(kv.map) { LinkedHashMap(kv.map) }

/** The attachment draft as stored, decoded as ChatSession restores it (ChatSession.kt:82, :340-344). */
private fun filesOf(raw: String?): List<Attachment> =
    if (raw == null) emptyList() else (json(raw) as? JsonArray)?.mapNotNull { AttachmentJson.decode(it) }.orEmpty()
