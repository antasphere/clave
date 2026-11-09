package com.clave.core.transport

import com.clave.core.devices.BuildKind
import com.clave.core.ports.WebSocketEvents
import com.clave.core.ports.WebSocketFactory
import com.clave.core.ports.WebSocketPort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The timers of the push client on virtual time, over a scripted socket: the liveness ping,
 *  its deadline, the backoff, and the final closes. */
@OptIn(ExperimentalCoroutinesApi::class)
class ClavePushLivenessTest {
    private class FakeSocket(val events: WebSocketEvents) : WebSocketPort {
        val sent = mutableListOf<String>()
        var closedWith: Pair<Int, String>? = null
        override fun send(text: String): Boolean = sent.add(text)
        override fun close(code: Int, reason: String) {
            closedWith = code to reason
        }
        fun tags(): List<String> = sent.map { Regex("\"_tag\":\"([^\"]+)\"").find(it)!!.groupValues[1] }
    }

    private class FakeSockets(val synchronousOpen: Boolean = false) : WebSocketFactory {
        val opened = mutableListOf<FakeSocket>()
        override fun open(url: String, events: WebSocketEvents): WebSocketPort {
            val socket = FakeSocket(events)
            opened += socket
            if (synchronousOpen) events.onOpen()
            return socket
        }
    }

    private val welcome = """{"_tag":"welcome","serverId":"srv","protocol":1}"""

    private fun TestScope.client(sockets: FakeSockets, scope: CoroutineScope = backgroundScope) =
        ClavePushClient("http://127.0.0.1:43201", TOKEN, sockets, scope, BuildKind.Development, random = { 0.0 })

    private fun TestScope.openClient(sockets: FakeSockets): ClavePushClient {
        val c = client(sockets).connect()
        sockets.opened.last().events.onOpen()
        sockets.opened.last().events.onMessage(welcome)
        runCurrent()
        assertEquals(PushStatus.Open, c.status.value.status)
        return c
    }

    @Test
    fun `twenty seconds of silence send a ping, ten more without an answer close with 4000 and reconnect`() = runTest {
        val sockets = FakeSockets()
        val c = openClient(sockets)
        val first = sockets.opened[0]
        assertEquals(listOf("hello"), first.tags())

        advanceTimeBy(19_999)
        runCurrent()
        assertEquals(listOf("hello"), first.tags())
        advanceTimeBy(2)
        runCurrent()
        assertEquals(listOf("hello", "ping"), first.tags())
        assertEquals(1, c.pings)

        advanceTimeBy(9_998)
        runCurrent()
        assertNull(first.closedWith)
        advanceTimeBy(3)
        runCurrent()
        assertEquals(CLOSE_LIVENESS to "no pong", first.closedWith)
        assertEquals(PushStatus.Reconnecting, c.status.value.status)
        assertEquals(CLOSE_LIVENESS, c.status.value.detail.code)
        assertEquals(1, c.status.value.detail.attempt)

        // The first backoff: 250 ms halved by the jitter's floor.
        // The pong deadline ran at 30 000 ms; it is now 30 002, the reopen is due at 30 125.
        advanceTimeBy(120)
        runCurrent()
        assertEquals(1, sockets.opened.size)
        advanceTimeBy(5)
        runCurrent()
        assertEquals(2, sockets.opened.size)
        val second = sockets.opened[1]
        second.events.onOpen()
        second.events.onMessage(welcome)
        assertEquals(PushStatus.Open, c.status.value.status)
        assertEquals(2, c.connections)
        // The dead socket's late close changes nothing.
        first.events.onClosed(4000, "no pong")
        assertEquals(PushStatus.Open, c.status.value.status)
    }

