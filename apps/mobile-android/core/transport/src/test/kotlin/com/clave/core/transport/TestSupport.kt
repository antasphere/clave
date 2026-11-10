package com.clave.core.transport

import java.net.InetAddress
import java.net.ServerSocket
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.fail

internal const val TOKEN = "tok-123"

internal const val SESSION_JSON =
    """{"id":"s1","provider":"echo","transport":"events","cwd":"/tmp/scratch","windowKey":"server","state":"idle","createdAt":1,"adapterId":"echo","title":"Echo","workspaceId":"ws1"}"""

internal val LOOPBACK: InetAddress = InetAddress.getByName("127.0.0.1")

/** A server on the IPv4 loopback, the address the development build allows. */
internal fun loopbackServer(): MockWebServer = MockWebServer().apply { start(LOOPBACK, 0) }

internal fun MockWebServer.base(): String = "http://127.0.0.1:$port"

/** A port nothing listens on: bound once, then released. */
internal fun closedPort(): Int = ServerSocket(0, 1, LOOPBACK).use { it.localPort }

internal fun json(text: String): JsonElement = Json.parseToJsonElement(text)

internal fun assertJson(expected: String, actual: String?) {
    assertEquals(json(expected), json(actual ?: "null"))
}

/** Polls a condition in real time; the push tests run against real sockets. */
internal suspend fun until(timeoutMs: Long = 5_000, check: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (!check()) {
        if (System.currentTimeMillis() > end) fail("timed out waiting")
        delay(10)
    }
}

/** Runs [block] and answers the [ServerError] it threw. */
internal suspend fun serverErrorOf(block: suspend () -> Any?): ServerError {
    try {
        block()
    } catch (e: ServerError) {
        // No answer of the server is ever allowed to put the bearer in a sentence.
        if (e.message.orEmpty().contains(TOKEN)) fail("the bearer leaked into an error message")
        return e
    }
    fail("expected a ServerError")
    throw AssertionError()
}
