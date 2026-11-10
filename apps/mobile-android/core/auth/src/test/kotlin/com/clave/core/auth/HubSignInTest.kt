package com.clave.core.auth

import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.Collections

/**
 * The sign-in against [FakeIssuer], the local provider, over real HTTP on the loopback:
 * nothing here reaches account.antasphere.com. The clock is the test's own, shared with
 * the provider, so a token issued "now" lapses when the test moves the clock; the
 * renew-ahead margin is one second (a minute in the app) unless a test says otherwise.
 * runBlocking, not runTest: the HTTP runs on real threads and a virtual clock would
 * fire the request deadline at once.
 */
class HubSignInTest {
    private lateinit var clock: TestClock
    private lateinit var fake: FakeIssuer
    private lateinit var store: RecordingSecureStore
    private val http = UrlConnectionHttpPort()
    private val events: MutableList<Pair<String, Map<String, Any?>>> = Collections.synchronizedList(mutableListOf())
    private val log = object : Log {
        override fun event(name: String, fields: Map<String, Any?>) {
            events.add(name to fields)
        }
    }

    private val browser: OpenAuthSession = { url, _ -> withContext(Dispatchers.IO) { fake.browse(url) } }

    @Before
    fun setUp() {
        clock = TestClock()
        fake = FakeIssuer { clock.nowMs }
        store = RecordingSecureStore()
    }

    @After
    fun tearDown() {
        fake.close()
    }

    private fun make(
        issuer: String? = fake.issuer,
        openAuthSession: OpenAuthSession = browser,
        secureStore: RecordingSecureStore = store,
        http: HttpPort = this.http,
        renewAheadMs: Long = 1_000,
    ) = HubSignIn(
        SignInDeps(
            issuer = issuer,
            http = http,
            secureStore = secureStore,
            crypto = JvmCrypto,
            openAuthSession = openAuthSession,
            clock = clock,
            renewAheadMs = renewAheadMs,
            log = log,
        ),
    )

    private suspend fun failureOf(run: suspend () -> Any?): AuthFailure {
        try {
            run()
        } catch (e: AuthError) {
            return e.failure
        }
        fail("did not fail")
        error("unreachable")
    }

    private fun assertNothingKept(target: RecordingSecureStore = store) {
        for (key in listOf(StoreKeys.SESSION, StoreKeys.REFRESH_TOKEN, StoreKeys.ACCESS_TOKEN, StoreKeys.ID_TOKEN)) {
            assertFalse(key, target.map.containsKey(key))
        }
    }

    // The registration

    @Test
    fun `registers once as an anonymous public native client and reuses it`() = runBlocking {
        val signIn = make()
        val first = signIn.signIn()
        assertEquals(AuthPhase.SignedIn, first.phase)
        assertEquals(1, fake.registrations.size)
        val sent = fake.registrations[0].sent
        assertEquals(JsonPrimitive("Clave"), sent["client_name"])
        assertEquals(JsonPrimitive("native"), sent["type"])
        assertEquals(JsonPrimitive("native"), sent["application_type"])
        assertEquals(JsonArray(listOf(JsonPrimitive(REDIRECT_URI))), sent["redirect_uris"])
        assertEquals(JsonPrimitive("none"), sent["token_endpoint_auth_method"])
        assertEquals(JsonArray(listOf(JsonPrimitive("authorization_code"), JsonPrimitive("refresh_token"))), sent["grant_types"])
        assertEquals(JsonArray(listOf(JsonPrimitive("code"))), sent["response_types"])
        assertEquals(JsonPrimitive(SCOPE), sent["scope"])
        signIn.signOut()
        assertEquals(AuthPhase.SignedOut, signIn.status().phase)
        val second = signIn.signIn()
        assertEquals(AuthPhase.SignedIn, second.phase)
        assertEquals(1, fake.registerCount.get())
        assertEquals(first.clientId, second.clientId)
    }

    @Test
    fun `a registration answered 200, as the hub does, is a registration`() = runBlocking {
        fake.registrationStatus = 200
        assertEquals(AuthPhase.SignedIn, make().signIn().phase)
    }

