package com.clave.core.transport

import com.clave.core.contract.SessionEvent
import com.clave.core.contract.SessionStream
import com.clave.core.contract.ServerEvent
import com.clave.core.contract.ServerEventEnvelope
import com.clave.core.devices.BuildKind
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** push.test.ts, against real sockets on MockWebServer's WebSocket upgrade, in real time. */
class ClavePushClientTest {
    private lateinit var hub: PushHub
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sockets = OkHttpWebSocketFactory(OkHttpClient())
    private val clients = mutableListOf<ClavePushClient>()

    @Before
    fun start() {
        hub = PushHub()
    }

    @After
    fun stop() {
        clients.forEach { it.close() }
        scope.cancel()
        hub.shutdown()
    }

    private fun client(
        token: String = TOKEN,
        livenessIntervalMs: Long = 60_000,
        livenessTimeoutMs: Long = 60_000,
    ) = ClavePushClient(
        url = hub.url,
        token = token,
        sockets = sockets,
        scope = scope,
        build = BuildKind.Development,
        clientName = "test",
        backoffBaseMs = 10,
        backoffMaxMs = 20,
        livenessIntervalMs = livenessIntervalMs,
        livenessTimeoutMs = livenessTimeoutMs,
    ).also { clients += it }

    private suspend fun expectPushError(block: suspend () -> Any?): PushError {
        try {
            block()
        } catch (e: PushError) {
            return e
        }
        fail("expected a PushError")
        throw AssertionError()
    }

    @Test
    fun `derives the socket URL from the base, a relay road included`() {
        assertEquals("ws://127.0.0.1:43201/push", pushUrlOf("http://127.0.0.1:43201"))
        assertEquals("ws://127.0.0.1:43201/push", pushUrlOf("http://127.0.0.1:43201/"))
        assertEquals("wss://relay.example/m/abc/push", pushUrlOf("https://relay.example/m/abc"))
        assertEquals("wss://relay.example/m/abc/push", pushUrlOf("https://relay.example/m/abc/"))
        assertEquals("wss://relay.example/m/abc/push", pushUrlOf("wss://relay.example/m/abc/push"))
    }

    @Test
    fun `a release build refuses a plain-http push address at construction`() {
        val error = runCatching {
            ClavePushClient(hub.url, TOKEN, sockets, scope, BuildKind.Release)
        }.exceptionOrNull() as ServerError
        assertEquals(ServerError.Kind.Policy, error.kind)
        assertEquals(0, hub.upgrades.get())
    }

    @Test
    fun `says hello with the token and the client name, is welcomed, and names the server`() = runBlocking {
        val c = client().connect()
        withTimeout(5_000) { c.whenOpen() }
        assertEquals(PushStatus.Open, c.status.value.status)
        assertEquals("srv", c.serverId)
        assertEquals("2.4.0", c.serverVersion)
        assertEquals(1, c.connections)
        assertJson("""{"_tag":"hello","token":"$TOKEN","client":"test"}""", hub.received[0].toString())
    }

    @Test
    fun `a refused token is final and never reconnects`() = runBlocking {
        val statuses = CopyOnWriteArrayList<PushState>()
        val c = client(token = "wrong")
        c.onStatus { statuses += it }
        c.connect()
        until { c.status.value.status == PushStatus.Closed }
        assertEquals(listOf(PushStatus.Connecting, PushStatus.Closed), statuses.map { it.status })
        assertEquals(PushStatusDetail.Final.Unauthorized, statuses.last().detail.final)
        assertEquals(4001, statuses.last().detail.code)
        assertTrue(expectPushError { c.whenOpen() }.message!!.contains("closed"))
        delay(300)
        assertEquals(1, hub.upgrades.get())
    }

    @Test
    fun `a revoked device session is final and never reconnects`() = runBlocking {
        val c = client().connect()
        withTimeout(5_000) { c.whenOpen() }
        hub.closeAll(4011, "revoked")
        until { c.status.value.status == PushStatus.Closed }
        assertEquals(PushStatusDetail.Final.Revoked, c.status.value.detail.final)
        assertEquals(4011, c.status.value.detail.code)
        delay(300)
        assertEquals(1, hub.upgrades.get())
        assertEquals(PushStatus.Closed, c.status.value.status)
    }

