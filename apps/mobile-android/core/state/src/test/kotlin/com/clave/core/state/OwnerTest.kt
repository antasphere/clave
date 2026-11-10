package com.clave.core.state

import com.clave.core.auth.AuthError
import com.clave.core.auth.DEFAULT_ISSUER
import com.clave.core.auth.HubSignIn
import com.clave.core.auth.HubTokenStore
import com.clave.core.auth.SignInDeps
import com.clave.core.auth.StoredAccount
import com.clave.core.auth.StoredClient
import com.clave.core.auth.StoredSession
import com.clave.core.auth.StoredToken
import com.clave.core.chat.Drafts
import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.DevicePlatform
import com.clave.core.contract.IdLabel
import com.clave.core.contract.MachinePlatform
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.WriteAnswer
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.Machine
import com.clave.core.devices.PairingState
import com.clave.core.notifications.ActionIds
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.HandleResult
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.SettleClient
import com.clave.core.notifications.TokenRegistration
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.MemorySecureStore
import com.clave.core.transport.OkHttpPort
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The owner-scoped stores and services (account.ts, beta.ts): what one account writes is
 *  never what the next one reads. */
class OwnerTest {
    private val clock = TestClock()
    private val http = OkHttpClient()
    private val port = OkHttpPort(http)
    private val machine = FakeMachine()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val rawKv = SyncKv()
    private val rawSecure = SyncSecure()
    private val device = DeviceDescription("Test phone", DevicePlatform.Android, "0.1.0")

    @After
    fun stop() {
        scope.cancel()
        machine.close()
    }

    /** A hub login restored from the store, as after a boot: no network, the tokens valid
     *  for an hour on the test's clock. */
    private suspend fun signedIn(subject: String): HubSignIn {
        val secure = MemorySecureStore()
        val store = HubTokenStore(secure)
        store.writeClient(StoredClient(DEFAULT_ISSUER, "client-$subject", 0))
        store.writeSession(StoredSession(DEFAULT_ISSUER, "client-$subject", StoredAccount(subject, null, null, true), 0))
        store.writeAccessToken(StoredToken("access-$subject", clock.nowMs + 3_600_000))
        store.writeIdToken(StoredToken("id-$subject", clock.nowMs + 3_600_000))
        store.writeRefreshToken("refresh-$subject")
        val offline = HttpPort { throw HttpFailure.Network() }
        val auth = HubSignIn(SignInDeps(null, offline, secure, JvmCrypto, { _, _ -> null }, clock))
        auth.restore()
        assertEquals(subject, auth.status().account?.subject)
        return auth
    }

    private suspend fun storesOf(auth: HubSignIn) = ownerStores(auth.status(), rawKv, rawSecure, JvmCrypto)

    private fun services(auth: HubSignIn, stores: OwnerStores, granted: Boolean = true, defaultRelay: String = "https://relay.default.example") = OwnerServices(
        auth = auth,
        stores = stores,
        http = port,
        build = BuildKind.Development,
        device = device,
        defaultRelayUrl = defaultRelay,
        pushTokens = { DeviceToken("android", "fcm-token") },
        permission = { granted },
        clock = clock,
        sleep = { delay(10) },
    )

    private val fixture: Machine
        get() = Machine("m1", "Mac", MachinePlatform.Macos, "2.4.0", true, null, machine.base, "${machine.base}/push")

    /** The enrollment routes: a ticket, then pending until [approve] completes. */
    private fun enrollment(approve: CompletableDeferred<Unit>) {
        machine.handler = { call ->
            when {
                call.line == "POST /devices/pair" -> answer(200, """{"pairingId":"p1","expiresAt":${clock.nowMs + 600_000}}""")
                call.line == "GET /devices/pair" ->
                    if (approve.isCompleted) answer(200, """{"status":"approved","deviceSession":{"token":"device-session","deviceId":"d1","serverId":"srv","serverName":"Mac"}}""")
                    else answer(200, """{"status":"pending"}""")
                call.path.startsWith("/devices/me/push-token") -> answer(200, "{}")
                else -> answer(404, "{}")
            }
        }
    }

    private fun credentialKeys(): List<String> = rawSecure.map.keys.filter { it.contains("clave.credential.") }

