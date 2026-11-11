package com.clave.android.fake

import java.io.Closeable
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject

/**
 * A stand-in for one Clave machine's server, inside the test process on the device's
 * loopback: one workspace, one echo chat with a two-message past, one permission request
 * waiting until it is answered, and the push socket that streams a written message back
 * with the agent's answer. Every answer has the shape the contract's decoders read
 * (core/contract's samples), so the app on top of it runs its real code from the first
 * request to the last.
 *
 * The rules it keeps: every HTTP route checks the bearer and answers 401 to any other, the
 * socket checks the token of its `hello` and closes 4001 on any other; every request is
 * recorded with its method, path, query, body and Authorization header for the test to
 * read; a path it does not know is recorded apart and refused with a 404, so the test can
 * name it.
 *
 * Switches a test turns on, each off by default so a test that does not touch them sees the
 * stand-in above unchanged: [setSessionState] streams the agent's state, an interrupt write
 * stops the turn, [failWrites] makes every write a 500 whose outcome the status route cannot
 * tell, [pushDown] refuses the push upgrade with a 503 and [dropPush] closes the open sockets
 * as a restarting server does.
 */
class FakeMachineServer(private val token: String) : Closeable {
    /** One HTTP request as the stand-in received it. */
    data class Recorded(
        val method: String,
        val path: String,
        val query: String?,
        val body: String,
        val authorization: String?,
    )

    private val server = MockWebServer()

    /** Every HTTP request, in the order of arrival. */
    val requests = CopyOnWriteArrayList<Recorded>()

    /** The paths no route of the stand-in knows, as `METHOD /path`. */
    val unknownPaths = CopyOnWriteArrayList<String>()

    /** The token of every `hello` frame the push socket received. */
    val helloTokens = CopyOnWriteArrayList<String>()

    /** The frames of a tag the push socket does not know. */
    val unknownFrames = CopyOnWriteArrayList<String>()

    private val lock = Any()

    /** The session's timeline as event JSON; an item's sequence is its index plus one. */
    private val timeline = mutableListOf(
        """{"type":"user_message","text":"Hello from the test"}""",
        """{"type":"assistant_text","delta":"Hello back.","final":true}""",
    )
    private val written = mutableSetOf<String>()
    private var resolved = false
    private val subscribed = CopyOnWriteArrayList<WebSocket>()

    /** Every push socket open on the stand-in's side, subscribed or not. */
    private val openSockets = CopyOnWriteArrayList<WebSocket>()

    /** The session's state as `GET /sessions` and the subscription report it; written under [lock]. */
    @Volatile private var sessionState = "idle"

    /** The client message ids of the writes [failWrites] refused: their status is `unknown`. */
    private val failed = mutableSetOf<String>()

    /** When true, `POST /sessions/write` answers 500 and the status route says `unknown` for that id. */
    @Volatile var failWrites = false

    /** When true, `GET /push` answers 503 instead of upgrading. */
    @Volatile var pushDown = false

    /** When set, `POST /sessions/write` answers this status (a 403: the device-session boundary) with its sentence. */
    @Volatile var refuseWritesWith: Int? = null

    /** A status ask the test holds until [releaseStatus]: it answers whatever the id's state is then. */
    private class HeldStatus(val clientMessageId: String) {
        val asked = CountDownLatch(1)
        val released = CountDownLatch(1)
    }

    @Volatile private var heldStatus: HeldStatus? = null

    /** The status route says `accepted` for [clientMessageId] from now on: its first write arrived after all. */
    fun accept(clientMessageId: String) = synchronized(lock) {
        failed -= clientMessageId
        written += clientMessageId
    }

    /** The next status ask of [clientMessageId] waits until [releaseStatus]. */
    fun holdStatusOf(clientMessageId: String) {
        heldStatus = HeldStatus(clientMessageId)
    }

    /** Whether the held status ask arrived within [timeoutMs]. */
    fun statusHeld(timeoutMs: Long): Boolean = heldStatus?.asked?.await(timeoutMs, TimeUnit.MILLISECONDS) ?: false

    fun releaseStatus() {
        heldStatus?.released?.countDown()
        heldStatus = null
    }

    /** How many push sockets are subscribed to the echo session right now. */
    val subscribers: Int get() = subscribed.size

    /**
     * The agent's state changes: `state_change` streamed to the subscribed sockets at the next
     * position, and `GET /sessions` reports [state] from now on.
     */
    fun setSessionState(state: String) {
        synchronized(lock) {
            sessionState = state
            stream("""{"type":"state_change","state":${JSONObject.quote(state)}}""")
        }
    }

