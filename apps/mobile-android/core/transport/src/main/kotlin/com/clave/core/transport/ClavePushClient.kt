package com.clave.core.transport

import com.clave.core.contract.ClientFrame
import com.clave.core.contract.Encode
import com.clave.core.contract.Push
import com.clave.core.contract.ServerEventEnvelope
import com.clave.core.contract.ServerFrame
import com.clave.core.contract.Session
import com.clave.core.contract.SessionStream
import com.clave.core.contract.parseServerFrame
import com.clave.core.contract.toText
import com.clave.core.devices.BuildKind
import com.clave.core.devices.TransportVerdict
import com.clave.core.devices.credentialMayTravelTo
import com.clave.core.ports.Log
import com.clave.core.ports.NoLog
import com.clave.core.ports.WebSocketEvents
import com.clave.core.ports.WebSocketFactory
import com.clave.core.ports.WebSocketPort
import java.net.URI
import kotlin.math.min
import kotlin.math.pow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

public enum class PushStatus { Idle, Connecting, Open, Reconnecting, Closed }

public data class PushStatusDetail(
    val code: Int? = null,
    val reason: String? = null,
    val final: Final? = null,
    val attempt: Int? = null,
) {
    /** Why a closed client stays closed: the token refused (4001), the device session
     *  revoked on the machine (4011), or the app's own [ClavePushClient.close]. */
    public enum class Final { Unauthorized, Revoked, Closed }
}

/** The status and its detail together, so a reader never pairs one with another's detail. */
public data class PushState(val status: PushStatus, val detail: PushStatusDetail = PushStatusDetail())

/** A push waiter's failure: the client closed, the token refused, or the server's refusal of
 *  one subscription in its own words. Never carries the token. */
public class PushError(message: String, public val sessionId: String? = null) : Exception(message)

/** The close code this client uses when the liveness deadline passes. */
public const val CLOSE_LIVENESS: Int = 4000

/** The socket URL of a server's base URL (a relay road included): http becomes ws, https
 *  becomes wss, and `/push` is appended unless the path already ends with it. */
public fun pushUrlOf(url: String): String {
    val uri = URI(url)
    val scheme = if (uri.scheme?.lowercase() in setOf("https", "wss")) "wss" else "ws"
    val path = uri.rawPath.orEmpty()
    val pushPath = when {
        path.isEmpty() || path == "/" -> Push.PATH
        path.endsWith(Push.PATH) -> path
        else -> path.trimEnd('/') + Push.PATH
    }
    val query = uri.rawQuery?.let { "?$it" }.orEmpty()
    return "$scheme://${uri.rawAuthority}$pushPath$query"
}

/**
 * The phone's client of a Clave server's push channel, ported from `apps/mobile/src/api/push.ts`
 * on coroutines: one WebSocket on `/push`, the token in the first frame, the sessions subscribed
 * on behalf of their listeners, the socket reopened with a jittered backoff when it drops and
 * every subscription asked again, so a screen that was listening keeps listening without knowing
 * the socket changed. A refused token (4001) and a revoked device session (4011) are final.
 *
 * A client-side liveness ping runs once open: a phone's socket dies silently when the network
 * changes under it, so a socket that answers nothing within [livenessTimeoutMs] of a ping is
 * closed with [CLOSE_LIVENESS] and reopened. Frames this client does not know are ignored.
 *
 * Socket callbacks arrive on the socket's threads and calls on the app's; one lock orders them,
 * as JavaScript's single thread ordered the original. Listeners run under it and must not block.
 * Timers are coroutines in [scope] using `delay`, so a test drives them on virtual time. The
 * [sockets] factory may call its events from any thread, but not synchronously from `open`'s
 * caller before it returns (a hello in that window is held until it does).
 */