    /** Two machines this owner paired, on distinct servers with distinct names; the first one
     *  paired is the main machine. */
    private suspend fun twoPaired(services: OwnerServices) {
        services.records.set(EnrollmentRecord("studio", "device-1", "srv-1", "Studio", 1))
        services.credentials.set("studio", Credential("https://relay.example/m/studio", "studio-session"))
        services.records.set(EnrollmentRecord("laptop", "device-2", "srv-2", "Laptop", 2))
        services.credentials.set("laptop", Credential("https://relay.example/m/laptop", "laptop-session"))
    }

    /** Allow, tapped on a permission notification of [serverId] as FCM hands it over. */
    private fun allowTapped(serverId: String, serverName: String) = IncomingResponse(
        notificationId = "n-1",
        date = 1,
        actionIdentifier = ActionIds.allow,
        data = buildJsonObject {
            put("category", "permission")
            put("serverId", serverId)
            put("serverName", serverName)
            put("sessionId", "s-1")
            put("sessionTitle", "Chat")
            put("requestId", "r-1")
            put("text", "Run?")
            put("actions", JsonArray(listOf(JsonPrimitive("allow"), JsonPrimitive("deny"))))
        },
    )

    /** A machine's request routes: the one permission request pending, every resolution kept. */
    private fun settleClient(resolved: MutableList<Pair<String, RequestResponse>>) = object : SettleClient {
        override suspend fun listRequests() = RequestSnapshot(
            1,
            listOf(
                PendingRequest(
                    id = "r-1",
                    sessionId = "s-1",
                    kind = RequestKind.Permission,
                    description = "Run?",
                    createdAt = 1,
                    options = listOf(IdLabel("allow-once", "Allow"), IdLabel("deny", "Deny")),
                ),
            ),
        )

        override suspend fun resolve(requestId: String, response: RequestResponse): ResolveOutcome {
            resolved += requestId to response
            return ResolveOutcome(true)
        }

        override suspend fun writePermissionResponse(sessionId: String, requestId: String, optionId: String): WriteAnswer =
            error("the request route answers first")
    }

    @Test
    fun `owner isolation two subjects never share a draft, a credential, a relay url or a pairing record`() = runBlocking {
        val authA = signedIn("sub-a")
        val authB = signedIn("sub-b")
        val a = storesOf(authA)
        val b = storesOf(authB)
        assertNotEquals(a.namespace, b.namespace)
        assertNotSame(a.pushWork, b.pushWork)
        // The push work is per namespace and process-wide: the same owner gets the same lock.
        assertSame(a.pushWork, storesOf(authA).pushWork)

        Drafts(a.kv).set("m1", "s1", "A's words")
        assertEquals("", Drafts(b.kv).get("m1", "s1"))

        val servicesA = services(authA, a)
        val servicesB = services(authB, b)
        servicesA.setRelayUrl("https://relay-a.example/")
        assertEquals("https://relay-a.example", servicesA.relayUrl())
        assertEquals("https://relay.default.example", servicesB.relayUrl())

        val approve = CompletableDeferred(Unit)
        enrollment(approve)
        val paired = servicesA.pair(fixture, {}, { false })
        assertTrue(paired is PairingState.Approved)
        assertEquals(Credential(machine.base, "device-session"), a.credentials.get("m1"))
        assertEquals("m1", a.credentials.mainMachineId())
        assertNull(b.credentials.get("m1"))
        assertNull(b.credentials.mainMachineId())
        // The credential and the main machine sit in the platform's protected store under A's
        // namespace; the plain store holds neither a credential key nor the bearer.
        assertEquals(listOf("${a.namespace}.clave.credential.m1"), credentialKeys())
        assertTrue(rawSecure.map.getValue("${a.namespace}.clave.credential.m1").contains("device-session"))
        assertEquals("m1", rawSecure.map["${a.namespace}.clave.main-machine"])
        assertTrue(rawKv.map.keys.toString(), rawKv.map.keys.none { it.contains("credential") || it.contains("main-machine") })
        assertTrue(rawKv.map.values.none { it.contains("device-session") })
        assertEquals(listOf("m1"), EnrollmentRecords(a.kv).list().map { it.machineId })
        assertEquals(emptyList<EnrollmentRecord>(), EnrollmentRecords(b.kv).list())
        // B's services see none of A's machines and none of A's pairings.
        assertEquals(emptyList<TokenRegistration>(), servicesB.syncPushTokens())
        assertEquals(TokenRegistration.Failed("Pair this phone first."), servicesB.registerPush("m1"))
        // Every key either owner wrote sits under its own namespace.
        for (key in rawKv.map.keys + rawSecure.map.keys) {
            assertTrue(key, key.startsWith(a.namespace) || key.startsWith(b.namespace))
        }
    }

