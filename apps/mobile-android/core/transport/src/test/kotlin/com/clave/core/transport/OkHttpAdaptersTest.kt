package com.clave.core.transport

import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.WebSocketEvents
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OkHttpAdaptersTest {
    private val client = OkHttpClient()

    @Test
    fun `a GET answers the status, the body and lowercased headers`() = runBlocking {
        val server = loopbackServer()
        try {
            server.enqueue(MockResponse().setResponseCode(201).setBody("hi").addHeader("X-Thing", "A").addHeader("X-Thing", "B"))
            val answer = OkHttpPort(client).send(HttpRequest("GET", "${server.base()}/x", mapOf("Accept" to "application/json")))
            assertEquals(201, answer.status)
            assertEquals("hi", answer.body)
            assertEquals(listOf("A", "B"), answer.headers["x-thing"])
            assertEquals("application/json", server.takeRequest().getHeader("Accept"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a POST sends its body under the declared content type`() = runBlocking {
        val server = loopbackServer()
        try {
            server.enqueue(MockResponse().setResponseCode(204))
            val answer = OkHttpPort(client).send(
                HttpRequest("POST", "${server.base()}/y", mapOf("Content-Type" to "application/json"), """{"a":1}"""),
            )
            assertEquals(204, answer.status)
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("application/json", request.getHeader("Content-Type"))
            assertEquals("""{"a":1}""", request.body.readUtf8())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a body delay past the deadline is a timeout`() = runBlocking {
        val server = loopbackServer()
        try {
            server.enqueue(MockResponse().setBody("late").setBodyDelay(2, TimeUnit.SECONDS))
            try {
                OkHttpPort(client).send(HttpRequest("GET", "${server.base()}/slow", timeoutMs = 150))
                fail("expected a timeout")
            } catch (e: HttpFailure.Timeout) {
                // The deadline.
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a closed port is a network failure`() = runBlocking {
        try {
            OkHttpPort(client).send(HttpRequest("GET", "http://127.0.0.1:${closedPort()}/"))
            fail("expected a network failure")
        } catch (e: HttpFailure.Network) {
            // Nothing listens.
        }
    }

    private class Recorder : WebSocketEvents {
        val log = CopyOnWriteArrayList<String>()
        override fun onOpen() {
            log += "open"
        }
        override fun onMessage(text: String) {
            log += "message:$text"
        }
        override fun onClosed(code: Int, reason: String) {
            log += "closed:$code:$reason"
        }
        override fun onFailure(cause: Throwable) {
            log += "failure"
        }
    }

    @Test
    fun `a socket reports open, messages and the server's close once`() = runBlocking {
        val server = loopbackServer()
        try {
            server.enqueue(
                MockResponse().withWebSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            webSocket.send("hello")
                        }
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            webSocket.close(4011, "revoked")
                        }
                    },
                ),
            )
            val events = Recorder()
            val socket = OkHttpWebSocketFactory(client).open("ws://127.0.0.1:${server.port}/push", events)
            until { events.log.contains("message:hello") }
            assertTrue(socket.send("bye"))
            until { events.log.any { it.startsWith("closed") } }
            Thread.sleep(200)
            assertEquals(listOf("open", "message:hello", "closed:4011:revoked"), events.log.toList())
            assertTrue(!socket.send("late"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a socket to a closed port fails once`() = runBlocking {
        val events = Recorder()
        OkHttpWebSocketFactory(client).open("ws://127.0.0.1:${closedPort()}/push", events)
        until { events.log.isNotEmpty() }
        Thread.sleep(200)
        assertEquals(listOf("failure"), events.log.toList())
    }
}