    /** Closes every open push socket with 1012, as a server restarting does. */
    fun dropPush() {
        for (socket in openSockets) socket.close(1012, "service restart")
    }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = answer(request)
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    /** The address the app is given, `http://127.0.0.1:<port>`. */
    val url: String = "http://127.0.0.1:${server.port}"

    override fun close() {
        releaseStatus()
        for (socket in subscribed) socket.close(1001, "stand-in stopping")
        server.shutdown()
    }

    private fun answer(request: RecordedRequest): MockResponse {
        val url = request.requestUrl
        val path = url?.encodedPath ?: request.path.orEmpty().substringBefore('?')
        val method = request.method.orEmpty()
        if (method == "GET" && path == PUSH_PATH) {
            if (pushDown) return json(503, """{"message":"The stand-in's push is down on purpose."}""")
            return MockResponse().withWebSocketUpgrade(PushSocket())
        }
        val body = request.body.readUtf8()
        val authorization = request.getHeader("Authorization")
        requests += Recorded(method, path, url?.encodedQuery, body, authorization)
        val route = "$method $path"
        if (route !in ROUTES) {
            unknownPaths += route
            return json(404, """{"message":"The stand-in has no route $route."}""")
        }
        if (authorization != "Bearer $token") return json(401, """{"message":"The token is not this server's."}""")
        val id = url?.queryParameter("id")
        return when (route) {
            "GET /launch-profiles" -> json(200, """{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}""")
            "GET /workspaces" -> json(200, WORKSPACES)
            "GET /sessions" -> json(200, "[${session()}]")
            "GET /sessions/by-id" -> if (id == SESSION_ID) json(200, session()) else unknownSession()
            "GET /sessions/capabilities" -> if (id == SESSION_ID) json(200, """{"images":false}""") else unknownSession()
            "GET /sessions/timeline" -> if (id == SESSION_ID) json(200, page(url?.queryParameter("before")?.toLongOrNull())) else unknownSession()
            "GET /sessions/writes" -> {
                val asked = url?.queryParameter("clientMessageId")
                // Held outside the lock, so every other route goes on answering meanwhile.
                heldStatus?.takeIf { it.clientMessageId == asked }?.let { held ->
                    held.asked.countDown()
                    held.released.await(60, TimeUnit.SECONDS)
                }
                statusOf(asked)
            }
            "POST /sessions/write" -> write(body)
            "GET /requests/pending" -> json(200, synchronized(lock) { if (resolved) NO_REQUESTS else ONE_REQUEST })
            "POST /requests/resolve" -> {
                if (JSONObject(body).optString("requestId") == REQUEST_ID) synchronized(lock) { resolved = true }
                json(200, """{"accepted":true}""")
            }
            else -> json(500, """{"message":"Unreachable."}""")
        }
    }

    /** What the status route answers for [asked]: accepted once written, unknown once a failed write's, else absent. */
    private fun statusOf(asked: String?): MockResponse = synchronized(lock) {
        if (asked in written) {
            json(200, """{"status":"accepted","at":$AT}""")
        } else if (asked in failed) {
            json(200, """{"status":"unknown"}""")
        } else {
            json(200, """{"status":"absent"}""")
        }
    }

    /** The page ending before [before] (the end when absent), with no page before it. */
    private fun page(before: Long?): String = synchronized(lock) {
        val last = timeline.size.toLong()
        val items = timeline.withIndex()
            .filter { (i, _) -> before == null || i + 1 < before }
            .joinToString(",") { (i, event) -> """{"event":$event,"position":${position(i + 1L)},"at":${AT + i}}""" }
        """{"items":[$items],"before":null,"cursor":${position(last)},"truncated":false}"""
    }

    /**
     * A message the phone wrote: accepted, then the session's stream says it back at the next
     * position and answers "pong" at the one after, as an echo agent does.
     */
    private fun write(body: String): MockResponse {
        val input = JSONObject(body).optJSONObject("input")
        refuseWritesWith?.let { status -> return json(status, """{"message":"This device may not write to that session."}""") }
        if (failWrites) {
            input?.optString("clientMessageId")?.takeIf { it.isNotEmpty() }?.let { synchronized(lock) { failed += it } }
            return json(500, """{"message":"The stand-in is failing writes on purpose."}""")
        }
        if (input?.optString("type") == "interrupt") {
            synchronized(lock) {
                sessionState = "idle"
                stream("""{"type":"turn_interrupted"}""")
                stream("""{"type":"state_change","state":"idle"}""")
            }
            return json(200, """{"status":"accepted","at":$AT}""")
        }
        if (input?.optString("type") == "user_message") {
            synchronized(lock) {
                written += input.optString("clientMessageId")
                val echoed = JSONObject()
                    .put("type", "user_message")
                    .put("text", input.optString("text"))
                    .put("clientMessageId", input.optString("clientMessageId"))
                    .toString()
                stream(echoed)
                stream("""{"type":"assistant_text","delta":"pong","final":true}""")
            }
        }
        return json(200, """{"status":"accepted","at":$AT}""")
    }