    @Test
    fun `a refused, confidential or code-less registration is refused and nothing is kept`() = runBlocking {
        val knobs: List<(FakeIssuer) -> Unit> = listOf(
            { it.refuseRegistrationOnce = 403 },
            { it.confidentialNext = true },
            { it.grantTypesOverride = listOf("refresh_token") },
        )
        for (knob in knobs) {
            val target = RecordingSecureStore()
            knob(fake)
            val status = make(secureStore = target).signIn()
            assertEquals(AuthPhase.SignedOut, status.phase)
            assertEquals(AuthFailure.Registration, status.lastFailure)
            assertTrue(target.map.isEmpty())
            fake.grantTypesOverride = null
        }
        assertEquals(0, fake.authorizeCount.get())
    }

    @Test
    fun `metadata naming an endpoint off the issuer is refused before any request leaves the origin`() = runBlocking {
        val foreign = MockWebServer()
        foreign.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            fake.foreignTokenEndpoint = "http://127.0.0.1:${foreign.port}/token"
            val status = make().signIn()
            assertEquals(AuthPhase.SignedOut, status.phase)
            assertEquals(AuthFailure.InvalidResponse, status.lastFailure)
            assertEquals(0, fake.registerCount.get())
            assertEquals(0, foreign.requestCount)
        } finally {
            foreign.shutdown()
        }
    }

    // The code flow

    @Test
    fun `signs in with PKCE S256 and keeps the identity and the three tokens`() = runBlocking {
        val signIn = make()
        val status = signIn.signIn()
        assertEquals(AuthPhase.SignedIn, status.phase)
        assertEquals(StoredAccount("user-7f3a", "Ada Example", "ada@example.test", true), status.account)
        assertTrue(status.renewable)
        assertTrue(status.expiresAt!! > clock.nowMs)
        assertEquals(fake.issuer, status.issuer)
        assertEquals(status, signIn.status.value)
        val exchange = fake.tokenForms().single()
        assertEquals("authorization_code", exchange["grant_type"])
        assertEquals(REDIRECT_URI, exchange["redirect_uri"])
        assertTrue(exchange["code_verifier"]!!.length >= 43)
        assertEquals(status.clientId, exchange["client_id"])
        for (key in StoreKeys.ALL) assertTrue(key, store.map.containsKey(key))
        val id = Json.parseToJsonElement(store.map[StoreKeys.ID_TOKEN]!!).jsonObject["token"].stringOrNull()!!
        assertEquals(listOf(status.clientId), decodeIdToken(id).aud)
        val access = signIn.accessToken()
        assertTrue(access.startsWith("at-"))
        assertEquals(id, signIn.idToken())
        assertEquals(0, fake.refreshCount.get())
        // The log carries codes only: no token, no code, no verifier.
        val secrets = listOf(access, id, store.map[StoreKeys.REFRESH_TOKEN]!!, exchange["code"]!!, exchange["code_verifier"]!!)
        for ((_, fields) in events) for (value in fields.values) for (secret in secrets) {
            assertFalse(value.toString().contains(secret))
        }
    }

    @Test
    fun `a refused authorization is said as denied`() = runBlocking {
        fake.denyNext = true
        val status = make().signIn()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertEquals(AuthFailure.Denied, status.lastFailure)
    }

    @Test
    fun `a dismissed browser is cancelled`() = runBlocking {
        val status = make(openAuthSession = { _, _ -> null }).signIn()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertEquals(AuthFailure.Cancelled, status.lastFailure)
        assertEquals(0, fake.tokenCount.get())
    }

    @Test
    fun `a second ask while the browser is open joins the first`() = runBlocking {
        val opened = CompletableDeferred<Unit>()
        val held = CompletableDeferred<String?>()
        var opens = 0
        val signIn = make(openAuthSession = { _, _ ->
            opens++
            opened.complete(Unit)
            held.await()
        })
        val first = async { signIn.signIn() }
        val second = async { signIn.signIn() }
        awaitGate("the browser to open", opened)
        assertEquals(AuthPhase.SigningIn, signIn.status().phase)
        assertEquals(AuthPhase.SigningIn, signIn.status.value.phase)
        held.complete(null)
        val a = awaitGate("the first sign-in to end", first)
        val b = awaitGate("the second sign-in to end", second)
        assertEquals(a, b)
        assertEquals(AuthFailure.Cancelled, a.lastFailure)
        assertEquals(1, opens)
    }

    private fun rewriting(change: (String) -> String): OpenAuthSession = { url, redirect -> change(browser(url, redirect)!!) }

    @Test
    fun `a redirect that is not exactly what was asked is refused before any exchange`() = runBlocking {
        val forgeries = listOf<(String) -> String>(
            { it.replace(Regex("state=[^&]*"), "state=forged") },
            { "$it&state=second" },
            { it.replace(Regex("state=[^&]*&?"), "") },
            { it.replace(Regex("iss=[^&]*"), "iss=https%3A%2F%2Fevil.test") },
            { it.replace(Regex("&?code=[^&]*"), "") },
            { "$it&error=server_error" },
            { it.replace(REDIRECT_URI, "https://evil.test/cb") },
            { it.replace(REDIRECT_URI, "clave-android://oauth/elsewhere") },
            { it.replace(REDIRECT_URI, "clave://oauth/callback") },
        )
        for ((index, forge) in forgeries.withIndex()) {
            val status = make(openAuthSession = rewriting(forge), secureStore = RecordingSecureStore()).signIn()
            assertEquals("forgery $index", AuthFailure.InvalidResponse, status.lastFailure)
            assertEquals("forgery $index", AuthPhase.SignedOut, status.phase)
        }
        assertEquals(0, fake.tokenCount.get())
    }

    @Test
    fun `an unreachable issuer is a network failure`() = runBlocking {
        val status = make(http = HttpPort { throw HttpFailure.Network() }).signIn()
        assertEquals(AuthFailure.Network, status.lastFailure)
    }

    @Test
    fun `a slow issuer is a timeout`() = runBlocking {
        val hub = HubClient(IssuerConfig(fake.issuer, insecure = true), http, timeoutMs = 300)
        val clientId = hub.register()
        fake.tokenDelayMs = 2_000
        try {
            hub.exchangeCode(clientId, "code", "verifier")
            fail("no timeout")
        } catch (e: HubError) {
            assertEquals(HubFailure.Timeout, e.kind)
        }
    }

    @Test
    fun `every tampered ID token is refused by its shape and nothing is kept`() = runBlocking {
        val nowSec = clock.nowMs / 1000
        val tampers = listOf(
            "issuer" to FakeIssuer.Tamper(iss = "https://evil.test"),
            "audience" to FakeIssuer.Tamper(aud = "another-client"),
            "authorized party" to FakeIssuer.Tamper(azp = "another-client"),
            "expired" to FakeIssuer.Tamper(exp = nowSec - 3600),
            "not yet valid" to FakeIssuer.Tamper(iat = nowSec + 3600),
            "nonce" to FakeIssuer.Tamper(nonce = "stale"),
            "algorithm" to FakeIssuer.Tamper(alg = "HS256"),
        )
        for ((name, tamper) in tampers) {
            val target = RecordingSecureStore()
            fake.tamper = tamper
            val status = make(secureStore = target).signIn()
            assertEquals(name, AuthPhase.SignedOut, status.phase)
            assertEquals(name, AuthFailure.InvalidResponse, status.lastFailure)
            assertNothingKept(target)
        }
        assertEquals(tampers.size, fake.tokenCount.get())
    }

    @Test
    fun `leaves the signature to the server - a token signed with another key passes the shape`() = runBlocking {
        fake.tamper = FakeIssuer.Tamper(otherKey = true)
        assertEquals(AuthPhase.SignedIn, make().signIn().phase)
    }

    // The refresh

    @Test
    fun `accessToken renews within a minute of the end and not before`() = runBlocking {
        val signIn = make(renewAheadMs = RENEW_AHEAD_MS)
        signIn.signIn()
        val first = signIn.accessToken()
        clock.advance(3_600_000 - 61_000)
        assertEquals(first, signIn.accessToken())
        assertEquals(0, fake.refreshCount.get())
        clock.advance(2_000)
        val renewed = signIn.accessToken()
        assertEquals(1, fake.refreshCount.get())
        assertNotEquals(first, renewed)
    }

    @Test
    fun `two asks during a lapse cause exactly one refresh, the rotated token kept first`() = runBlocking {
        fake.accessTokenTtlSec = 10
        val signIn = make()
        signIn.signIn()
        val firstRefresh = store.map[StoreKeys.REFRESH_TOKEN]
        val mark = store.writes.size
        clock.advance(11_000)
        fake.tokenDelayMs = 300
        val a = async { signIn.accessToken() }
        val b = async { signIn.accessToken() }
        assertEquals(awaitGate("the first ask's token", a), awaitGate("the second ask's token", b))
        fake.tokenDelayMs = 0
        assertEquals(1, fake.refreshCount.get())
        val writes = store.writes.subList(mark, store.writes.size).toList()
        assertTrue(writes.indexOf(StoreKeys.REFRESH_TOKEN) >= 0)
        assertTrue(writes.indexOf(StoreKeys.REFRESH_TOKEN) < writes.indexOf(StoreKeys.ACCESS_TOKEN))
        val rotated = store.map[StoreKeys.REFRESH_TOKEN]
        assertNotEquals(firstRefresh, rotated)
        assertEquals(a.await(), signIn.accessToken())
        assertEquals(1, fake.refreshCount.get())
        clock.advance(11_000)
        signIn.accessToken()
        val refreshes = fake.tokenForms().filter { it["grant_type"] == "refresh_token" }
        assertEquals(2, refreshes.size)
        assertEquals(rotated, refreshes[1]["refresh_token"])
    }

    @Test
    fun `invalid_grant drops the whole family and signs the person out`() = runBlocking {
        fake.accessTokenTtlSec = 10
        val signIn = make()
        signIn.signIn()
        fake.revokeRefreshTokens()
        clock.advance(11_000)
        assertEquals(AuthFailure.Expired, failureOf { signIn.accessToken() })
        val status = signIn.status()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertEquals(AuthFailure.Expired, status.lastFailure)
        assertNothingKept()
        assertTrue(store.map.containsKey(StoreKeys.CLIENT))
    }

    @Test
    fun `invalid_client registers again at once and signs out as client-purged`() = runBlocking {
        fake.accessTokenTtlSec = 10
        val signIn = make()
        val first = signIn.signIn()
        fake.purgeClients()
        clock.advance(11_000)
        assertEquals(AuthFailure.ClientPurged, failureOf { signIn.accessToken() })
        assertEquals(2, fake.registerCount.get())
        assertEquals(AuthPhase.SignedOut, signIn.status().phase)
        assertEquals(AuthFailure.ClientPurged, signIn.status().lastFailure)
        assertNothingKept()
        val stored = Json.parseToJsonElement(store.map[StoreKeys.CLIENT]!!).jsonObject["clientId"].stringOrNull()
        assertNotEquals(first.clientId, stored)
        assertEquals(fake.registrations[0].clientId, stored)
        val again = signIn.signIn()
        assertEquals(AuthPhase.SignedIn, again.phase)
        assertEquals(stored, again.clientId)
    }

    @Test
    fun `a network failure during the refresh keeps the session for later`() = runBlocking {
        fake.accessTokenTtlSec = 10
        val signIn = make()
        signIn.signIn()
        clock.advance(11_000)
        fake.close()
        assertEquals(AuthFailure.Network, failureOf { signIn.accessToken() })
        assertEquals(AuthPhase.SignedIn, signIn.status().phase)
        assertEquals(AuthFailure.Network, signIn.status().lastFailure)
        assertTrue(store.map.containsKey(StoreKeys.REFRESH_TOKEN))
        assertTrue(store.map.containsKey(StoreKeys.SESSION))
    }

    @Test
    fun `renews the ID token, and a refresh that brings none asks for a new sign-in`() = runBlocking {
        fake.idTokenTtlSec = 10
        val signIn = make()
        signIn.signIn()
        clock.advance(11_000)
        val renewed = signIn.idToken()
        assertEquals(1, fake.refreshCount.get())
        assertTrue(decodeIdToken(renewed).exp * 1000 > clock.nowMs)
        assertNull(decodeIdToken(renewed).nonce)
        fake.bareRefresh = true
        clock.advance(11_000)
        assertEquals(AuthFailure.Expired, failureOf { signIn.idToken() })
        assertEquals(AuthPhase.SignedIn, signIn.status().phase)
    }

    @Test
    fun `a caller waiting on a refresh never gets the next owner's token`() = runBlocking {
        for (asksAccess in listOf(true, false)) {
            fake.close()
            fake = FakeIssuer { clock.nowMs }
            fake.idTokenTtlSec = 10
            fake.accessTokenTtlSec = 10
            val target = RecordingSecureStore()
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val gated = HttpPort { request ->
                val response = http.send(request)
                if (request.body?.contains("grant_type=refresh_token") == true) {
                    entered.complete(Unit)
                    release.await()
                }
                response
            }
            val signIn = make(secureStore = target, http = gated)
            signIn.signIn()
            clock.advance(11_000)
            val oldCaller = async { failureOf { if (asksAccess) signIn.accessToken() else signIn.idToken() } }
            awaitGate("the refresh to reach the issuer", entered)
            signIn.signOut()
            fake.user = FakeIssuer.User("owner-B", "B", "b@example.test", true)
            signIn.signIn()
            assertEquals("owner-B", signIn.status().account?.subject)
            release.complete(Unit)
            assertEquals(AuthFailure.Cancelled, awaitGate("the old caller's answer", oldCaller))
            assertEquals("owner-B", signIn.status().account?.subject)
            val token = if (asksAccess) signIn.accessToken() else signIn.idToken()
            assertTrue(token.isNotEmpty())
            fake.user = FakeIssuer.User("user-7f3a", "Ada Example", "ada@example.test", true)
        }
    }

    // Sign-out races

    @Test
    fun `signing out while the browser is open makes the late answer write nothing`() = runBlocking {
        val opened = CompletableDeferred<String>()
        val held = CompletableDeferred<Unit>()
        val signIn = make(openAuthSession = { url, redirect ->
            val back = browser(url, redirect)!!
            opened.complete(back)
            held.await()
            back
        })
        val running = async { signIn.signIn() }
        awaitGate("the browser to open", opened)
        signIn.signOut()
        held.complete(Unit)
        val status = awaitGate("the sign-in to end", running)
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertNull(status.lastFailure)
        assertEquals(0, fake.tokenCount.get())
        assertNothingKept()
        assertTrue(events.any { it.first == "hub.sign-in.dropped" })
    }

    @Test
    fun `signing out while the store writes are pending cannot restore the old login`() = runBlocking {
        val slow = RecordingSecureStore()
        val entered = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        slow.beforeSet = { key ->
            if (key == StoreKeys.ACCESS_TOKEN && !gate.isCompleted) {
                entered.complete(Unit)
                gate.await()
            }
        }
        val auth = make(secureStore = slow)
        val signingIn = async { auth.signIn() }
        awaitGate("the sign-in's access token write", entered)
        val signingOut = async { auth.signOut() }
        gate.complete(Unit)
        awaitGate("the sign-in to end", signingIn)
        awaitGate("the sign-out to end", signingOut)
        assertEquals(AuthPhase.SignedOut, auth.status().phase)
        assertNothingKept(slow)
        assertEquals(AuthPhase.SignedOut, make(secureStore = slow).restore().phase)
    }

    @Test
    fun `guardAccount throws once another account may have signed in`() = runBlocking {
        val signIn = make()
        signIn.signIn()
        val guard = signIn.guardAccount()
        guard()
        signIn.signOut()
        assertEquals(AuthFailure.Cancelled, failureOf { guard() })
    }

    // The restore at boot

    @Test
    fun `restores a stored session without the network and reuses its tokens`() = runBlocking {
        make().signIn()
        val tokensBefore = fake.tokenCount.get()
        val next = make()
        val status = next.restore()
        assertEquals(AuthPhase.SignedIn, status.phase)
        assertEquals("user-7f3a", status.account?.subject)
        assertTrue(next.accessToken().startsWith("at-"))
        assertEquals(tokensBefore, fake.tokenCount.get())
        assertEquals(1, fake.discoveryCount.get())
    }

    @Test
    fun `discards a session stored for another client`() = runBlocking {
        make().signIn()
        store.map[StoreKeys.CLIENT] = """{"issuer":"${fake.issuer}","clientId":"someone-else","registeredAt":1}"""
        val status = make().restore()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertNothingKept()
    }

    @Test
    fun `discards a session stored for another issuer`() = runBlocking {
        make().signIn()
        val session = Json.parseToJsonElement(store.map[StoreKeys.SESSION]!!).jsonObject
        store.map[StoreKeys.SESSION] = kotlinx.serialization.json.JsonObject(session + ("issuer" to JsonPrimitive("https://other.example"))).toString()
        val status = make().restore()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertNothingKept()
        assertTrue(events.any { it.first == "hub.session.discarded" })
    }

    @Test
    fun `a refused issuer override signs nobody in and says configuration`() = runBlocking {
        val signIn = make(issuer = "http://192.168.1.10:8080")
        assertEquals(AuthFailure.Configuration, signIn.status().lastFailure)
        assertEquals("", signIn.status().issuer)
        val status = signIn.signIn()
        assertEquals(AuthPhase.SignedOut, status.phase)
        assertEquals(AuthFailure.Configuration, status.lastFailure)
        assertEquals(0, fake.discoveryCount.get())
    }
}
