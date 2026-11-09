package com.clave.platform.net

import com.clave.core.ports.HttpPort
import com.clave.core.ports.WebSocketFactory
import com.clave.core.transport.OkHttpPort
import com.clave.core.transport.OkHttpWebSocketFactory
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/**
 * The app's one OkHttp client and the core's ports on it. One instance for the process, so
 * every request and socket shares its pool and its TLS sessions; a ping every 20 s keeps the
 * relay's socket alive through carrier NATs. Each request still gets its own deadline from
 * [OkHttpPort].
 */
object Networking {
    private val shared: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    fun client(): OkHttpClient = shared

    fun httpPort(client: OkHttpClient = client()): HttpPort = OkHttpPort(client)

    fun webSockets(client: OkHttpClient = client()): WebSocketFactory = OkHttpWebSocketFactory(client)
}
