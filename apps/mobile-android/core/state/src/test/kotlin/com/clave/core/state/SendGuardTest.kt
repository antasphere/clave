package com.clave.core.state

import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.UnknownSend
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
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
    private suspend fun Harness.lostSend(text: String = "hello"): SendOutcome.Unknown {
        routes(write = { answer(504, "{}") }, status = { _, _ -> answer(504, "{}") })
        drafts.set(machineId, "s1", text)
        val outcome = store.send(machineId, "s1", text)
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
        assertTrue(store.discardUnknown(machineId, "s1", id(1)))
        assertNull(marks.get(machineId, "s1"))
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { _, _ -> answer(200, """{"status":"absent"}""") })
        reconnect()
        assertEquals(listOf(id(1)), writtenIds())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
        assertFalse(store.discardUnknown(machineId, "s1", id(1)))
    }

    @Test
    fun `Send again while a reconnection is settling that send waits for it, and sends nothing once the pass completed it`() = guarded {
        lostSend()
        routes(write = { answer(200, """{"status":"accepted"}""") }, status = { asked, call -> if (asked == id(1)) machine.hold(call) else answer(200, """{"status":"accepted"}""") })
        machine.welcome = true
        machine.closePeers()
        until(20_000) { machine.held.size == 1 }
        val retry = scope.async { store.resend(machineId, "s1", id(1), "hello") }
        delay(500)
        assertEquals("nothing goes while the pass reconciles the same send", listOf(id(1)), writtenIds())
        machine.respond(0, answer(200, """{"status":"absent"}"""))
        assertEquals(SendOutcome.Failed(id(1), SETTLED_MEANWHILE), retry.await())
        assertEquals("only the original id reached the machine", listOf(id(1), id(1)), writtenIds())
        assertEquals(1, minted.get())
        assertEquals(emptyList<String>(), sends.list().map { it.clientMessageId })
    }

    private companion object {
        const val SENTINEL = "m-ffffffffffffffffffffffff"
    }
}
