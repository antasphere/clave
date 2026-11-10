package com.clave.core.state

import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMarks
import com.clave.core.chat.Drafts
import com.clave.core.chat.Entry
import com.clave.core.chat.UnknownSends
import com.clave.core.contract.MachinePlatform
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.Machine
import com.clave.core.devices.MachineSource
import com.clave.core.devices.SecureCredentialStore
import com.clave.core.ports.Clock
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.SecureStore
import com.clave.core.transport.OkHttpPort
import com.clave.core.transport.OkHttpWebSocketFactory
import java.net.InetAddress
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.fail

internal const val TOKEN = "tok-state-fixture"

internal fun json(text: String): JsonElement = Json.parseToJsonElement(text)

internal fun answer(status: Int, body: String): MockResponse =
    MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

internal fun sessionJson(id: String, workspaceId: String? = null, title: String = "Fixture"): String =
    """{"id":"$id","provider":"echo","transport":"events","cwd":"/tmp","windowKey":"server","state":"idle","createdAt":1,"adapterId":"echo","title":"$title"${workspaceId?.let { ",\"workspaceId\":\"$it\"" } ?: ""}}"""

/** One HTTP request the machine saw: the path without a relay road's `/m/<id>` prefix. */
internal data class Call(val method: String, val path: String, val query: Map<String, String>, val body: String, val rawPath: String) {
    val line: String get() = "$method $path"
}

/** A request the machine holds until the test answers it. */
internal class Held(val call: Call) {
    val future = CompletableFuture<MockResponse>()
}

/**
 * A Clave machine on MockWebServer, for the store: the HTTP routes answered by [handler]
 * (or held until the test answers), and the push hub on the WebSocket upgrade at `/push`
 * (hello checked against the token, subscribe acknowledged unless held, ping answered),
 * every frame and request recorded. The road prefix `/m/<id>` of a relay is stripped, so
 * the same fixture stands for a machine reached directly or through the relay.
 */
internal class FakeMachine(private val token: String = TOKEN) : AutoCloseable {
    val server = MockWebServer()
    val calls = CopyOnWriteArrayList<Call>()
    val frames = CopyOnWriteArrayList<JsonObject>()
    val peers = CopyOnWriteArrayList<WebSocket>()
    val upgrades = AtomicInteger()
    val held = CopyOnWriteArrayList<Held>()
    val heldAcks = CopyOnWriteArrayList<() -> Unit>()

    /** False: the hub never welcomes, so the push channel never opens (the TS tests' NoSocket). */
    @Volatile var welcome = true

    /** Which connection's subscriptions wait for [releaseAcks]; 1 is the first socket. */
    @Volatile var holdAcks: (connection: Int) -> Boolean = { false }

    @Volatile var handler: (Call) -> MockResponse = { answer(404, """{"error":"no such route"}""") }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                val raw = url.encodedPath
                if (raw.endsWith("/push")) {
                    val n = upgrades.incrementAndGet()
                    return MockResponse().withWebSocketUpgrade(listener(n))
                }
                val path = raw.replace(Regex("^/m/[^/]+"), "")
                val query = url.queryParameterNames.associateWith { url.queryParameter(it) ?: "" }
                val call = Call(request.method ?: "", path, query, request.body.readUtf8(), raw)
                calls += call
                return handler(call)
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    val base: String get() = "http://127.0.0.1:${server.port}"

    fun lines(): List<String> = calls.map { it.line }

    fun count(line: String): Int = calls.count { it.line == line }

    /** Inside [handler]: hold this request until [respond]. */
    fun hold(call: Call): MockResponse {
        val entry = Held(call)
        held += entry
        return entry.future.get(30, TimeUnit.SECONDS)
    }

    fun respond(index: Int, response: MockResponse) {
        held[index].future.complete(response)
    }

    fun tags(): List<String> = frames.map { it["_tag"]!!.jsonPrimitive.content }

    fun broadcast(frame: String) {
        for (peer in peers) peer.send(frame)
    }

    fun releaseAcks() {
        val acks = heldAcks.toList()
        heldAcks.clear()
        acks.forEach { it() }
    }

    fun closePeers(code: Int = 1000, reason: String = "bye") {
        for (peer in peers) peer.close(code, reason)
    }

    override fun close() {
        for (entry in held) entry.future.complete(answer(503, "{}"))
        for (peer in peers) runCatching { peer.cancel() }
        server.shutdown()
    }