    @Test
    fun `owner isolation after sign-out a write the old owner started lands nowhere the new owner reads`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        val servicesA = services(authA, a)
        val approve = CompletableDeferred<Unit>()
        enrollment(approve)

        // The approval's credential write is held mid-flight while the owner signs out.
        val writing = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        rawSecure.beforeSet = { key ->
            if (key.startsWith(a.namespace) && key.contains("clave.credential.") && !writing.isCompleted) {
                writing.complete(Unit)
                release.await()
            }
        }
        val states = CopyOnWriteArrayList<PairingState>()
        val pairing = scope.async { servicesA.pair(fixture, { states += it }, { false }) }
        until(what = "the pairing to wait for the approval") { states.any { it is PairingState.Waiting } }
        approve.complete(Unit)
        awaitGate("the approval's credential write to reach the secure store", writing)
        // Undispatched: the sign-out has begun (closing set, waiting on the owner's queue) when this returns.
        val signOut = scope.async(start = CoroutineStart.UNDISPATCHED) { servicesA.signOut() }
        // The hub login stays until the queue drains.
        assertEquals("sub-a", authA.status().account?.subject)
        release.complete(Unit)
        assertEquals(PairingState.Cancelled, awaitGate("the pairing to end", pairing))
        awaitGate("the sign-out to end", signOut)
        assertNull(authA.status().account)

        // The next owner signs in: nothing of the old owner's approval is anywhere it reads.
        val authB = signedIn("sub-b")
        val b = storesOf(authB)
        assertNull(b.credentials.get("m1"))
        assertEquals(emptyList<EnrollmentRecord>(), EnrollmentRecords(b.kv).list())
        // Nor under the old owner: the write was rolled back, not left behind.
        assertNull(a.credentials.get("m1"))
        assertEquals(emptyList<EnrollmentRecord>(), EnrollmentRecords(a.kv).list())
        assertEquals(emptyList<String>(), credentialKeys())

