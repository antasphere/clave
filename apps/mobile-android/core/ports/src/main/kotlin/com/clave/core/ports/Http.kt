package com.clave.core.ports

/**
 * The subset of an HTTP client the core speaks: one request, one answer, under a
 * deadline. The app binds it to OkHttp; a test binds it to MockWebServer or to a stub.
 * The core never sees a socket, a certificate or a cookie jar.
 */
data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
    /** The deadline of the whole exchange, in milliseconds. */
    val timeoutMs: Long = 10_000,
)

data class HttpResponse(
    val status: Int,
    val body: String,
    /** Header names lowercased; a header repeated is a list. */
    val headers: Map<String, List<String>> = emptyMap(),
)

/** Why a request did not complete: the network, or the deadline. */
sealed class HttpFailure(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Network(message: String = "The server could not be reached.", cause: Throwable? = null) :
        HttpFailure(message, cause)

    class Timeout(message: String = "The server did not answer in time.", cause: Throwable? = null) :
        HttpFailure(message, cause)
}

fun interface HttpPort {
    /** Answers the response, whatever its status; throws [HttpFailure] when there is none. */
    suspend fun send(request: HttpRequest): HttpResponse
}
