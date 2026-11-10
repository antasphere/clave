package com.clave.core.state

import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UNKNOWN_SENDS_KEY
import com.clave.core.chat.UnknownSend
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A send whose answer was lost, at the store's boundary with the machine (a MockWebServer):
 * while its outcome is unknown, a plain send mints no second id and writes nothing; the
 * reconnection pass settles the original id (accepted, absent then completed once, or still
 * unknown); the person's explicit "Send again" and "Discard" leave nothing that a later pass
 * replays, even when the choice lands while a pass is reconciling that same send.
 */
class SendGuardTest {
    private val minted = AtomicInteger()

    private fun id(n: Int) = "m-%024x".format(n)

    /** A store on a machine whose push hub does not welcome yet, so no pass runs until [reconnect]. */
    private fun guarded(block: suspend Harness.() -> Unit) {
        val h = Harness(mint = { id(minted.incrementAndGet()) })
        h.machine.welcome = false
        try {
            runBlocking { h.start().block() }
        } finally {
            h.close()
        }
    }

    private fun Harness.writtenIds(): List<String> = machine.calls.filter { it.method == "POST" && it.path == "/sessions/write" }.map {
        json(it.body).jsonObject["input"]!!.jsonObject["clientMessageId"]!!.jsonPrimitive.content
    }

    private fun Harness.askedIds(): List<String> = machine.calls.filter { it.path == "/sessions/writes" }.map { it.query["clientMessageId"] ?: "" }

    /** The machine answers every route; the write and its status as the test says. */
    private fun Harness.routes(write: (Call) -> MockResponse, status: (id: String, Call) -> MockResponse) {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> write(call)
                "/sessions/writes" -> if (call.query["clientMessageId"] == SENTINEL) answer(200, """{"status":"accepted"}""") else status(call.query["clientMessageId"] ?: "", call)
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
    }