        // The old owner's services start nothing after the sign-out.
        try {
            servicesA.setRelayUrl("https://relay-late.example")
            fail("a write after the sign-out must be refused")
        } catch (e: AuthError) {
            assertEquals("The account is signing out.", e.message)
        }
        assertNull(a.kv.get(RELAY_URL_KEY))
        assertNull(b.kv.get(RELAY_URL_KEY))
        assertEquals(TokenRegistration.Failed("The account is signing out."), servicesA.registerPush("m1"))
        assertEquals(emptyList<TokenRegistration>(), servicesA.syncPushTokens())
    }

    @Test
    fun `owner isolation the guard stops old work once the hub login changed under it`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        val servicesA = services(authA, a)
        // Signed out elsewhere (another screen, an expiry): the epoch moved.
        authA.signOut()
        try {
            servicesA.setRelayUrl("https://relay-late.example")
            fail("old work must stop once the account changed")
        } catch (e: AuthError) {
            assertEquals("The account changed.", e.message)
        }
        assertNull(a.kv.get(RELAY_URL_KEY))
        assertEquals(emptyList<Machine>(), servicesA.source.list())
    }

    @Test
    fun `owner isolation an approval never lands once the hub login changed under it, these services never signed out`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        val servicesA = services(authA, a)
        val approve = CompletableDeferred<Unit>()
        enrollment(approve)
        val writing = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        rawSecure.beforeSet = { key ->
            if (key.startsWith(a.namespace) && key.contains("clave.credential.") && !writing.isCompleted) {
                writing.complete(Unit)
                release.await()
            }
        }
        val states = CopyOnWriteArrayList<PairingState>()
        val pairing = scope.async { servicesA.pair(fixture, { states += it }, { false }) }
        until(what = "the pairing to wait for the approval") { states.any { it is PairingState.Waiting } }
        approve.complete(Unit)
        awaitGate("the approval's credential write to reach the secure store", writing)
        // The hub login changes elsewhere (an expiry, another screen) while the write is held;
        // the owner's own services are never signed out, so only the owner check can stop it.
        authA.signOut()
        release.complete(Unit)
        assertEquals(PairingState.Cancelled, awaitGate("the pairing to end", pairing))
        assertNull(a.credentials.get("m1"))
        assertEquals(emptyList<EnrollmentRecord>(), EnrollmentRecords(a.kv).list())
        assertEquals(emptyList<String>(), credentialKeys())
    }

    @Test
    fun `owner isolation a sign-out never signs out the login that replaced its owner while its cleanup ran`() = runBlocking {
        LoopbackIssuer(clock).use { issuer ->
            val auth = issuer.signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a)
            enrollment(CompletableDeferred(Unit))
            assertTrue(servicesA.pair(fixture, {}, { false }) is PairingState.Approved)
            assertEquals(TokenRegistration.Registered("fcm-token"), servicesA.registerPush("m1"))
            // A's sign-out holds its push cleanup at the machine; meanwhile B signs in on the
            // same hub login.
            machine.handler = { call ->
                if (call.line == "POST /devices/me/push-token/clear") machine.hold(call) else answer(404, "{}")
            }
            val signOut = scope.async { servicesA.signOut() }
            until(what = "the sign-out's push cleanup to reach the machine") { machine.held.size == 1 }
            issuer.subject = "sub-b"
            assertEquals("sub-b", auth.signIn().account?.subject)
            machine.respond(0, answer(200, "{}"))
            awaitGate("the sign-out to end", signOut)
            // A's cleanup reached A's machine; B is still signed in.
            assertEquals(1, machine.count("POST /devices/me/push-token/clear"))
            assertEquals("sub-b", auth.status().account?.subject)
            assertEquals("access-sub-b", auth.accessToken())
        }
    }

    @Test
    fun `owner isolation a relay list that lands after the hub login changed writes no cache and is refused`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        val servicesA = services(authA, a, defaultRelay = "")
        a.kv.set(RELAY_URL_KEY, machine.base)
        machine.handler = { call -> if (call.rawPath == "/machines") machine.hold(call) else answer(404, "{}") }
        val listing = scope.async { runCatching { servicesA.source.list() } }
        until(what = "the relay's list to be asked") { machine.held.size == 1 }
        // Signed out elsewhere while the relay's answer is on its way.
        authA.signOut()
        machine.respond(
            0,
            answer(200, """{"machines":[{"id":"r1","name":"Relay Mac","platform":"macos","version":"2.4.0","online":true,"lastSeen":5,"direct":[]}]}"""),
        )
        val outcome = awaitGate("the list to end", listing)
        assertEquals("The account changed.", (outcome.exceptionOrNull() as? AuthError)?.message)
        assertNull(a.kv.get(MACHINES_CACHE_KEY))
        assertTrue(rawKv.map.keys.toString(), rawKv.map.keys.none { it.endsWith(MACHINES_CACHE_KEY) })
    }

    @Test
    fun `a notification response is answered with the credential of the machine its own server resolves to, never the main one`() = runBlocking {
        val auth = signedIn("sub-a")
        val servicesA = services(auth, storesOf(auth))
        twoPaired(servicesA)
        assertEquals("studio", servicesA.credentials.mainMachineId())
        val bearers = mutableListOf<String>()
        val resolved = mutableListOf<Pair<String, RequestResponse>>()
        // The payload's server name happens to be the other server's id; only the id decides.
        val result = servicesA.respond(allowTapped(serverId = "srv-2", serverName = "srv-1")) { credential ->
            bearers += credential.bearer
            settleClient(resolved)
        }
        assertEquals(HandleResult.Settled, result)
        assertEquals(listOf("laptop-session"), bearers)
        assertEquals(listOf("r-1" to RequestResponse.Permission("allow-once")), resolved)

        // A server this owner never paired with gets no client at all; the tap opens Machines.
        val unpaired = servicesA.respond(allowTapped(serverId = "srv-9", serverName = "Other Mac")) { error("no client for an unpaired server") }
        assertTrue(unpaired.toString(), unpaired is HandleResult.Open && unpaired.link is DeepLink.Machines)
    }

    @Test
    fun `a push is posted with the machine its own server resolves to, and with none for a server this owner never paired`() = runBlocking {
        val auth = signedIn("sub-a")
        val servicesA = services(auth, storesOf(auth))
        twoPaired(servicesA)
        assertEquals("laptop", servicesA.machineForServer("srv-2"))
        assertEquals("studio", servicesA.machineForServer("srv-1"))
        assertNull(servicesA.machineForServer("srv-9"))
        assertNull(servicesA.machineForServer("Studio"))
        // Another owner on the same phone resolves none of them.
        val authB = signedIn("sub-b")
        assertNull(services(authB, storesOf(authB)).machineForServer("srv-2"))
    }

    @Test
    fun `the machines come from the relay, and from the cache only when the relay is out of reach`() = runBlocking {
        val auth = signedIn("sub-a")
        val servicesA = services(auth, storesOf(auth), defaultRelay = "")
        var status = 200
        machine.handler = { call ->
            if (call.rawPath == "/machines") {
                if (status == 200) answer(200, """{"machines":[{"id":"r1","name":"Relay Mac","platform":"macos","version":"2.4.0","online":true,"lastSeen":5,"direct":[]}]}""")
                else answer(status, "{}")
            } else answer(404, "{}")
        }
        try {
            servicesA.source.list()
            fail("no relay address yet")
        } catch (e: IllegalStateException) {
            assertEquals("Enter the team relay address to see your machines.", e.message)
        }
        servicesA.kv.set(RELAY_URL_KEY, machine.base)
        val listed = servicesA.source.list()
        assertEquals(listOf("r1"), listed.map { it.id })
        assertTrue(listed.single().online)
        assertEquals("${machine.base}/m/r1", listed.single().baseUrl)

        status = 503
        val cached = servicesA.source.list()
        assertEquals(listOf("r1"), cached.map { it.id })
        assertFalse(cached.single().online)
        assertEquals(listed.single().copy(online = false), cached.single())

        status = 401
        try {
            servicesA.source.list()
            fail("a refusal is never papered over by the cache")
        } catch (e: Exception) {
            assertEquals("The relay refused the sign-in.", e.message)
        }
    }

    @Test
    fun `a new relay moves the road generation, clears the push registrations and forgets every pairing`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a)
        enrollment(CompletableDeferred(Unit))
        servicesA.setRelayUrl(machine.base)
        assertTrue(servicesA.pair(fixture, {}, { false }) is PairingState.Approved)
        assertEquals(TokenRegistration.Registered("fcm-token"), servicesA.registerPush("m1"))
        assertEquals(TokenRegistration.Unchanged, servicesA.registerPush("m1"))
        val push = machine.calls.single { it.path == "/devices/me/push-token" }
        assertEquals(json("""{"token":"fcm-token","platform":"android"}"""), json(push.body))
        a.kv.set(MACHINES_CACHE_KEY, "[]")

        val generation = a.pushWork.roadGeneration
        // The same relay again changes nothing.
        servicesA.setRelayUrl("${machine.base}/")
        assertEquals(generation, a.pushWork.roadGeneration)
        assertEquals(Credential(machine.base, "device-session"), a.credentials.get("m1"))

        try {
            servicesA.setRelayUrl("https://relay.example/team?x=1")
            fail("a path or a query is refused")
        } catch (e: IllegalArgumentException) {
            assertEquals("Enter the team relay origin without a path or query.", e.message)
        }
        val cleanup = servicesA.setRelayUrl("https://relay-b.example")
        assertEquals(generation + 1, a.pushWork.roadGeneration)
        assertEquals(0, cleanup.pending)
        assertEquals(1, machine.count("POST /devices/me/push-token/clear"))
        assertNull(a.credentials.get("m1"))
        assertEquals(emptyList<EnrollmentRecord>(), servicesA.records.list())
        assertNull(a.kv.get(MACHINES_CACHE_KEY))
        assertEquals("https://relay-b.example", servicesA.relayUrl())
    }

    @Test
    fun `notifications off is said as such, never as a failure of the machine`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        enrollment(CompletableDeferred(Unit))
        val servicesA = services(auth, a, granted = false)
        assertTrue(servicesA.pair(fixture, {}, { false }) is PairingState.Approved)
        assertEquals(TokenRegistration.Unsupported("Notifications are off for Clave."), servicesA.registerPush("m1"))
        assertEquals(0, machine.count("POST /devices/me/push-token"))
    }
}
