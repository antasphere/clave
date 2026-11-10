package com.clave.core.devices

import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The tests' binding of [HttpPort] to the JDK's client, so the clients run against
 *  MockWebServer over a real socket, the deadline the request's own. */
class JvmHttp : HttpPort {
    val sent = mutableListOf<HttpRequest>()

    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        sent += request
        try {
            val connection = URI(request.url).toURL().openConnection() as HttpURLConnection
            connection.requestMethod = request.method
            connection.connectTimeout = request.timeoutMs.toInt()
            connection.readTimeout = request.timeoutMs.toInt()
            for ((k, v) in request.headers) connection.setRequestProperty(k, v)
            if (request.body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(request.body!!.toByteArray()) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            HttpResponse(status, body)
        } catch (e: SocketTimeoutException) {
            throw HttpFailure.Timeout(cause = e)
        } catch (e: IOException) {
            throw HttpFailure.Network(cause = e)
        }
    }
}
