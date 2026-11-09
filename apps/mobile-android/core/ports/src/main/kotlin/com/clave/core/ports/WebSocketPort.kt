package com.clave.core.ports

/**
 * The subset of a WebSocket the push client uses: open on a URL with a listener, send
 * text, close. The app binds it to OkHttp's WebSocket; a test binds it to MockWebServer
 * or to a scripted fake.
 */
interface WebSocketPort {
    /** False when the socket is already closed or the message could not be queued. */
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
}

interface WebSocketEvents {
    fun onOpen()
    fun onMessage(text: String)
    /** The socket is gone, by whichever side closed it. */
    fun onClosed(code: Int, reason: String)
    /** The connection failed before or after opening; onClosed does not follow. */
    fun onFailure(cause: Throwable)
}

fun interface WebSocketFactory {
    fun open(url: String, events: WebSocketEvents): WebSocketPort
}
