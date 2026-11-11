package com.clave.core.transport

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/** A stub of the server's push hub (push.test.ts's) on MockWebServer's WebSocket upgrade:
 *  hello with the token or close 4001, subscribe answered with the record, ping with pong,
 *  every frame recorded. Each connection is one upgrade, counted. */
internal class PushHub(private val token: String = TOKEN) {
    val server: MockWebServer = loopbackServer()
    val received = CopyOnWriteArrayList<JsonObject>()
    val peers = CopyOnWriteArrayList<WebSocket>()
    val upgrades = AtomicInteger()

    @Volatile var answerPings = true
    @Volatile var answerSubscriptions = true

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                upgrades.incrementAndGet()
                return MockResponse().withWebSocketUpgrade(listener())
            }
        }
    }

    val url: String get() = server.base()

    fun tags(): List<String> = received.map { it["_tag"]!!.jsonPrimitive.content }

    fun broadcast(frame: String) {
        for (peer in peers) peer.send(frame)
    }

    fun closeAll(code: Int, reason: String) {
        for (peer in peers) peer.close(code, reason)
    }

    fun shutdown() {
        for (peer in peers) runCatching { peer.close(1001, "going away") }
        server.shutdown()
    }

    private fun listener() = object : WebSocketListener() {
        var welcomed = false

        override fun onOpen(webSocket: WebSocket, response: Response) {
            peers += webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = json(text).jsonObject
            received += frame
            val tag = frame["_tag"]?.jsonPrimitive?.content
            if (!welcomed) {
                if (tag != "hello" || frame["token"]?.jsonPrimitive?.content != token) {
                    webSocket.close(4001, "unauthorized")
                    return
                }
                welcomed = true
                webSocket.send("""{"_tag":"welcome","serverId":"srv","protocol":1,"version":"2.4.0"}""")
                return
            }
            if (tag == "ping" && answerPings) webSocket.send("""{"_tag":"pong"}""")
            if (tag == "subscribe") {
                val sessionId = frame["sessionId"]?.jsonPrimitive?.content
                if (sessionId != "s1") {
                    webSocket.send("""{"_tag":"error","sessionId":"$sessionId","message":"Unknown session"}""")
                } else if (answerSubscriptions) {
                    webSocket.send("""{"_tag":"subscribed","sessionId":"s1","session":$SESSION_JSON}""")
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