    /** The first send's answer is lost and its status cannot be asked: its outcome is unknown. */
    private suspend fun Harness.lostSend(text: String = "hello", session: String = "s1"): SendOutcome.Unknown {
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(504, "{}") })
        drafts.set(machineId, session, text)
        val outcome = store.send(machineId, session, text)
        assertTrue("the first send ends unknown: $outcome", outcome is SendOutcome.Unknown)
        return outcome as SendOutcome.Unknown
    }

    /**
     * The push channel opens again, which runs the reconnection pass; it returns once the pass
     * has settled a sentinel send of another conversation, placed after every send of this
     * test in the ledger, so every send before it has been reconciled by then.
     */
    private suspend fun Harness.reconnect() {
        sends.add(UnknownSend(machineId, "s9", SENTINEL, "sentinel", clock.nowMs))
        machine.welcome = true
        machine.closePeers()
        until(20_000) { runBlocking { sends.list().none { it.clientMessageId == SENTINEL } } }
    }

    @Test
    fun `while a send is in flight a plain send mints no id and writes nothing`() = guarded {
        routes(write = { call -> machine.hold(call) }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        drafts.set(machineId, "s1", "first")
        val first = scope.async { store.send(machineId, "s1", "first") }
        until { machine.held.size == 1 }
        val second = store.send(machineId, "s1", "second")
        assertEquals(SendOutcome.Failed(id(1), STILL_SENDING), second)
        assertEquals(1, minted.get())
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertEquals(SendOutcome.Sent(id(1), reconciled = false), first.await())
        assertEquals(listOf(id(1)), writtenIds())
    }

    @Test
    fun `two sends to one conversation at once, the first held just before its ledger entry lands, give one id and one write`() = guarded {
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        val paused = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        kv.beforeSet = { key ->
            if (key == UNKNOWN_SENDS_KEY && paused.complete(Unit)) gate.await()
        }
        val first = scope.async { store.send(machineId, "s1", "first") }
        paused.await()
        // The first send has passed its checks and minted its id; its ledger entry is not written yet.
        val second = scope.async { store.send(machineId, "s1", "second") }
        withTimeoutOrNull(1_000) { second.await() }
        val mintedWhileHeld = minted.get()
        gate.complete(Unit)
        val firstOutcome = first.await()
        val secondOutcome = second.await()
        assertEquals("no second id is minted while the first send is being admitted", 1, mintedWhileHeld)
        assertEquals(SendOutcome.Sent(id(1), reconciled = false), firstOutcome)
        assertEquals(SendOutcome.Failed("", STILL_SENDING), secondOutcome)
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(1, minted.get())
    }

    @Test
    fun `two conversations each send at once and both are admitted`() = guarded {
        routes(
            write = { call ->
                if (json(call.body).jsonObject["id"]!!.jsonPrimitive.content == "s1") machine.hold(call) else answer(200, """{"status":"accepted"}""")
            },
            status = { _, _ -> answer(200, """{"status":"accepted"}""") },
        )
        val first = scope.async { store.send(machineId, "s1", "to the first") }
        until { machine.held.size == 1 }
        // The first conversation's send holds its claim, its write in flight; the second's is its own.
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), store.send(machineId, "s2", "to the second"))
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertEquals(SendOutcome.Sent(id(1), reconciled = false), first.await())
        assertEquals(setOf(id(1), id(2)), writtenIds().toSet())
    }

    @Test
    fun `a send cancelled after its ledger entry is written stays unknown, frees its claim, and the next reconnection settles the same id`() = guarded {
        routes(write = { call -> machine.hold(call) }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        drafts.set(machineId, "s1", "hello")
        val first = scope.async { store.send(machineId, "s1", "hello") }
        until { machine.held.size == 1 }
        first.cancelAndJoin()
        // The write may have landed: the entry, its unknown mark and the draft stay; it is no longer in flight.
        assertEquals(listOf(id(1)), sends.list().map { it.clientMessageId })
        assertFalse("a cancelled send is not in flight any more", delivery!!.inFlight(id(1)))
        assertEquals(DeliveryMark.Kind.Unknown, marks.get(machineId, "s1")!!.kind)
        assertEquals("hello", drafts.get(machineId, "s1"))
        // The claim came back: a plain send is refused for the unknown entry, not as still sending.
        assertEquals(SendOutcome.Failed(id(1), DELIVERY_UNKNOWN_FIRST), store.send(machineId, "s1", "hello"))
        machine.respond(0, answer(503, "{}"))
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals("the same id, completed once by the pass", listOf(id(1), id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertEquals("", drafts.get(machineId, "s1"))
        assertEquals("no other id was minted", 1, minted.get())
    }

    @Test
    fun `the claim comes back after nothing to send and after a refusal`() = guarded {
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        assertEquals("Nothing to send.", (store.send(machineId, "s1", "   ") as SendOutcome.Failed).reason)
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), store.send(machineId, "s1", "after nothing"))
        lostSend("lost")
        assertEquals(SendOutcome.Failed(id(3), DELIVERY_UNKNOWN_FIRST), store.send(machineId, "s1", "refused"))
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        assertEquals(SendOutcome.Sent(id(4), reconciled = false), store.resend(machineId, "s1", id(3), "lost"))
    }

    @Test
    fun `while a send's outcome is unknown a plain send mints no id, writes nothing and leaves the draft`() = guarded {
        val unknown = lostSend()
        assertEquals(id(1), unknown.clientMessageId)
        val again = store.send(machineId, "s1", "hello")
        assertEquals(SendOutcome.Failed(id(1), DELIVERY_UNKNOWN_FIRST), again)
        val other = store.send(machineId, "s1", "something else")
        assertEquals(SendOutcome.Failed(id(1), DELIVERY_UNKNOWN_FIRST), other)
        assertEquals("no second id was minted", 1, minted.get())
        assertEquals("no second write was queued", listOf(id(1)), writtenIds())
        assertEquals(listOf(id(1)), sends.list().map { it.clientMessageId })
        assertEquals("hello", drafts.get(machineId, "s1"))
        assertEquals(DeliveryMark.Kind.Unknown, marks.get(machineId, "s1")!!.kind)
    }

    @Test
    fun `a reconnection finds the lost send accepted and settles it under its own id without a second write`() = guarded {
        lostSend()
        routes(write = { answer(500, "{}") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        reconnect()
        assertEquals("the original id is the one asked", id(1), askedIds().last { it != SENTINEL })
        assertEquals("nothing written again", listOf(id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertEquals("", drafts.get(machineId, "s1"))
        assertNull(marks.get(machineId, "s1"))
        assertEquals(1, minted.get())
        // Settled: the next message goes, under the next id.
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), store.send(machineId, "s1", "next"))
    }

    @Test
    fun `a reconnection completes an absent send once under its own id`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals("the lost write, then its completion under the same id", listOf(id(1), id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertEquals("", drafts.get(machineId, "s1"))
        assertEquals(1, minted.get())
    }

    @Test
    fun `a reconnection that cannot tell sends nothing and the conversation still takes no new message`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"unknown","reason":"The server lost track."}""") })
        reconnect()
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(listOf(id(1)), sends.list().map { it.clientMessageId })
        assertEquals("The server lost track.", marks.get(machineId, "s1")!!.reason)
        assertEquals(SendOutcome.Failed(id(1), DELIVERY_UNKNOWN_FIRST), store.send(machineId, "s1", "hello"))
        assertEquals(1, minted.get())
        assertEquals("hello", drafts.get(machineId, "s1"))
    }

    @Test
    fun `Send again discards the unknown id, so no later reconnection replays it, and the text goes under a new id`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        val retried = store.resend(machineId, "s1", id(1), "hello")
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), retried)
        reconnect()
        assertEquals("the old id never replays", listOf(id(1), id(2)), writtenIds())
        assertFalse("the old id is never asked about again", askedIds().drop(1).contains(id(1)))
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `Discard leaves nothing a later reconnection replays`() = guarded {
        lostSend()
        assertEquals(DeliveryController.DiscardResult.Discarded, store.discardUnknown(machineId, "s1", id(1)))
        assertNull(marks.get(machineId, "s1"))
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertEquals(DeliveryController.DiscardResult.NothingToDiscard, store.discardUnknown(machineId, "s1", id(1)))
    }

    @Test
    fun `Send again while a reconnection asks about that send stops its completion and goes under a new id`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val retry = scope.async { store.resend(machineId, "s1", id(1), "hello") }
        delay(500)
        assertEquals("nothing goes while the pass reconciles the same send", listOf(id(1)), writtenIds())
        // Absent: the pass would complete the first id, but the person's choice came first.
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        assertEquals(SendOutcome.Sent(id(2), reconciled = false), awaitGate("the Send again", retry))
        assertEquals("the first id is never completed after the choice", listOf(id(1), id(2)), writtenIds())
        assertEquals(2, minted.get())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `Discard while a reconnection asks about that send means the pass never completes it`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        assertEquals(DeliveryController.DiscardResult.Discarded, awaitGate("the discard", discard))
        delay(500)
        assertEquals("nothing is written after the press", listOf(id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertNull(marks.get(machineId, "s1"))
    }

    @Test
    fun `Discard while a reconnection asks about that send, the server answering accepted, is said delivered`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        // The first write had landed after all: the server's answer stands over the press.
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertEquals(DeliveryController.DiscardResult.AlreadyDelivered, awaitGate("the discard", discard))
        assertEquals("nothing written again", listOf(id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertEquals("delivered, the draft goes", "", drafts.get(machineId, "s1"))
    }

    @Test
    fun `Discard of another conversation's send the pass has not reached means it is never reconciled`() = guarded {
        lostSend()
        lostSend(session = "s2")
        // Its own lost send asked about it once already; the pass must not ask again.
        val askedBefore = askedIds().count { it == id(2) }
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"absent"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val discard = scope.async { store.discardUnknown(machineId, "s2", id(2)) }
        delay(500)
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        assertEquals(DeliveryController.DiscardResult.Discarded, awaitGate("the discard", discard))
        until(what = "the pass to settle the first send") { runBlocking { sends.list().isEmpty() } }
        assertEquals("the first completed under its own id, the discarded one never again", listOf(id(1), id(2), id(1)), writtenIds())
        assertEquals("the pass never asks about the discarded send", askedBefore, askedIds().count { it == id(2) })
    }

    @Test
    fun `Discard once the completion has left is refused as being completed, and the send arrives`() = guarded {
        lostSend()
        routes(write = { call -> machine.hold(call) }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000, what = "the pass's same-id completion to leave") { machine.held.size == 1 }
        assertEquals(DeliveryController.DiscardResult.BeingCompleted, store.discardUnknown(machineId, "s1", id(1)))
        assertEquals(SendOutcome.Failed(id(1), BEING_COMPLETED), store.resend(machineId, "s1", id(1), "hello"))
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        until(what = "the pass to settle the completion") { runBlocking { sends.list().isEmpty() } }
        assertEquals(listOf(id(1), id(1)), writtenIds())
        assertEquals("delivered, the draft goes", "", drafts.get(machineId, "s1"))
        assertEquals(1, minted.get())
    }

    @Test
    fun `Send again and Discard after the pass delivered say it had arrived and send nothing`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        reconnect()
        assertEquals(SendOutcome.Sent(id(1), reconciled = true), store.resend(machineId, "s1", id(1), "hello"))
        assertEquals(DeliveryController.DiscardResult.AlreadyDelivered, store.discardUnknown(machineId, "s1", id(1)))
        assertEquals("nothing more reached the machine", listOf(id(1)), writtenIds())
        assertEquals(1, minted.get())
        assertEquals("", drafts.get(machineId, "s1"))
    }

    @Test
    fun `Discard while the send's own write is in flight is refused, and the send goes on`() = guarded {
        routes(write = { call -> machine.hold(call) }, status = { _, _ -> answer(200, """{"status":"accepted"}""") })
        drafts.set(machineId, "s1", "first")
        val first = scope.async { store.send(machineId, "s1", "first") }
        until(what = "the first send's write to leave") { machine.held.size == 1 }
        assertEquals(DeliveryController.DiscardResult.InFlight, store.discardUnknown(machineId, "s1", id(1)))
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertEquals(SendOutcome.Sent(id(1), reconciled = false), awaitGate("the first send", first))
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `a reconnection reads the ledger only once it holds the machine's lock, after a discard that held it`() = guarded {
        lostSend()
        lostSend(session = "s2")
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        // The discard's ledger write under the lock, the one that takes its send out (its record went in
        // before the lock), is held there while the pass starts and waits for the lock.
        val holding = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        kv.beforeWrite = { key, value ->
            if (key == UNKNOWN_SENDS_KEY && !value.contains(id(1)) && !holding.isCompleted) {
                holding.complete(Unit)
                release.await()
            }
        }
        // Nothing else reads the ledger while that write is held: a read then is the pass's, before its lock.
        val readsWhileHeld = AtomicInteger()
        kv.beforeGet = { key -> if (key == UNKNOWN_SENDS_KEY && holding.isCompleted && !release.isCompleted) readsWhileHeld.incrementAndGet() }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        awaitGate("the discard's ledger write under the lock", holding)
        machine.welcome = true
        machine.closePeers()
        until(what = "the push channel to open again") { machine.upgrades.get() >= 2 }
        delay(500)
        release.complete(Unit)
        assertEquals(DeliveryController.DiscardResult.Discarded, awaitGate("the discard", discard))
        until(what = "the pass to settle the other send") { runBlocking { sends.list().isEmpty() } }
        assertEquals("the pass read nothing of the ledger while the discard held the lock", 0, readsWhileHeld.get())
        assertEquals("the discarded send is never written again", listOf(id(1), id(2), id(2)), writtenIds())
    }

    @Test
    fun `a Discard cancelled while it waits for the pass is carried through, and no later pass delivers the send`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        // The screen closes while the discard waits for the pass.
        discard.cancel()
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        until(what = "the cancelled discard to be carried through") { runBlocking { sends.list().isEmpty() } }
        reconnect()
        assertEquals("never written after the press, nor by a later pass", listOf(id(1)), writtenIds())
        assertNull(marks.get(machineId, "s1"))
    }

    /** A second controller and store over this harness's durable stores, on the same machine stand-in. */
    private fun Harness.overSameStores(): Harness =
        Harness(machine = machine, mint = { id(minted.incrementAndGet()) }, kv = kv, ownsMachine = false)

    /**
     * The person presses Discard while a reconnection pass asks about the lost send, and the
     * process ends there: the pass's question is never answered and the Discard, waiting for the
     * pass, never goes on; the process's sockets go with it. What it leaves is what is in [Harness.kv].
     */
    private suspend fun Harness.discardThenTheProcessEnds(): Deferred<DeliveryController.DiscardResult?> {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000, what = "the pass to ask about the lost send") { machine.held.size == 1 }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        assertFalse("the Discard waits for the pass", discard.isCompleted)
        store.disconnectAll()
        return discard
    }

    /** The next controller's store connects, which runs its first pass; it returns once that pass settled a sentinel placed last. */
    private suspend fun Harness.firstPass() {
        sends.add(UnknownSend(machineId, "s9", SENTINEL, "sentinel", clock.nowMs))
        store.connect(machineId)
        until(20_000, what = "the first pass of the next controller") { runBlocking { sends.list().none { it.clientMessageId == SENTINEL } } }
    }

    /**
     * After [discardThenTheProcessEnds], a controller and store rebuilt over the same durable stores
     * run their first pass against a machine that answers [status] about the discarded send. This
     * proves recreation from what the stores hold, as a process death leaves them; not an OS restart
     * (in the app two PreferencesKeyValueStore wrappers share one process-wide store) and not a power
     * loss. The ledger entry, the mark and the draft are separate writes, not one transaction.
     */
    private suspend fun Harness.nextProcessFindsTheDiscard(status: (Call) -> MockResponse) {
        val discard = discardThenTheProcessEnds()
        val askedBefore = askedIds().count { it == id(1) }
        val next = overSameStores()
        try {
            next.start()
            routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) status(call) else answer(200, """{"status":"accepted"}""") })
            next.firstPass()
            assertEquals("the discarded message is never written again", listOf(id(1)), writtenIds())
            assertEquals("the send leaves the ledger", emptyList<String>(), next.sends.list().map { it.clientMessageId })
            assertNull("its mark is cleared", next.marks.get(machineId, "s1"))
            assertNull("the screen reads no send of unknown delivery for the conversation", next.delivery!!.unsettled(machineId, "s1"))
            assertEquals("the next controller never asks about the discarded send", askedBefore, askedIds().count { it == id(1) })
            assertFalse("the ended process's Discard never went on", discard.isCompleted)
            assertEquals("the conversation takes the next message", SendOutcome.Sent(id(2), reconciled = false), next.store.send(machineId, "s1", "next"))
        } finally {
            next.close()
        }
    }

    @Test
    fun `a Discard waiting on the pass when the process ends is carried out by the next controller, which never sends the message, the server answering absent`() = guarded {
        nextProcessFindsTheDiscard { answer(200, """{"status":"absent"}""") }
    }

    @Test
    fun `a Discard waiting on the pass when the process ends is carried out by the next controller, which never sends the message, the server answering pending then absent`() = guarded {
        val asks = AtomicInteger()
        nextProcessFindsTheDiscard { if (asks.getAndIncrement() == 0) answer(200, """{"status":"pending"}""") else answer(200, """{"status":"absent"}""") }
    }

    @Test
    fun `a Discard through another controller over the same stores while that controller's pass asks about the send means the pass never completes it`() = guarded {
        lostSend()
        // Two services of one owner at once (a screen rebuilt, a boot after a sign-in): this one's push
        // channel never opened, so it runs no pass; the other's runs one.
        val other = overSameStores()
        try {
            other.start()
            routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
            machine.welcome = true
            other.sends.add(UnknownSend(machineId, "s9", SENTINEL, "sentinel", clock.nowMs))
            other.store.connect(machineId)
            until(20_000, what = "the other controller's pass to ask about the send") { machine.held.size == 1 }
            assertEquals(DeliveryController.DiscardResult.Discarded, store.discardUnknown(machineId, "s1", id(1)))
            machine.respond(0, answer(200, """{"status":"absent"}"""))
            until(20_000, what = "the other controller's pass to end") { runBlocking { sends.list().none { it.clientMessageId == SENTINEL } } }
            assertEquals("the discarded message is never written again", listOf(id(1)), writtenIds())
            assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
            assertNull("no mark is left for the conversation", marks.get(machineId, "s1"))
        } finally {
            other.close()
        }
    }

    /** The store throws on the next write of the ledger, as a store whose disk refuses it would: the Discard's record. */
    private fun Harness.failTheNextLedgerWrite() {
        val failed = AtomicBoolean()
        kv.beforeSet = { key -> if (key == UNKNOWN_SENDS_KEY && failed.compareAndSet(false, true)) throw IOException("The disk refused the write.") }
    }

    @Test
    fun `a Discard or Send again whose record the store fails to write changes nothing and says so, and the pass completes the send once under its own id`() = guarded {
        lostSend()
        val mark = marks.get(machineId, "s1")
        failTheNextLedgerWrite()
        assertEquals(DeliveryController.DiscardResult.NotSaved, store.discardUnknown(machineId, "s1", id(1)))
        failTheNextLedgerWrite()
        assertEquals(SendOutcome.Failed(id(1), CHOICE_NOT_SAVED), store.resend(machineId, "s1", id(1), "hello"))
        assertEquals("the send still waits, its discard not recorded", listOf(id(1) to false), sends.list().map { it.clientMessageId to it.discarded })
        assertEquals("its mark stays", mark, marks.get(machineId, "s1"))
        assertEquals("no other id was minted", 1, minted.get())
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals("the same id, completed once by the pass", listOf(id(1), id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `a Discard whose record fails while a pass asks about the send answers once the pass let go, and the pass left the send as it was`() = guarded {
        lostSend()
        val mark = marks.get(machineId, "s1")
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        failTheNextLedgerWrite()
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        assertFalse("the answer waits for the pass", discard.isCompleted)
        // Absent: the press held the completion back while it waited; it is not sent now.
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        assertEquals(DeliveryController.DiscardResult.NotSaved, awaitGate("the discard", discard))
        assertEquals("nothing was written while the press held the send", listOf(id(1)), writtenIds())
        assertEquals(listOf(id(1) to false), sends.list().map { it.clientMessageId to it.discarded })
        assertEquals("the pass left the send's mark as it was", mark, marks.get(machineId, "s1"))
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals("the next pass completes the same id once", listOf(id(1), id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `Discard while the server answers pending stops the pass's polling at once`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call ->
            if (asked == id(1) && machine.held.isEmpty()) machine.hold(call) else answer(200, """{"status":"pending"}""")
        })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val asked = askedIds().count { it == id(1) }
        val discard = scope.async { store.discardUnknown(machineId, "s1", id(1)) }
        delay(500)
        machine.respond(0, answer(200, """{"status":"pending"}"""))
        assertEquals(DeliveryController.DiscardResult.Discarded, awaitGate("the discard", discard))
        assertEquals("no question about it after the press", asked, askedIds().count { it == id(1) })
        assertEquals(listOf(id(1)), writtenIds())
    }

    @Test
    fun `a completion whose answer was lost releases its claim, so a later Discard discards`() = guarded {
        lostSend()
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals("the same id completed once, its answer lost", listOf(id(1), id(1)), writtenIds())
        assertEquals(DeliveryController.DiscardResult.Discarded, store.discardUnknown(machineId, "s1", id(1)))
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    @Test
    fun `Send again on a send no longer waiting sends nothing and says so`() = guarded {
        lostSend()
        assertEquals(DeliveryController.DiscardResult.Discarded, store.discardUnknown(machineId, "s1", id(1)))
        assertEquals(SendOutcome.Failed(id(1), NOTHING_WAITING), store.resend(machineId, "s1", id(1), "hello"))
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(1, minted.get())
    }

    @Test
    fun `Send again on a send the server refused sends nothing and says the refusal`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"rejected","reason":"The session is closed."}""") })
        reconnect()
        val again = store.resend(machineId, "s1", id(1), "hello")
        assertTrue("$again", again is SendOutcome.Rejected && again.clientMessageId == id(1))
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(1, minted.get())
    }

    private companion object {
        const val SENTINEL = "m-ffffffffffffffffffffffff"
    }
}