    private fun listener(connection: Int) = object : WebSocketListener() {
        var welcomed = false

        override fun onOpen(webSocket: WebSocket, response: Response) {
            peers += webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = json(text).jsonObject
            frames += frame
            val tag = frame["_tag"]?.jsonPrimitive?.content
            if (!welcomed) {
                if (tag != "hello" || frame["token"]?.jsonPrimitive?.content != token) {
                    webSocket.close(4001, "unauthorized")
                    return
                }
                if (!welcome) return
                welcomed = true
                webSocket.send("""{"_tag":"welcome","serverId":"fixture","protocol":1,"version":"test"}""")
                return
            }
            when (tag) {
                "ping" -> webSocket.send("""{"_tag":"pong"}""")
                "subscribe" -> {
                    val sessionId = frame["sessionId"]!!.jsonPrimitive.content
                    val ack = { webSocket.send("""{"_tag":"subscribed","sessionId":"$sessionId","session":${sessionJson(sessionId)}}""") }
                    if (holdAcks(connection)) heldAcks += { ack() } else ack()
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            peers -= webSocket
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            peers -= webSocket
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            peers -= webSocket
        }
    }
}

/** A key-value store safe across the store's threads. */
internal class SyncKv : KeyValueStore {
    val map: MutableMap<String, String> = Collections.synchronizedMap(linkedMapOf())
    /** Runs before a write lands, with its key; a test suspends here to hold it. */
    @Volatile var beforeSet: (suspend (String) -> Unit)? = null
    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) {
        beforeSet?.invoke(key)
        map[key] = value
    }
    override suspend fun remove(key: String) { map.remove(key) }
}

internal class SyncSecure : SecureStore {
    val map: MutableMap<String, String> = Collections.synchronizedMap(linkedMapOf())
    /** Runs before a write lands, with its key; a test suspends here to hold it. */
    @Volatile var beforeSet: (suspend (String) -> Unit)? = null
    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) {
        beforeSet?.invoke(key)
        map[key] = value
    }
    override suspend fun remove(key: String) { map.remove(key) }
}

/** A clock the test moves; the sleep of a send advances it instead of waiting. */
internal class TestClock(@Volatile var nowMs: Long = 1_900_000_000_000) : Clock {
    override fun now(): Long = nowMs
}

/** Polls a condition in real time: the store runs against real sockets. */
internal suspend fun until(timeoutMs: Long = 10_000, check: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (!check()) {
        if (System.currentTimeMillis() > end) fail("timed out waiting")
        delay(10)
    }
}

/** The transcript's text, every user and assistant entry joined. */
internal fun ClaveStore.text(machineId: String, sessionId: String): String =
    state.value.conversations[conversationKey(machineId, sessionId)]?.conversation?.entries.orEmpty().joinToString("") {
        when (it) {
            is Entry.User -> it.text
            is Entry.Assistant -> it.text
            else -> ""
        }
    }

internal fun timelineJson(items: List<Triple<String, Long, String>>, cursor: Pair<String, Long>, before: Long? = null): String {
    val entries = items.joinToString(",") { (delta, sequence, generation) ->
        """{"event":{"type":"assistant_text","delta":"$delta","final":false},"position":{"generation":"$generation","sequence":$sequence}}"""
    }
    return """{"items":[$entries],"before":${before ?: "null"},"cursor":{"generation":"${cursor.first}","sequence":${cursor.second}},"truncated":false}"""
}

internal fun page(delta: String, sequence: Long = 1, generation: String = "g", before: Long? = null): String =
    timelineJson(listOf(Triple(delta, sequence, generation)), generation to sequence, before)

internal fun streamFrame(sessionId: String, delta: String, sequence: Long, generation: String = "g"): String =
    """{"_tag":"stream","sessionId":"$sessionId","stream":{"kind":"event","event":{"type":"assistant_text","delta":"$delta","final":false},"position":{"generation":"$generation","sequence":$sequence}}}"""

/**
 * A store on one fake machine with id [machineId], reached at the fixture's base URL, its
 * credential kept, the machines loaded once [start] runs.
 */
internal class Harness(
    val machine: FakeMachine = FakeMachine(),
    val machineId: String = "m",
    withDelivery: Boolean = true,
    val clock: TestClock = TestClock(),
    sleep: (suspend (Long) -> Unit)? = null,
    mint: (() -> String)? = null,
) : AutoCloseable {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http = OkHttpClient()
    val kv = SyncKv()
    val drafts = Drafts(kv)
    val credentials = SecureCredentialStore(SyncSecure())
    val sends = UnknownSends(kv)
    val marks = DeliveryMarks(kv)
    val delivery: DeliveryController? = if (withDelivery) DeliveryController(sends, marks, drafts, kv, clock) else null
    val record = Machine(
        id = machineId,
        name = "Fixture",
        platform = MachinePlatform.Unknown,
        version = "",
        online = true,
        lastSeen = null,
        baseUrl = machine.base,
        pushUrl = "${machine.base}/push",
    )
    val store = ClaveStore(
        Services(
            build = BuildKind.Development,
            credentials = credentials,
            relaySource = object : MachineSource {
                override suspend fun list(): List<Machine> = listOf(record)
            },
            developerSource = null,
            kv = kv,
            drafts = drafts,
            http = OkHttpPort(http),
            sockets = OkHttpWebSocketFactory(http),
            clientName = "test",
            clock = clock,
            mintMessageId = mint ?: { mintMessageId() },
            delivery = delivery,
            scope = scope,
            sleep = sleep ?: { clock.nowMs += it },
            push = PushOptions(backoffBaseMs = 10, backoffMaxMs = 20, livenessIntervalMs = 60_000, livenessTimeoutMs = 60_000),
        ),
    )

    suspend fun start(): Harness {
        credentials.set(machineId, Credential(machine.base, TOKEN))
        store.loadMachines()
        return this
    }

    override fun close() {
        store.disconnectAll()
        scope.cancel()
        machine.close()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }
}