    @Test
    fun `subscribes, receives the record and the stream, and sees the exit`() = runBlocking {
        val c = client().connect()
        val streams = CopyOnWriteArrayList<SessionStream>()
        var exit: Int? = null
        c.subscribe("s1", { streams += it }, { exit = it })
        val record = withTimeout(5_000) { c.subscribed("s1") }
        assertEquals("s1", record.id)
        assertTrue(hub.received.any { it.toString() == """{"_tag":"subscribe","sessionId":"s1"}""" })
        hub.broadcast("""{"_tag":"stream","sessionId":"s1","stream":{"kind":"event","event":{"type":"assistant_text","delta":"hi","final":true}}}""")
        hub.broadcast("""{"_tag":"exit","sessionId":"s1","code":0}""")
        until { exit != null }
        assertEquals(listOf(SessionStream.Event(SessionEvent.AssistantText(delta = "hi", final = true))), streams.toList())
        assertEquals(0, exit)
    }

    @Test
    fun `stream frames reach only their session's listeners`() = runBlocking {
        val c = client().connect()
        val one = CopyOnWriteArrayList<SessionStream>()
        val other = CopyOnWriteArrayList<SessionStream>()
        c.subscribe("s1", { one += it })
        c.subscribe("s2", { other += it })
        withTimeout(5_000) { c.subscribed("s1") }
        hub.broadcast("""{"_tag":"stream","sessionId":"s3","stream":{"kind":"pty","data":"eA=="}}""")
        hub.broadcast("""{"_tag":"stream","sessionId":"s1","stream":{"kind":"pty","data":"aGk="}}""")
        until { one.isNotEmpty() }
        delay(100)
        assertEquals(listOf(SessionStream.Pty("aGk=")), one.toList())
        assertTrue(other.isEmpty())
    }