    /** Appends one event to the timeline and sends it to every subscribed socket. Under [lock]. */
    private fun stream(event: String) {
        timeline += event
        val frame = """{"_tag":"stream","sessionId":"$SESSION_ID","stream":{"kind":"event","event":$event,"position":${position(timeline.size.toLong())}}}"""
        for (socket in subscribed) socket.send(frame)
    }

    /** The echo session as the routes and the subscription answer it, in its current state. */
    private fun session(): String = sessionJson(sessionState)

    private fun position(sequence: Long) = """{"generation":"$GENERATION","sequence":$sequence}"""

    private fun unknownSession() = json(422, """{"_tag":"SessionNotFound","message":"Unknown session"}""")

    private fun json(status: Int, body: String) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    /** One push socket: the hello, the subscription and the liveness ping, as the server answers them. */
    private inner class PushSocket : WebSocketListener() {
        @Volatile private var welcomed = false

        override fun onOpen(webSocket: WebSocket, response: Response) {
            openSockets.addIfAbsent(webSocket)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = JSONObject(text)
            when (val tag = frame.optString("_tag")) {
                "hello" -> {
                    val sent = frame.optString("token")
                    helloTokens += sent
                    if (sent != token) {
                        webSocket.close(4001, "unauthorized")
                    } else {
                        welcomed = true
                        webSocket.send("""{"_tag":"welcome","serverId":"stand-in","protocol":1,"version":"0.0.0-stand-in"}""")
                    }
                }
                "subscribe" -> {
                    if (!welcomed) return
                    val sessionId = frame.optString("sessionId")
                    if (sessionId == SESSION_ID) {
                        synchronized(lock) {
                            subscribed.addIfAbsent(webSocket)
                            webSocket.send("""{"_tag":"subscribed","sessionId":"$SESSION_ID","session":${session()}}""")
                        }
                    } else {
                        webSocket.send("""{"_tag":"error","sessionId":${JSONObject.quote(sessionId)},"message":"Unknown session"}""")
                    }
                }
                "unsubscribe" -> {
                    subscribed.remove(webSocket)
                    webSocket.send("""{"_tag":"unsubscribed","sessionId":${JSONObject.quote(frame.optString("sessionId"))}}""")
                }
                "ping" -> webSocket.send("""{"_tag":"pong"}""")
                else -> unknownFrames += tag
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            subscribed.remove(webSocket)
            openSockets.remove(webSocket)
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            subscribed.remove(webSocket)
            openSockets.remove(webSocket)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            subscribed.remove(webSocket)
            openSockets.remove(webSocket)
        }
    }

    companion object {
        const val SESSION_ID = "s-echo"
        const val WORKSPACE_ID = "ws-scratch"
        const val REQUEST_ID = "r-1"
        const val PUSH_PATH = "/push"
        private const val GENERATION = "g1"
        private const val AT = 1_700_000_000_000L

        /** The routes the stand-in answers, as `METHOD /path`; the push upgrade is apart. */
        val ROUTES = setOf(
            "GET /launch-profiles",
            "GET /workspaces",
            "GET /sessions",
            "GET /sessions/by-id",
            "GET /sessions/capabilities",
            "GET /sessions/timeline",
            "GET /sessions/writes",
            "POST /sessions/write",
            "GET /requests/pending",
            "POST /requests/resolve",
        )

        private fun sessionJson(state: String) =
            """{"id":"$SESSION_ID","provider":"echo","transport":"events","cwd":"/tmp/scratch","windowKey":"server",""" +
                """"workspaceId":"$WORKSPACE_ID","state":"$state","createdAt":$AT,"adapterId":"dev-echo-adapter","title":"Echo chat"}"""

        private val WORKSPACES =
            """{"version":1,"workspaces":[{"id":"$WORKSPACE_ID","name":"Scratch","rootDir":"/tmp/scratch","profileFile":null,""" +
                """"createdAt":$AT}],"lastActiveWorkspaceId":null,"activeWorkspaceId":null,"pins":[],"pinsMigrated":true,""" +
                """"revision":1,"instance":"stand-in"}"""

        private val ONE_REQUEST =
            """{"revision":1,"pending":[{"id":"$REQUEST_ID","sessionId":"$SESSION_ID","kind":"permission",""" +
                """"description":"Run ./gradlew test","createdAt":$AT,"options":[{"id":"deny","label":"Deny"},""" +
                """{"id":"allow","label":"Allow"}],"toolName":"Bash"}]}"""

        private val NO_REQUESTS = """{"revision":2,"pending":[]}"""
    }
}