public class ClavePushClient(
    url: String,
    private val token: String,
    private val sockets: WebSocketFactory,
    private val scope: CoroutineScope,
    build: BuildKind,
    private val clientName: String? = null,
    private val backoffBaseMs: Long = 250,
    private val backoffMaxMs: Long = 10_000,
    private val livenessIntervalMs: Long = 20_000,
    private val livenessTimeoutMs: Long = 10_000,
    private val random: () -> Double = Math::random,
    private val log: Log = NoLog,
) {
    public val url: String = pushUrlOf(url)

    init {
        val verdict = credentialMayTravelTo(this.url, build)
        if (verdict is TransportVerdict.Refused) throw ServerError(ServerError.Kind.Policy, verdict.reason)
    }

    private class Listener<T>(val fn: (T) -> Unit)

    private class Subscription {
        val streams = mutableListOf<Listener<SessionStream>>()
        val exits = mutableListOf<Listener<Int>>()
        var ended = false
        var acked: Session? = null
        val waiters = mutableListOf<CompletableDeferred<Session>>()
    }

    private val lock = Any()
    private var current: Connection? = null
    private var stopped = false
    private var attempts = 0
    private var reconnectJob: Job? = null
    private var reconnectGen = 0
    private var pingJob: Job? = null
    private var pongJob: Job? = null
    private var livenessGen = 0
    private val subscriptions = LinkedHashMap<String, Subscription>()
    private val openWaiters = mutableListOf<CompletableDeferred<Unit>>()
    private val statusListeners = mutableListOf<Listener<PushState>>()

    private val _status = MutableStateFlow(PushState(PushStatus.Idle))
    private val _events = MutableSharedFlow<ServerEventEnvelope>(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val _errors = MutableSharedFlow<Pair<String, String?>>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** The latest status; a collector may miss a transient one, [onStatus] sees every one. */
    public val status: StateFlow<PushState> = _status.asStateFlow()

    /** The server events every welcomed client hears. */
    public val events: SharedFlow<ServerEventEnvelope> = _events.asSharedFlow()

    /** The server's refusals that keep the socket open, as (message, sessionId). */
    public val errors: SharedFlow<Pair<String, String?>> = _errors.asSharedFlow()

    /** How many times a socket opened and said hello; a reconnection adds one. */
    @Volatile public var connections: Int = 0
        private set

    /** How many pings went out, for the record and the tests. */
    @Volatile public var pings: Int = 0
        private set

    /** The server named in the last welcome, null before one. */
    @Volatile public var serverId: String? = null
        private set

    @Volatile public var serverVersion: String? = null
        private set

    public fun connect(): ClavePushClient = synchronized(lock) {
        if (stopped) throw PushError(CLOSED)
        // A socket, or a reconnect already scheduled, is the connection in progress.
        if (current != null || reconnectJob != null) return this
        open(if (_status.value.status == PushStatus.Idle) PushStatus.Connecting else PushStatus.Reconnecting)
        this
    }

    /** Resolves once a welcome arrived; fails when the client closes or the token is refused. */
    public suspend fun whenOpen() {
        val waiter = synchronized(lock) {
            if (_status.value.status == PushStatus.Open) return
            if (stopped) throw PushError(CLOSED)
            CompletableDeferred<Unit>().also { openWaiters += it }
        }
        try {
            waiter.await()
        } finally {
            synchronized(lock) { openWaiters.remove(waiter) }
        }
    }

    public fun close() {
        synchronized(lock) {
            if (stopped) return
            stopped = true
            clearTimers()
            val conn = current
            current = null
            closeQuietly(conn, 1000, "client closed")
            for (subscription in subscriptions.values) failSubscribers(subscription, PushError(CLOSED))
            subscriptions.clear()
            setStatus(PushStatus.Closed, PushStatusDetail(final = PushStatusDetail.Final.Closed))
            failWaiters(PushError(CLOSED))
        }
    }

    /** Listens to one session's stream and exit; the returned function stops listening, and the
     *  last listener's leaving unsubscribes on the server. */
    public fun subscribe(
        sessionId: String,
        onStream: (SessionStream) -> Unit,
        onExit: ((Int) -> Unit)? = null,
    ): () -> Unit = synchronized(lock) {
        val existing = subscriptions[sessionId]
        val fresh = existing == null || existing.ended
        val subscription = existing ?: Subscription().also { subscriptions[sessionId] = it }
        if (fresh) subscription.acked = null
        subscription.ended = false
        val streamListener = Listener(onStream)
        val exitListener = onExit?.let { Listener(it) }
        subscription.streams += streamListener
        if (exitListener != null) subscription.exits += exitListener
        if (fresh && _status.value.status == PushStatus.Open) send(ClientFrame.Subscribe(sessionId))
        val unsubscribe: () -> Unit = {
            synchronized(lock) {
                val now = subscriptions[sessionId]
                if (now != null) {
                    now.streams.remove(streamListener)
                    if (exitListener != null) now.exits.remove(exitListener)
                    if (now.streams.isEmpty() && now.exits.isEmpty()) {
                        subscriptions.remove(sessionId)
                        failSubscribers(now, PushError("Unsubscribed before the server answered", sessionId))
                        if (_status.value.status == PushStatus.Open) send(ClientFrame.Unsubscribe(sessionId))
                    }
                }
            }
        }
        unsubscribe
    }

    /**
     * The acknowledgement barrier: the server's record for a subscribed session once THIS
     * socket's `subscribed` frame arrived. A welcome invalidates every earlier acknowledgement,
     * so a snapshot fetched after this returns is never older than the subscription. Fails with
     * the server's refusal, or after [timeoutMs].
     */
    public suspend fun subscribed(sessionId: String, timeoutMs: Long = 10_000): Session {
        val (subscription, waiter) = synchronized(lock) {
            val subscription = subscriptions[sessionId] ?: throw PushError("Not subscribed to $sessionId", sessionId)
            subscription.acked?.let { return it }
            if (stopped) throw PushError(CLOSED, sessionId)
            subscription to CompletableDeferred<Session>().also { subscription.waiters += it }
        }
        try {
            return withTimeoutOrNull(timeoutMs) { waiter.await() }
                ?: throw PushError("The server did not acknowledge the conversation subscription.", sessionId)
        } finally {
            synchronized(lock) { subscription.waiters.remove(waiter) }
        }
    }

    /** The acknowledged record of this socket, or null: the barrier read without waiting. */
    public fun acknowledged(sessionId: String): Session? = synchronized(lock) { subscriptions[sessionId]?.acked }

    /** Every status change, synchronously and in order (the StateFlow conflates). */
    public fun onStatus(listener: (PushState) -> Unit): () -> Unit = synchronized(lock) {
        val entry = Listener(listener)
        statusListeners += entry
        val remove: () -> Unit = { synchronized(lock) { statusListeners.remove(entry) } }
        remove
    }

    // ── the socket ──

    /** One opened socket. Events of a socket that is no longer [current] are ignored. */
    private inner class Connection : WebSocketEvents {
        var port: WebSocketPort? = null
        var helloPending = false

        override fun onOpen() {
            synchronized(lock) {
                if (current !== this) return
                if (port == null) {
                    helloPending = true
                    return
                }
                hello()
            }
        }

        override fun onMessage(text: String) {
            synchronized(lock) {
                if (current !== this) return
                receive(text)
            }
        }

        override fun onClosed(code: Int, reason: String) {
            synchronized(lock) {
                if (current !== this) return
                current = null
                clearLiveness()
                if (stopped) return
                when (code) {
                    Push.CLOSE_UNAUTHORIZED -> finish(code, reason, PushStatusDetail.Final.Unauthorized, "The server refused the token ($code $reason)")
                    Push.CLOSE_DEVICE_REVOKED -> finish(code, reason, PushStatusDetail.Final.Revoked, "This phone's session was revoked on the machine ($code)")
                    else -> scheduleReconnect(code, reason)
                }
            }
        }

        /** A failure has no close frame: read it as the abnormal closure a browser reports. */
        override fun onFailure(cause: Throwable) {
            log.event("push.failure", mapOf("error" to cause.javaClass.simpleName))
            onClosed(1006, "connection failed")
        }
    }

    private fun hello() {
        connections += 1
        send(ClientFrame.Hello(token, clientName))
    }

    private fun open(status: PushStatus) {
        setStatus(status, PushStatusDetail(attempt = attempts))
        val conn = Connection()
        current = conn
        val port = try {
            sockets.open(url, conn)
        } catch (e: Exception) {
            if (current === conn) current = null
            log.event("push.open_failed", mapOf("error" to e.javaClass.simpleName))
            scheduleReconnect(0, "open failed")
            return
        }
        conn.port = port
        if (conn.helloPending && current === conn) {
            conn.helloPending = false
            hello()
        }
    }

    private fun finish(code: Int, reason: String, final: PushStatusDetail.Final, message: String) {
        stopped = true
        clearTimers()
        setStatus(PushStatus.Closed, PushStatusDetail(code = code, reason = reason, final = final))
        failWaiters(PushError(message))
        for (subscription in subscriptions.values) failSubscribers(subscription, PushError(message))
    }

    private fun scheduleReconnect(code: Int, reason: String) {
        for (subscription in subscriptions.values) subscription.acked = null
        val attempt = ++attempts
        val delayMs = (
            min(backoffMaxMs.toDouble(), backoffBaseMs * 2.0.pow(min(attempt - 1, 10))) * (0.5 + random() * 0.5)
            ).toLong()
        setStatus(PushStatus.Reconnecting, PushStatusDetail(code = code, reason = reason, attempt = attempt))
        val gen = ++reconnectGen
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            synchronized(lock) {
                if (gen != reconnectGen) return@launch
                reconnectJob = null
                if (!stopped) open(PushStatus.Reconnecting)
            }
        }
    }

    // ── liveness ──

    private fun armPing() {
        clearLiveness()
        val gen = livenessGen
        pingJob = scope.launch {
            delay(livenessIntervalMs)
            synchronized(lock) {
                if (gen != livenessGen) return@launch
                pingJob = null
                if (_status.value.status != PushStatus.Open || current == null) return@launch
                pings += 1
                send(ClientFrame.Ping)
                pongJob = scope.launch {
                    delay(livenessTimeoutMs)
                    synchronized(lock) {
                        if (gen != livenessGen) return@launch
                        pongJob = null
                        val conn = current ?: return@launch
                        // Nothing came back: the socket is dead under us. It is dropped first so
                        // a platform that never reports the close still reconnects.
                        current = null
                        closeQuietly(conn, CLOSE_LIVENESS, "no pong")
                        if (!stopped) scheduleReconnect(CLOSE_LIVENESS, "no pong")
                    }
                }
            }
        }
    }

    private fun clearLiveness() {
        livenessGen += 1
        pingJob?.cancel()
        pongJob?.cancel()
        pingJob = null
        pongJob = null
    }

    private fun clearTimers() {
        reconnectGen += 1
        reconnectJob?.cancel()
        reconnectJob = null
        clearLiveness()
    }

    // ── frames ──

    private fun receive(text: String) {
        val frame = parseServerFrame(text) ?: return
        // Any frame proves the socket alive: the pong deadline is withdrawn and the next ping
        // scheduled from now.
        if (_status.value.status == PushStatus.Open) armPing()
        when (frame) {
            is ServerFrame.Welcome -> {
                attempts = 0
                serverId = frame.serverId
                serverVersion = frame.version
                // The previous socket's acknowledgements go before the status listeners hear
                // Open: a listener that fetches a snapshot must await this socket's barrier.
                for (subscription in subscriptions.values) subscription.acked = null
                setStatus(PushStatus.Open, PushStatusDetail())
                armPing()
                for ((sessionId, subscription) in subscriptions) {
                    // A finished chat still open needs a barrier, and follows a later Resume.
                    subscription.ended = false
                    send(ClientFrame.Subscribe(sessionId))
                }
                val waiters = openWaiters.toList()
                openWaiters.clear()
                for (waiter in waiters) waiter.complete(Unit)
            }
            is ServerFrame.Stream -> {
                val listeners = subscriptions[frame.sessionId]?.streams?.toList().orEmpty()
                for (listener in listeners) safely { listener.fn(frame.stream) }
            }
            is ServerFrame.Exit -> {
                val subscription = subscriptions[frame.sessionId]
                subscription?.ended = true
                for (listener in subscription?.exits?.toList().orEmpty()) safely { listener.fn(frame.code) }
            }
            is ServerFrame.Event -> _events.tryEmit(frame.envelope)
            is ServerFrame.Error -> {
                val subscription = frame.sessionId?.let { subscriptions[it] }
                if (subscription != null) failSubscribers(subscription, PushError(frame.message, frame.sessionId))
                _errors.tryEmit(frame.message to frame.sessionId)
            }
            is ServerFrame.Subscribed -> {
                val subscription = subscriptions[frame.sessionId] ?: return
                subscription.acked = frame.session
                val waiters = subscription.waiters.toList()
                subscription.waiters.clear()
                for (waiter in waiters) waiter.complete(frame.session)
            }
            is ServerFrame.Unsubscribed, ServerFrame.Pong, is ServerFrame.Unknown -> Unit
        }
    }

    private fun send(frame: ClientFrame) {
        val port = current?.port ?: return
        val sent = try {
            port.send(Encode.clientFrame(frame).toText())
        } catch (e: Exception) {
            _errors.tryEmit("Send failed: ${e.javaClass.simpleName}" to null)
            return
        }
        if (!sent) log.event("push.send_refused", mapOf("frame" to frame.javaClass.simpleName))
    }

    private fun closeQuietly(conn: Connection?, code: Int, reason: String) {
        try {
            conn?.port?.close(code, reason)
        } catch (_: Exception) {
            // Already gone.
        }
    }

    private fun setStatus(status: PushStatus, detail: PushStatusDetail) {
        val state = PushState(status, detail)
        _status.value = state
        for (listener in statusListeners.toList()) safely { listener.fn(state) }
    }

    private fun failSubscribers(subscription: Subscription, error: PushError) {
        val waiters = subscription.waiters.toList()
        subscription.waiters.clear()
        for (waiter in waiters) waiter.completeExceptionally(error)
    }

    private fun failWaiters(error: PushError) {
        val waiters = openWaiters.toList()
        openWaiters.clear()
        for (waiter in waiters) waiter.completeExceptionally(error)
    }

    /** A listener's failure is the listener's: it never stops the frames to the others. */
    private inline fun safely(run: () -> Unit) {
        try {
            run()
        } catch (e: Exception) {
            log.event("push.listener_failed", mapOf("error" to e.javaClass.simpleName))
        }
    }

    private companion object {
        const val CLOSED = "This push client was closed"
    }
}
