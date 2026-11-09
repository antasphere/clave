package com.clave.core.transport

import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import com.clave.core.ports.WebSocketEvents
import com.clave.core.ports.WebSocketFactory
import com.clave.core.ports.WebSocketPort
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * [HttpPort] on OkHttp. The client is the app's (its TLS, its pool, its interceptors); each
 * request gets its own deadline as a call timeout, so the whole exchange, body included, is
 * bounded. A deadline is [HttpFailure.Timeout], any other I/O failure [HttpFailure.Network];
 * a cancelled coroutine cancels the call. Failure messages never carry the request's headers.
 */
public class OkHttpPort(private val client: OkHttpClient) : HttpPort {
    override suspend fun send(request: HttpRequest): HttpResponse {
        val call = client.newBuilder()
            .callTimeout(request.timeoutMs, TimeUnit.MILLISECONDS)
            .build()
            .newCall(toOkHttp(request))
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        continuation.resumeWithException(failureOf(e))
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val answer = try {
                            response.use { read(it) }
                        } catch (e: IOException) {
                            continuation.resumeWithException(failureOf(e))
                            return
                        }
                        continuation.resume(answer)
                    }
                },
            )
        }
    }

    private fun toOkHttp(request: HttpRequest): Request {
        val builder = Request.Builder().url(request.url)
        for ((name, value) in request.headers) builder.header(name, value)
        val contentType = request.headers.entries
            .firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }
            ?.value?.toMediaTypeOrNull()
        // Bytes, not a String: OkHttp would append a charset to the declared Content-Type.
        val body = request.body?.toByteArray(Charsets.UTF_8)?.toRequestBody(contentType)
        builder.method(request.method, body ?: if (request.method == "POST" || request.method == "PUT") ByteArray(0).toRequestBody(contentType) else null)
        return builder.build()
    }

    private fun read(response: Response): HttpResponse {
        val headers = LinkedHashMap<String, MutableList<String>>()
        for ((name, value) in response.headers) headers.getOrPut(name.lowercase()) { mutableListOf() } += value
        return HttpResponse(status = response.code, body = response.body.string(), headers = headers)
    }

    private fun failureOf(e: IOException): HttpFailure = when (e) {
        // OkHttp's call timeout and a socket's read timeout are both interrupted I/O.
        is InterruptedIOException -> HttpFailure.Timeout(cause = e)
        else -> HttpFailure.Network(cause = e)
    }
}

/**
 * [WebSocketFactory] on OkHttp. A close frame from the server is answered and reported once as
 * [WebSocketEvents.onClosed] with the server's code; a failure is reported once as
 * [WebSocketEvents.onFailure], and nothing follows either.
 */
public class OkHttpWebSocketFactory(private val client: OkHttpClient) : WebSocketFactory {
    override fun open(url: String, events: WebSocketEvents): WebSocketPort {
        val done = AtomicBoolean(false)
        val socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!done.get()) events.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (!done.get()) events.onMessage(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (!done.get()) events.onMessage(bytes.utf8())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Complete the closing handshake; the peer's code is the outcome.
                    webSocket.close(1000, null)
                    if (done.compareAndSet(false, true)) events.onClosed(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (done.compareAndSet(false, true)) events.onClosed(code, reason)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    response?.close()
                    if (done.compareAndSet(false, true)) events.onFailure(t)
                }
            },
        )
        return object : WebSocketPort {
            override fun send(text: String): Boolean = socket.send(text)

            override fun close(code: Int, reason: String) {
                try {
                    if (!socket.close(code, reason)) socket.cancel()
                } catch (_: IllegalArgumentException) {
                    // A code OkHttp will not send: drop the socket instead.
                    socket.cancel()
                }
            }
        }
    }
}
