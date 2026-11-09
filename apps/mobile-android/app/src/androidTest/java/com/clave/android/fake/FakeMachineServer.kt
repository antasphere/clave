package com.clave.android.fake

import java.io.Closeable
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
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

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = answer(request)
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    /** The address the app is given, `http://127.0.0.1:<port>`. */
    val url: String = "http://127.0.0.1:${server.port}"

    override fun close() {
        for (socket in subscribed) socket.close(1001, "stand-in stopping")
        server.shutdown()
    }

    private fun answer(request: RecordedRequest): MockResponse {
        val url = request.requestUrl
        val path = url?.encodedPath ?: request.path.orEmpty().substringBefore('?')
        val method = request.method.orEmpty()
        if (method == "GET" && path == PUSH_PATH) return MockResponse().withWebSocketUpgrade(PushSocket())
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
            "GET /sessions" -> json(200, "[$SESSION]")
            "GET /sessions/by-id" -> if (id == SESSION_ID) json(200, SESSION) else unknownSession()
            "GET /sessions/capabilities" -> if (id == SESSION_ID) json(200, """{"images":false}""") else unknownSession()
            "GET /sessions/timeline" -> if (id == SESSION_ID) json(200, page(url?.queryParameter("before")?.toLongOrNull())) else unknownSession()
            "GET /sessions/writes" -> synchronized(lock) {
                if (url?.queryParameter("clientMessageId") in written) {
                    json(200, """{"status":"accepted","at":$AT}""")
                } else {
                    json(200, """{"status":"absent"}""")
                }
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

    private fun position(sequence: Long) = """{"generation":"$GENERATION","sequence":$sequence}"""

    private fun unknownSession() = json(422, """{"_tag":"SessionNotFound","message":"Unknown session"}""")

    private fun json(status: Int, body: String) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    /** One push socket: the hello, the subscription and the liveness ping, as the server answers them. */
    private inner class PushSocket : WebSocketListener() {
        @Volatile private var welcomed = false

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
                            webSocket.send("""{"_tag":"subscribed","sessionId":"$SESSION_ID","session":$SESSION}""")
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
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            subscribed.remove(webSocket)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            subscribed.remove(webSocket)
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

        private val SESSION =
            """{"id":"$SESSION_ID","provider":"echo","transport":"events","cwd":"/tmp/scratch","windowKey":"server",""" +
                """"workspaceId":"$WORKSPACE_ID","state":"idle","createdAt":$AT,"adapterId":"dev-echo-adapter","title":"Echo chat"}"""

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
