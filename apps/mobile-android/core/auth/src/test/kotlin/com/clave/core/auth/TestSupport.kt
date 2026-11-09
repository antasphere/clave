package com.clave.core.auth

import com.clave.core.ports.Clock
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import com.clave.core.ports.SecureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Collections

/** A clock the test moves by hand, shared by the app's code and the fake issuer. */
class TestClock(@Volatile var nowMs: Long = 1_900_000_000_000) : Clock {
    override fun now(): Long = nowMs
    fun advance(ms: Long) {
        nowMs += ms
    }
}

/**
 * A real HTTP port over java.net.HttpURLConnection: no redirects followed, the request's
 * deadline as both the connect and the read timeout, failures mapped to [HttpFailure].
 */
class UrlConnectionHttpPort : HttpPort {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        try {
            val connection = URL(request.url).openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = request.timeoutMs.toInt()
                connection.readTimeout = request.timeoutMs.toInt()
                connection.requestMethod = request.method
                request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
                if (request.body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(request.body!!.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                val headers = connection.headerFields.filterKeys { it != null }.mapKeys { it.key.lowercase() }
                HttpResponse(status, body, headers)
            } finally {
                connection.disconnect()
            }
        } catch (e: SocketTimeoutException) {
            throw HttpFailure.Timeout(cause = e)
        } catch (e: IOException) {
            throw HttpFailure.Network(cause = e)
        }
    }
}

/** A secure store that records the order of its writes, and can hold one key's write on a gate. */
class RecordingSecureStore : SecureStore {
    val map: MutableMap<String, String> = Collections.synchronizedMap(linkedMapOf())
    val writes: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** Runs before a write lands, with its key; a test suspends here to hold it. */
    @Volatile var beforeSet: (suspend (String) -> Unit)? = null

    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) {
        beforeSet?.invoke(key)
        writes.add(key)
        map[key] = value
    }
    override suspend fun remove(key: String) {
        map.remove(key)
    }
}