    @Test
    fun `any frame received re-arms the ping`() = runTest {
        val sockets = FakeSockets()
        val c = openClient(sockets)
        val socket = sockets.opened[0]
        advanceTimeBy(15_000)
        socket.events.onMessage("""{"_tag":"event","id":"e1","seq":1,"at":1,"event":{"_tag":"anything.new"}}""")
        advanceTimeBy(19_999)
        runCurrent()
        assertEquals(0, c.pings)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(1, c.pings)
        // The pong withdraws the deadline.
        advanceTimeBy(1_000)
        socket.events.onMessage("""{"_tag":"pong"}""")
        advanceTimeBy(15_000)
        runCurrent()
        assertNull(socket.closedWith)
        assertEquals(PushStatus.Open, c.status.value.status)
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(2, c.pings)
    }

    @Test
    fun `the backoff doubles up to its ceiling and a welcome resets it`() = runTest {
        val sockets = FakeSockets()
        val c = client(sockets).connect()
        val attempts = mutableListOf<Int?>()
        c.onStatus { if (it.status == PushStatus.Reconnecting && it.detail.code != null) attempts += it.detail.attempt }
        val waits = mutableListOf<Long>()
        repeat(7) {
            val before = sockets.opened.size
            sockets.opened.last().events.onClosed(1012, "restart")
            val start = testScheduler.currentTime
            while (sockets.opened.size == before) {
                advanceTimeBy(1)
                runCurrent()
            }
            waits += testScheduler.currentTime - start
        }
        // 250 * 2^(n-1), capped at 10 s, times the jitter floor of one half.
        assertEquals(listOf(125L, 250L, 500L, 1_000L, 2_000L, 4_000L, 5_000L), waits)
        assertEquals(listOf<Int?>(1, 2, 3, 4, 5, 6, 7), attempts)
        sockets.opened.last().events.onOpen()
        sockets.opened.last().events.onMessage(welcome)
        sockets.opened.last().events.onClosed(1012, "restart")
        assertEquals(1, c.status.value.detail.attempt)
    }

    @Test
    fun `a failure without a close frame reconnects`() = runTest {
        val sockets = FakeSockets()
        val c = openClient(sockets)
        sockets.opened[0].events.onFailure(java.io.IOException("reset"))
        assertEquals(PushStatus.Reconnecting, c.status.value.status)
        advanceTimeBy(200)
        runCurrent()
        assertEquals(2, sockets.opened.size)
    }

    @Test
    fun `4001 and 4011 are final on virtual time too`() = runTest {
        for ((code, final) in listOf(4001 to PushStatusDetail.Final.Unauthorized, 4011 to PushStatusDetail.Final.Revoked)) {
            val sockets = FakeSockets()
            val c = openClient(sockets)
            c.subscribe("s1", {})
            val waiting = async { runCatching { c.subscribed("s1") }.exceptionOrNull() }
            runCurrent()
            sockets.opened[0].events.onClosed(code, "bye")
            assertEquals(PushStatus.Closed, c.status.value.status)
            assertEquals(final, c.status.value.detail.final)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, sockets.opened.size)
            assertTrue(waiting.await() is PushError)
        }
    }

    @Test
    fun `a socket that opens before open returns still says hello`() = runTest {
        val sockets = FakeSockets(synchronousOpen = true)
        val c = client(sockets).connect()
        assertEquals(listOf("hello"), sockets.opened[0].tags())
        assertEquals(1, c.connections)
        assertFalse(sockets.opened[0].sent[0].contains("\"client\""))
    }

    @Test
    fun `subscribed times out on virtual time without the acknowledgement`() = runTest {
        val sockets = FakeSockets()
        val c = openClient(sockets)
        c.subscribe("s1", {})
        assertEquals(listOf("hello", "subscribe"), sockets.opened[0].tags())
        val waiting = async { runCatching { c.subscribed("s1") }.exceptionOrNull() }
        advanceTimeBy(9_999)
        runCurrent()
        assertFalse(waiting.isCompleted)
        advanceTimeBy(2)
        runCurrent()
        assertTrue((waiting.await() as PushError).message!!.contains("acknowledge"))
    }
}
