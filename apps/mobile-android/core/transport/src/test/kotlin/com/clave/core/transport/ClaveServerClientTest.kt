package com.clave.core.transport

import com.clave.core.contract.AgentState
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.SessionEvent
import com.clave.core.contract.SessionPosition
import com.clave.core.contract.SpawnOptions
import com.clave.core.contract.StartSessionInput
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.contract.WriteStatusKind
import com.clave.core.devices.BuildKind
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A stub of the audited routes (client.test.ts's), recording what it was asked. */
class ClaveServerClientTest {
    private data class Seen(val method: String, val path: String, val auth: String?, val accept: String?, val contentType: String?, val body: String?)

    private val seen = CopyOnWriteArrayList<Seen>()
    private lateinit var server: MockWebServer
    private lateinit var slowServer: MockWebServer
    private val http = OkHttpPort(OkHttpClient())

    private fun ok(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body)

    private fun handle(request: RecordedRequest): MockResponse {
        val body = request.body.clone().readUtf8()
        val auth = request.getHeader("Authorization")
        seen += Seen(request.method.orEmpty(), request.path.orEmpty(), auth, request.getHeader("Accept"), request.getHeader("Content-Type"), body.ifEmpty { null })
        val url = request.requestUrl!!
        if (auth != "Bearer $TOKEN") return ok("""{"error":"Unauthenticated"}""", 401)
        return when ("${request.method} ${url.encodedPath}") {
            "GET /sessions" -> ok("[$SESSION_JSON]")
            "GET /sessions/by-id" ->
                if (url.queryParameter("id") == "s1") ok(SESSION_JSON)
                else ok("""{"_tag":"SessionNotFound","id":"${url.queryParameter("id")}"}""", 422)
            "GET /sessions/timeline" -> ok(
                """{"items":[{"event":{"type":"user_message","text":"a"},"position":{"generation":"g","sequence":8}}],"before":8,"cursor":{"generation":"g","sequence":12},"truncated":true}""",
            )
            "GET /sessions/history" -> ok(
                """{"items":[{"event":{"type":"user_message","text":"page before ${url.queryParameter("before")}"}}],"before":${if (url.queryParameter("before") == null) "200" else "null"}}""",
            )
            "GET /sessions/capabilities" -> ok("""{"images":true}""")
            "GET /sessions/writes" ->
                if (url.queryParameter("clientMessageId") == "legacy") ok("""{"error":"no such route"}""", 404)
                else ok("""{"status":"accepted","at":5}""")
            "POST /sessions/start" ->
                if (body.contains("missing-agent")) {
                    ok("""{"_tag":"SessionStartFailed","message":"Program \"missing-agent\" was not found on this server (launch profile \"Missing\")"}""", 422)
                } else {
                    ok("""{"id":"s2","cwd":"/tmp/scratch","folderName":"scratch","alive":true,"claudeSessionId":null,"piSessionId":null}""")
                }
            "POST /sessions/restart" -> ok("""{"id":"s1","cwd":"/tmp/scratch","folderName":"scratch","alive":true,"claudeSessionId":"c1","piSessionId":null}""")
            "POST /sessions/stop" -> MockResponse().setResponseCode(204)
            "POST /sessions/write" -> when (json(body).jsonObject["id"]!!.jsonPrimitive.content) {
                "empty" -> MockResponse().setResponseCode(204)
                "malformed" -> ok("{}")
                "pending" -> ok("""{"status":"pending"}""")
                "unreadable" -> ok("not json at all")
                "broken" -> ok("""{"error":"boom"}""", 500)
                else -> ok("""{"status":"accepted"}""")
            }
            "GET /requests/pending" -> ok("""{"_tag":"CapabilityUnavailable","capability":"requests","message":"This server holds no pending requests."}""", 422)
            "POST /requests/resolve" -> ok("""{"accepted":true}""")
            "GET /launch-profiles" -> ok("""{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}""")
            "GET /workspaces" -> ok("""{"version":1,"workspaces":"not a list"}""")
            "GET /files/read" -> ok("""{"content":"hello","truncated":false,"size":5,"binary":false}""")
            "POST /files/attachments/prepare" ->
                if (body.contains("big.bin")) ok("""{"error":"Payload Too Large"}""", 413)
                else ok("""{"id":"f-1","path":"/tmp/session/attachments/photo.png","name":"photo.png","mimeType":"image/png","size":3,"delivery":"image"}""")
            else -> ok("""{"error":"no such route"}""", 404)
        }
    }

    @Before
    fun start() {
        server = loopbackServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        // The same routes, every answer 300 ms late: what a deadline is measured against.
        slowServer = loopbackServer()
        slowServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request).setBodyDelay(300, TimeUnit.MILLISECONDS)
        }
    }

    @After
    fun stop() {
        server.shutdown()
        slowServer.shutdown()
    }

    private fun client(timeoutMs: Long = 2_000, url: String = "${server.base()}/", bearer: String = TOKEN) =
        ClaveServerClient(Credential(url, bearer), http, BuildKind.Development, timeoutMs = timeoutMs)

    @Test
    fun `sends the bearer on every call and decodes the answer`() = runBlocking {
        val sessions = client().sessions.list()
        assertEquals(1, sessions.size)
        assertEquals("s1", sessions[0].id)
        assertEquals(AgentState.Idle, sessions[0].state)
        assertEquals(Seen("GET", "/sessions", "Bearer $TOKEN", "application/json", null, null), seen[0])
    }

    @Test
    fun `puts a query payload in the query string, and omits what is absent`() = runBlocking {
        val page = client().sessions.history("s1")
        assertEquals(200L, page.before)
        assertEquals("/sessions/history?id=s1", seen[0].path)
        val older = client().sessions.history("s1", 200, 50)
        assertNull(older.before)
        assertEquals("/sessions/history?id=s1&before=200&limit=50", seen[1].path)
    }

    @Test
    fun `reads the workspace stamp from the list and by-id responses`() = runBlocking {
        assertEquals("ws1", client().sessions.list()[0].workspaceId)
        assertEquals("ws1", client().sessions.get("s1").workspaceId)
        assertEquals(listOf("/sessions", "/sessions/by-id?id=s1"), seen.map { it.path })
    }

    @Test
    fun `posts a command as JSON`() = runBlocking {
        client().sessions.write("s1", SessionEvent.UserMessage(clientMessageId = "m-12345678", text = "hi"))
        val request = seen[0]
        assertEquals("POST", request.method)
        assertEquals("/sessions/write", request.path)
        assertEquals("application/json", request.contentType)
        assertEquals("Bearer $TOKEN", request.auth)
        assertJson("""{"id":"s1","input":{"type":"user_message","text":"hi","clientMessageId":"m-12345678"}}""", request.body)
    }

    @Test
    fun `decodes accepted and pending write outcomes, and refuses empty or malformed 2xx`() = runBlocking {
        val input = SessionEvent.UserMessage(clientMessageId = "message-123", text = "hi")
        assertEquals(WriteAnswerStatus.Accepted, client().sessions.write("s1", input).status)
        assertEquals(WriteAnswerStatus.Pending, client().sessions.write("pending", input).status)
        for (id in listOf("empty", "malformed")) {
            assertEquals(ServerError.Kind.Protocol, serverErrorOf { client().sessions.write(id, input) }.kind)
        }
    }

    @Test
    fun `every route sends its method, path, query and body`() = runBlocking {
        val c = client()
        val info = c.sessions.start(StartSessionInput(cwd = "/tmp/scratch"))
        assertEquals("s2", info.id)
        c.sessions.stop("s1")
        assertEquals("c1", c.sessions.restart("s1").claudeSessionId)
        assertTrue(c.sessions.capabilities("s1").images)
        val status = c.sessions.writeStatus("s1", "m 1")
        assertEquals(WriteStatusKind.Accepted, status.status)
        assertEquals(5L, status.at)
        assertTrue(c.launchProfiles.list().customProfiles.isEmpty())
        assertTrue(c.requests.resolve("r1", RequestResponse.Permission(optionId = "allow")).accepted)
        val file = c.files.read("/root dir", "a/b.txt")
        assertEquals("hello", file.content)
        assertEquals(5L, file.size)

        assertEquals(
            listOf(
                "POST /sessions/start",
                "POST /sessions/stop",
                "POST /sessions/restart",
                "GET /sessions/capabilities?id=s1",
                "GET /sessions/writes?id=s1&clientMessageId=m+1",
                "GET /launch-profiles",
                "POST /requests/resolve",
                "GET /files/read?root=%2Froot+dir&path=a%2Fb.txt",
            ),
            seen.map { "${it.method} ${it.path}" },
        )
        assertTrue(seen.all { it.auth == "Bearer $TOKEN" && it.accept == "application/json" })
        assertJson("""{"cwd":"/tmp/scratch"}""", seen[0].body)
        assertJson("""{"id":"s1"}""", seen[1].body)
        assertJson("""{"id":"s1","account":{}}""", seen[2].body)
        assertNull(seen[3].body)
        assertNull(seen[3].contentType)
        assertJson("""{"requestId":"r1","response":{"type":"permission","optionId":"allow"}}""", seen[6].body)
    }

    @Test
    fun `a 401 is unauthenticated`() = runBlocking {
        val error = serverErrorOf { client(bearer = "wrong").sessions.list() }
        assertEquals(ServerError.Kind.Unauthenticated, error.kind)
        assertEquals(401, error.status)
        assertEquals("The server refused the token.", error.message)
    }

    @Test
    fun `a 403 is the device-session boundary, in the server's words, and is never retried`() = runBlocking {
        val scoped = loopbackServer()
        try {
            scoped.enqueue(ok("""{"error":"Forbidden","message":"A phone may not do this."}""", 403))
            // What a retry would get: never asked for.
            scoped.enqueue(ok("[$SESSION_JSON]"))
            val c = ClaveServerClient(Credential(scoped.base(), TOKEN), http, BuildKind.Development)
            val error = serverErrorOf { c.sessions.list() }
            assertEquals(ServerError.Kind.Forbidden, error.kind)
            assertEquals(403, error.status)
            assertEquals("A phone may not do this.", error.message)
            assertNull(error.failure)
            assertFalse(error.capabilityUnavailable)
            Thread.sleep(200)
            assertEquals(1, scoped.requestCount)
        } finally {
            scoped.shutdown()
        }
    }

    @Test
    fun `a 403 without a readable reason still names the boundary`() = runBlocking {
        val scoped = loopbackServer()
        try {
            scoped.enqueue(MockResponse().setResponseCode(403).setBody("<html>no</html>"))
            val c = ClaveServerClient(Credential(scoped.base(), TOKEN), http, BuildKind.Development)
            val error = serverErrorOf { c.workspaces.load() }
            assertEquals(ServerError.Kind.Forbidden, error.kind)
            assertEquals("This phone may not do that on the machine.", error.message)
            assertEquals(1, scoped.requestCount)
        } finally {
            scoped.shutdown()
        }
    }

    @Test
    fun `a 422 is a refusal in the server's words, the failure kept`() = runBlocking {
        val profile = LaunchProfileView(id = "x", name = "Missing", family = LauncherFamily.Claude, command = listOf("missing-agent"), additionalArgs = emptyList())
        val error = serverErrorOf {
            client().sessions.start(
                StartSessionInput(cwd = "/tmp/scratch", options = SpawnOptions(claudeMode = true, launchProfileId = "x", launchProfile = profile)),
            )
        }
        assertEquals(ServerError.Kind.Refused, error.kind)
        assertEquals(422, error.status)
        assertEquals("Program \"missing-agent\" was not found on this server (launch profile \"Missing\")", error.message)
        assertEquals("SessionStartFailed", error.failure?.tag)
    }

    @Test
    fun `CapabilityUnavailable is a refusal the caller can tell apart`() = runBlocking {
        val error = serverErrorOf { client().requests.list() }
        assertEquals(ServerError.Kind.Refused, error.kind)
        assertTrue(error.capabilityUnavailable)
        assertEquals("requests", error.failure?.capability)
    }

    @Test
    fun `a 422 without a message still has a sentence`() = runBlocking {
        val error = serverErrorOf { client().sessions.get("nope") }
        assertEquals(ServerError.Kind.Refused, error.kind)
        assertEquals("SessionNotFound", error.failure?.tag)
        assertTrue(error.message!!.contains("SessionNotFound"))
    }

    @Test
    fun `a 422 without a readable reason is a protocol answer`() = runBlocking {
        val scoped = loopbackServer()
        try {
            scoped.enqueue(MockResponse().setResponseCode(422).setBody("nope"))
            val c = ClaveServerClient(Credential(scoped.base(), TOKEN), http, BuildKind.Development)
            val error = serverErrorOf { c.sessions.list() }
            assertEquals(ServerError.Kind.Protocol, error.kind)
            assertEquals("The server refused (422) without a readable reason.", error.message)
        } finally {
            scoped.shutdown()
        }
    }

    @Test
    fun `a 404 on writeStatus is a protocol answer with its status, which the chat reads as unknown`() = runBlocking {
        val error = serverErrorOf { client().sessions.writeStatus("s1", "legacy") }
        assertEquals(ServerError.Kind.Protocol, error.kind)
        assertEquals(404, error.status)
    }

    @Test
    fun `a 500 is a protocol answer naming the status`() = runBlocking {
        val error = serverErrorOf { client().sessions.write("broken", SessionEvent.UserMessage(text = "hi")) }
        assertEquals(ServerError.Kind.Protocol, error.kind)
        assertEquals(500, error.status)
        assertEquals("The server answered 500.", error.message)
    }

    @Test
    fun `an unreadable 200 is a protocol answer`() = runBlocking {
        val error = serverErrorOf { client().sessions.write("unreadable", SessionEvent.UserMessage(text = "hi")) }
        assertEquals(ServerError.Kind.Protocol, error.kind)
        assertEquals("The server answered something unreadable.", error.message)
    }

    @Test
    fun `an answer of the wrong shape is a protocol error naming the route and the path`() = runBlocking {
        val error = serverErrorOf { client().workspaces.load() }
        assertEquals(ServerError.Kind.Protocol, error.kind)
        assertTrue(error.message, error.message!!.contains("/workspaces"))
        assertTrue(error.message, error.message!!.contains("workspaces.workspaces"))
    }

    @Test
    fun `a server that answers past the deadline is a timeout`() = runBlocking {
        val slow = ClaveServerClient(Credential(slowServer.base(), TOKEN), http, BuildKind.Development, timeoutMs = 100)
        val error = serverErrorOf { slow.sessions.list() }
        assertEquals(ServerError.Kind.Timeout, error.kind)
        assertEquals("The server did not answer within 0.1 s.", error.message)
    }

    @Test
    fun `a closed port is a network error`() = runBlocking {
        val gone = ClaveServerClient(Credential("http://127.0.0.1:${closedPort()}", TOKEN), http, BuildKind.Development)
        val error = serverErrorOf { gone.sessions.list() }
        assertEquals(ServerError.Kind.Network, error.kind)
        assertEquals("The server could not be reached.", error.message)
    }

    @Test
    fun `a page of history runs under the long deadline`() = runBlocking {
        val quick = ClaveServerClient(Credential(slowServer.base(), TOKEN), http, BuildKind.Development, timeoutMs = 100, historyTimeoutMs = 2_000)
        assertTrue(quick.sessions.history("s1").items.isNotEmpty())
        assertEquals(ServerError.Kind.Timeout, serverErrorOf { quick.sessions.list() }.kind)
    }

    @Test
    fun `requests timeline paging by exclusive sequence under the long history deadline`() = runBlocking {
        val quick = ClaveServerClient(Credential(slowServer.base(), TOKEN), http, BuildKind.Development, timeoutMs = 100, historyTimeoutMs = 2_000)
        val page = quick.sessions.timeline("s1", 9, 10)
        assertEquals(SessionPosition("g", 12), page.cursor)
        assertEquals(8L, page.before)
        assertTrue(page.truncated)
        assertEquals("/sessions/timeline?id=s1&before=9&limit=10", seen.last().path)
    }

    @Test
    fun `a release build refuses a plain-http address before any request`() {
        val error = runCatching {
            ClaveServerClient(Credential(server.base(), TOKEN), http, BuildKind.Release)
        }.exceptionOrNull()
        assertTrue(error is ServerError)
        assertEquals(ServerError.Kind.Policy, (error as ServerError).kind)
        assertFalse(error.message!!.contains(TOKEN))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `a development build allows the loopback and refuses a plain-http LAN address`() {
        ClaveServerClient(Credential("http://127.0.0.1:43201", TOKEN), http, BuildKind.Development)
        ClaveServerClient(Credential("https://relay.example/m/abc", TOKEN), http, BuildKind.Release)
        val lan = runCatching {
            ClaveServerClient(Credential("http://192.168.1.10:43201", TOKEN), http, BuildKind.Development)
        }.exceptionOrNull() as ServerError
        assertEquals(ServerError.Kind.Policy, lan.kind)
    }

    // ── the upload (attachments.test.ts) ──

    @Test
    fun `uploads through the files route with the device credential`() = runBlocking {
        val c = ClaveServerClient(Credential(server.base(), "fixture-device-session"), http, BuildKind.Development)
        val unauthorized = serverErrorOf { c.attachments.prepareUpload("s-1", "photo.png", "YWJj", image = true) }
        assertEquals(ServerError.Kind.Unauthenticated, unauthorized.kind)
        assertEquals("Bearer fixture-device-session", seen[0].auth)
        seen.clear()
        val record = client().attachments.prepareUpload("s-1", "photo.png", "YWJj", image = true)
        assertEquals("f-1", record.id)
        assertEquals("/tmp/session/attachments/photo.png", record.path)
        assertEquals("image/png", record.mimeType)
        assertEquals(3L, record.size)
        assertEquals(FileDelivery.Image, record.delivery)
        assertEquals("POST", seen[0].method)
        assertEquals("/files/attachments/prepare", seen[0].path)
        assertEquals("Bearer $TOKEN", seen[0].auth)
        assertJson("""{"sessionId":"s-1","source":{"kind":"upload","name":"photo.png","base64":"YWJj","image":true}}""", seen[0].body)
    }

    @Test
    fun `an upload past the server's size bound is a refusal`() = runBlocking {
        val error = serverErrorOf { client().attachments.prepareUpload("s-1", "big.bin", "AAAA", image = false) }
        assertEquals(ServerError.Kind.Refused, error.kind)
        assertEquals(413, error.status)
        assertEquals("The file is larger than the server takes in one upload.", error.message)
    }

    @Test
    fun `an upload runs under its own deadline`() = runBlocking {
        val c = ClaveServerClient(Credential(slowServer.base(), TOKEN), http, BuildKind.Development, timeoutMs = 100, uploadTimeoutMs = 2_000)
        assertEquals("f-1", c.attachments.prepareUpload("s-1", "photo.png", "YWJj", image = true).id)
        val short = ClaveServerClient(Credential(slowServer.base(), TOKEN), http, BuildKind.Development, uploadTimeoutMs = 100)
        val error = serverErrorOf { short.attachments.prepareUpload("s-1", "photo.png", "YWJj", image = true) }
        assertEquals(ServerError.Kind.Timeout, error.kind)
        assertEquals("The upload did not finish within 0.1 s.", error.message)
    }

    @Test
    fun `an upload answer of the wrong shape names the field`() = runBlocking {
        val scoped = loopbackServer()
        try {
            scoped.enqueue(ok("""{"id":"f-1","path":"/p","name":"n","mimeType":"image/png","size":3,"delivery":"session"}"""))
            val c = ClaveServerClient(Credential(scoped.base(), TOKEN), http, BuildKind.Development)
            val error = serverErrorOf { c.attachments.prepareUpload("s-1", "n", "YWJj", image = true) }
            assertEquals(ServerError.Kind.Protocol, error.kind)
            assertTrue(error.message, error.message!!.contains("attachment.delivery"))
        } finally {
            scoped.shutdown()
        }
    }

    @Test
    fun `a release upload refuses plain HTTP before sending a credential`() {
        val error = runCatching {
            ClaveServerClient(Credential(server.base(), "fixture-device-session"), http, BuildKind.Release)
        }.exceptionOrNull() as ServerError
        assertEquals(ServerError.Kind.Policy, error.kind)
        assertEquals(0, server.requestCount)
    }

    // ── the error and the credential ──

    @Test
    fun `a credential never prints its bearer`() {
        val text = Credential("https://relay.example/m/abc", TOKEN).toString()
        assertEquals("Credential(serverUrl=https://relay.example/m/abc, bearer=<hidden>)", text)
        assertFalse(text.contains(TOKEN))
    }

    @Test
    fun `messageOf answers the sentence of any error`() {
        assertEquals("The server answered 500.", messageOf(ServerError(ServerError.Kind.Protocol, "The server answered 500.", 500)))
        assertEquals("boom", messageOf(IllegalStateException("boom")))
        assertTrue(messageOf(IllegalStateException()).contains("IllegalStateException"))
    }

    @Test
    fun `a stub port that ignores the deadline is still bounded`() = runBlocking {
        val hanging = com.clave.core.ports.HttpPort { kotlinx.coroutines.awaitCancellation() }
        val c = ClaveServerClient(Credential("https://relay.example/m/abc", TOKEN), hanging, BuildKind.Release, timeoutMs = 50)
        assertEquals(ServerError.Kind.Timeout, serverErrorOf { c.sessions.list() }.kind)
    }
}