    @Test
    fun `an unknown session fails the subscription with the server's words and reaches errors`() = runBlocking {
        val c = client().connect()
        val errors = CopyOnWriteArrayList<Pair<String, String?>>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) { c.errors.collect { errors += it } }
        c.subscribe("nope", {})
        val error = expectPushError { withTimeout(5_000) { c.subscribed("nope") } }
        assertEquals("Unknown session", error.message)
        until { errors.isNotEmpty() }
        assertEquals("Unknown session" to "nope", errors[0])
    }

    @Test
    fun `a refusal that arrived before the barrier is awaited is kept, and the barrier throws it at once`() = runBlocking {
        val c = client().connect()
        val errors = CopyOnWriteArrayList<Pair<String, String?>>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) { c.errors.collect { errors += it } }
        c.subscribe("nope", {})
        until { errors.isNotEmpty() }
        val asked = System.currentTimeMillis()
        val error = expectPushError { withTimeout(5_000) { c.subscribed("nope") } }
        assertEquals("Unknown session", error.message)
        assertTrue("the barrier answered from the kept refusal, not from a timeout", System.currentTimeMillis() - asked < 1_000)
        assertEquals(listOf("Unknown session" to "nope"), errors.toList())
    }

    @Test
    fun `delivers server events, ignores frames it does not know, and survives junk`() = runBlocking {
        val c = client().connect()
        withTimeout(5_000) { c.whenOpen() }
        val events = CopyOnWriteArrayList<ServerEventEnvelope>()
        scope.launch(start = CoroutineStart.UNDISPATCHED) { c.events.collect { events += it } }
        hub.broadcast("""{"_tag":"request","requestId":"r","windowKey":"w","command":"x","payload":{}}""")
        hub.broadcast("""{"_tag":"brand-new-frame","x":1}""")
        hub.broadcast("not json at all")
        hub.broadcast("""{"_tag":"pong"}""")
        hub.broadcast("""{"_tag":"unsubscribed","sessionId":"s1"}""")
        hub.broadcast("""{"_tag":"event","id":"e1","seq":1,"at":1,"event":{"_tag":"requests.changed","revision":2}}""")
        until { events.size == 1 }
        assertEquals(ServerEventEnvelope("e1", 1, 1, ServerEvent.RequestsChanged(2)), events[0])
        assertEquals(PushStatus.Open, c.status.value.status)
        assertEquals(1, c.connections)
    }

    @Test
    fun `reconnects after a drop, subscribes every session again, and waits for the new acknowledgement`() = runBlocking {
        val c = client().connect()
        c.subscribe("s1", {})
        withTimeout(5_000) { c.subscribed("s1") }
        val statuses = CopyOnWriteArrayList<PushStatus>()
        val ackAtWelcome = CopyOnWriteArrayList<Any?>()
        c.onStatus { state ->
            statuses += state.status
            // Read the barrier synchronously in the welcome callback: the previous socket's
            // acknowledgement must already be gone.
            if (state.status == PushStatus.Open) ackAtWelcome += (c.acknowledged("s1") ?: "none")
        }
        hub.answerSubscriptions = false
        hub.closeAll(1012, "restart")
        until { c.connections == 2 && c.status.value.status == PushStatus.Open }
        assertTrue(statuses.contains(PushStatus.Reconnecting))
        assertEquals(listOf<Any?>("none"), ackAtWelcome.toList())
        until { hub.tags().count { it == "subscribe" } == 2 }
        assertNull(c.acknowledged("s1"))
        val waiting = async { c.subscribed("s1", 5_000) }
        delay(100)
        assertTrue(!waiting.isCompleted)
        hub.broadcast("""{"_tag":"subscribed","sessionId":"s1","session":$SESSION_JSON}""")
        assertEquals("s1", withTimeout(5_000) { waiting.await() }.id)
        assertEquals(2, hub.upgrades.get())
    }

    @Test
    fun `pings once open and closes a socket that answers nothing`() = runBlocking {
        val c = client(livenessIntervalMs = 50, livenessTimeoutMs = 50).connect()
        withTimeout(5_000) { c.whenOpen() }
        until { hub.tags().contains("ping") }
        assertTrue(c.pings >= 1)
        assertEquals(PushStatus.Open, c.status.value.status)
        hub.answerPings = false
        val connections = c.connections
        until { c.connections > connections && c.status.value.status == PushStatus.Open }
        assertEquals(PushStatus.Open, c.status.value.status)
    }

    @Test
    fun `close ends everything and fails the waiters`() = runBlocking {
        val c = client().connect()
        hub.answerSubscriptions = false
        c.subscribe("s1", {})
        val waiting = async { runCatching { c.subscribed("s1") }.exceptionOrNull()?.message }
        delay(50)
        c.close()
        assertEquals(PushStatus.Closed, c.status.value.status)
        assertEquals(PushStatusDetail.Final.Closed, c.status.value.detail.final)
        assertTrue(withTimeout(5_000) { waiting.await() }!!.contains("closed"))
        assertTrue(runCatching { c.connect() }.exceptionOrNull()!!.message!!.contains("closed"))
    }

    @Test
    fun `finished subscriptions still allow a reconnect snapshot barrier`() = runBlocking {
        val c = client().connect()
        c.subscribe("s1", {})
        withTimeout(5_000) { c.subscribed("s1") }
        hub.broadcast("""{"_tag":"exit","sessionId":"s1","code":0}""")
        delay(50)
        hub.closeAll(1001, "test reconnect")
        until { c.connections >= 2 && c.status.value.status == PushStatus.Open }
        assertEquals("s1", withTimeout(2_000) { c.subscribed("s1") }.id)
    }

    @Test
    fun `bounds a missing subscription acknowledgement and still takes a later one`() = runBlocking {
        hub.answerSubscriptions = false
        val c = client().connect()
        c.subscribe("s1", {})
        val error = expectPushError { c.subscribed("s1", 0) }
        assertTrue(error.message!!.contains("acknowledge"))
        until { hub.tags().contains("subscribe") }
        val bounded = expectPushError { c.subscribed("s1", 100) }
        assertTrue(bounded.message!!.contains("acknowledge"))
        val acknowledged = async { c.subscribed("s1") }
        delay(50)
        hub.broadcast("""{"_tag":"subscribed","sessionId":"s1","session":$SESSION_JSON}""")
        assertEquals("s1", withTimeout(5_000) { acknowledged.await() }.id)
    }

    @Test
    fun `the last listener leaving unsubscribes on the server`() = runBlocking {
        val c = client().connect()
        val stop = c.subscribe("s1", {})
        withTimeout(5_000) { c.subscribed("s1") }
        stop()
        until { hub.tags().contains("unsubscribe") }
        assertTrue(expectPushError { c.subscribed("s1") }.message!!.contains("Not subscribed"))
    }
}
