package com.clave.core.transport

import com.clave.core.contract.UsageRead
import com.clave.core.devices.BuildKind
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The shell's reads on the wire: each one a GET of its exact path with no payload, and an
 * older server's refusal (a 403 of the device scope, a 404 of a route it lacks) surfacing as
 * the ServerError the shell reads as "not on this Mac yet", never as a protocol fault.
 */
class ShellReadsClientTest {
    private val seen = CopyOnWriteArrayList<String>()
    private lateinit var server: MockWebServer
    private val http = OkHttpPort(OkHttpClient())
    private var older = false

    private fun ok(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body)

    private fun handle(request: RecordedRequest): MockResponse {
        seen += "${request.method} ${request.path}"
        if (request.getHeader("Authorization") != "Bearer $TOKEN") return ok("{}", 401)
        if (older) {
            return if (request.path == "/sidebar/overview") ok("""{"message":"This phone may not read that."}""", 403)
            else ok("""{"error":"no such route"}""", 404)
        }
        return when (request.path) {
            "/sidebar/overview" -> ok("""{"windows":[{"windowKey":"main","displayOrder":["g1"],"groups":[{"id":"g1","name":"Auth","collapsed":false,"sessionIds":["s1"]}]}]}""")
            "/accounts/claude" -> ok("""[{"id":"a1","label":"Work","hasToken":true,"tokenSetAt":1,"tokenExpiresAt":2,"tokenInvalid":false}]""")
            "/accounts/codex" -> ok("""[{"id":"c1","label":"Home","kind":"apiKey","hasCredential":true}]""")
            "/usage/claude/snapshot" -> ok("""{"a1":{"windows":[],"fetchedAt":7}}""")
            "/usage/codex/snapshot" -> ok("""{"c1":{"error":"No read yet"}}""")
            "/server/info" -> ok("""{"version":"1.42.0","installRef":null,"upgrade":{"state":"idle"}}""")
            else -> ok("""{"error":"no such route"}""", 404)
        }
    }

    @Before
    fun start() {
        server = loopbackServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun client() = ClaveServerClient(Credential("${server.base()}/", TOKEN), http, BuildKind.Development, timeoutMs = 2_000)

    @Test
    fun `each read is a GET of its own path`() = runBlocking {
        val c = client()
        assertEquals("Auth", c.sidebar.overview().windows.single().groups.single().name)
        assertEquals("a1", c.accounts.claude().single().id)
        assertEquals("apiKey", c.accounts.codex().single().kind)
        assertEquals(UsageRead.Limits(emptyList(), 7), c.usage.claudeSnapshot()["a1"])
        assertEquals(UsageRead.Failed("No read yet"), c.usage.codexSnapshot()["c1"])
        assertEquals("1.42.0", c.server.info().version)
        assertEquals(
            listOf(
                "GET /sidebar/overview",
                "GET /accounts/claude",
                "GET /accounts/codex",
                "GET /usage/claude/snapshot",
                "GET /usage/codex/snapshot",
                "GET /server/info",
            ),
            seen.toList(),
        )
    }

    @Test
    fun `an older server's refusal is a 403 or a 404, asked once`() = runBlocking {
        older = true
        val forbidden = serverErrorOf { client().sidebar.overview() }
        assertEquals(ServerError.Kind.Forbidden, forbidden.kind)
        assertEquals("This phone may not read that.", forbidden.message)
        val missing = serverErrorOf { client().accounts.claude() }
        assertEquals(404, missing.status)
        assertTrue(isUnsupportedRead(forbidden) && isUnsupportedRead(missing))
        assertEquals(2, seen.size)
    }

    @Test
    fun `a network failure is not an unsupported read`() {
        assertEquals(false, isUnsupportedRead(ServerError(ServerError.Kind.Network, "The server could not be reached.")))
        assertEquals(false, isUnsupportedRead(ServerError(ServerError.Kind.Protocol, "The server answered 500.", 500)))
    }
}
