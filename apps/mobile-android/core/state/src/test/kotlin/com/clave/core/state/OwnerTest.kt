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
import com.clave.core.devices.AddressListing
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.Machine
import com.clave.core.devices.MachineAddress
import com.clave.core.devices.MachineListing
import com.clave.core.devices.PairingState
import com.clave.core.devices.TransportPolicyError
import com.clave.core.notifications.ActionIds
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.HandleResult
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.PushCleanupResult
import com.clave.core.notifications.SettleClient
import com.clave.core.notifications.TokenRegistration
import com.clave.core.notifications.pushTokenKey
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.MemorySecureStore
import com.clave.core.transport.OkHttpPort
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
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

    private fun services(
        auth: HubSignIn,
        stores: OwnerStores,
        granted: Boolean = true,
        defaultRelay: String = "https://relay.default.example",
        build: BuildKind = BuildKind.Development,
    ) = OwnerServices(
        auth = auth,
        stores = stores,
        http = port,
        build = build,
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
    fun `owner isolation two subjects never share a draft, a credential, an address or a pairing record`() = runBlocking {
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
        servicesA.addAddress("https://relay-a.example/")
        assertEquals(
            listOf(MachineAddress("https://relay.default.example"), MachineAddress("https://relay-a.example")),
            servicesA.addresses(),
        )
        assertEquals(listOf(MachineAddress("https://relay.default.example")), servicesB.addresses())

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
            servicesA.addAddress("https://relay-late.example")
            fail("a write after the sign-out must be refused")
        } catch (e: AuthError) {
            assertEquals("The account is signing out.", e.message)
        }
        assertNull(a.kv.get(MACHINE_ADDRESSES_KEY))
        assertNull(b.kv.get(MACHINE_ADDRESSES_KEY))
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
        val writes = listOf<suspend () -> Unit>(
            { servicesA.addAddress("https://relay-late.example") },
            { servicesA.removeAddress("https://relay.default.example") },
            { servicesA.forgetMachine("m1") },
        )
        for (write in writes) {
            try {
                write()
                fail("old work must stop once the account changed")
            } catch (e: AuthError) {
                assertEquals("The account changed.", e.message)
            }
        }
        assertNull(a.kv.get(MACHINE_ADDRESSES_KEY))
        assertEquals(MachineListing(emptyList(), emptyList()), servicesA.source.listing())
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
        assertNull(a.kv.get(machinesCacheKey(machine.base)))
        assertTrue(rawKv.map.keys.toString(), rawKv.map.keys.none { it.contains(MACHINES_CACHE_KEY) })
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
    fun `a response for a paired machine that lost its credential builds no client, never with another machine's`() = runBlocking {
        val auth = signedIn("sub-a")
        val servicesA = services(auth, storesOf(auth))
        twoPaired(servicesA)
        servicesA.credentials.remove("laptop")
        val result = servicesA.respond(allowTapped(serverId = "srv-2", serverName = "Laptop")) { error("no client without the resolved machine's own credential") }
        assertEquals(HandleResult.Open(DeepLink.Machines("Pair this phone again.")), result)
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

    /** One machine row of the relay's `GET /machines`, online. */
    private fun row(id: String): String =
        "{\"id\":\"$id\",\"name\":\"Mac $id\",\"platform\":\"macos\",\"version\":\"2.4.0\",\"online\":true,\"lastSeen\":5,\"direct\":[]}"

    private fun machinesJson(vararg ids: String): String = "{\"machines\":[" + ids.joinToString(",") { row(it) } + "]}"

    /** [server] lists [ids] on `/machines` while [status] says 200, and answers [status] otherwise. */
    private fun lists(server: FakeMachine, vararg ids: String, status: () -> Int = { 200 }) {
        server.handler = { call ->
            if (call.rawPath == "/machines") {
                val s = status()
                if (s == 200) answer(200, machinesJson(*ids)) else answer(s, "{}")
            } else answer(404, "{}")
        }
    }

    /** The fixture machine listed by its own address, paired and registered for push, as
     *  after a pairing from its row. */
    private suspend fun pairedThroughAddress(services: OwnerServices) {
        enrollment(CompletableDeferred(Unit))
        val enroll = machine.handler
        machine.handler = { call -> if (call.rawPath == "/machines") answer(200, machinesJson("m1")) else enroll(call) }
        services.addAddress(machine.base)
        assertTrue(services.pair(fixture, {}, { false }) is PairingState.Approved)
        assertEquals(TokenRegistration.Registered("fcm-token"), services.registerPush("m1"))
    }

    @Test
    fun `the single relay of earlier versions becomes the one address, its cache follows, and no pairing is touched`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a)
        twoPaired(servicesA)
        a.kv.set(pushTokenKey("studio"), "fcm-token")
        a.kv.set(RELAY_URL_KEY, "https://relay.example")
        a.kv.set(MACHINES_CACHE_KEY, "[\"the relay's last list\"]")
        val secure = rawSecure.map.toMap()
        val records = servicesA.records.list()
        val generation = a.pushWork.roadGeneration

        // The relay typed wins over the one the build ships with.
        assertEquals(listOf(MachineAddress("https://relay.example")), servicesA.addresses())
        assertEquals("""[{"url":"https://relay.example"}]""", a.kv.get(MACHINE_ADDRESSES_KEY))
        assertEquals("[\"the relay's last list\"]", a.kv.get(machinesCacheKey("https://relay.example")))
        assertNull(a.kv.get(RELAY_URL_KEY))
        assertNull(a.kv.get(MACHINES_CACHE_KEY))
        assertEquals(secure, rawSecure.map.toMap())
        assertEquals(records, servicesA.records.list())
        assertEquals("fcm-token", a.kv.get(pushTokenKey("studio")))
        assertEquals(generation, a.pushWork.roadGeneration)
        assertEquals(0, machine.calls.size)

        // The move happens once: a relay written afterwards is not read.
        a.kv.set(RELAY_URL_KEY, "https://relay-later.example")
        assertEquals(listOf(MachineAddress("https://relay.example")), servicesA.addresses())
    }

    @Test
    fun `an empty list is kept as it is, and the build's relay is the first address only when nothing was ever kept`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        a.kv.set(MACHINE_ADDRESSES_KEY, "[]")
        a.kv.set(RELAY_URL_KEY, "https://relay.example")
        assertEquals(emptyList<MachineAddress>(), services(authA, a).addresses())
        assertEquals("[]", a.kv.get(MACHINE_ADDRESSES_KEY))
        assertEquals("https://relay.example", a.kv.get(RELAY_URL_KEY))

        val authB = signedIn("sub-b")
        val b = storesOf(authB)
        assertEquals(listOf(MachineAddress("https://relay.default.example")), services(authB, b, defaultRelay = "https://relay.default.example/").addresses())
        assertEquals("""[{"url":"https://relay.default.example"}]""", b.kv.get(MACHINE_ADDRESSES_KEY))

        val authC = signedIn("sub-c")
        val c = storesOf(authC)
        assertEquals(emptyList<MachineAddress>(), services(authC, c, defaultRelay = "").addresses())
        assertEquals("[]", c.kv.get(MACHINE_ADDRESSES_KEY))
    }

    @Test
    fun `two first reads at once move the single relay once`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a)
        a.kv.set(RELAY_URL_KEY, "https://relay.example")
        val reads = AtomicInteger()
        val writes = AtomicInteger()
        rawKv.beforeGet = { key -> if (key.endsWith(":$MACHINE_ADDRESSES_KEY")) reads.incrementAndGet() }
        rawKv.beforeWrite = { key, _ ->
            if (key.endsWith(":$MACHINE_ADDRESSES_KEY")) {
                writes.incrementAndGet()
                // The first move is held until the second read has found no list either.
                until(what = "the second read to find no list") { reads.get() >= 3 }
            }
        }
        val first = scope.async { servicesA.addresses() }
        val second = scope.async { servicesA.addresses() }
        val expected = listOf(MachineAddress("https://relay.example"))
        assertEquals(expected, awaitGate("the first read", first))
        assertEquals(expected, awaitGate("the second read", second))
        assertEquals(1, writes.get())
    }

    @Test
    fun `an address is added once, at the end, named or not, and renamed, and a release build refuses plain http`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "https://relay.example")
        assertEquals(MachineAddress("https://home.example", "Home"), servicesA.addAddress(" https://home.example/ ", " Home "))
        assertEquals(MachineAddress("https://lab.example"), servicesA.addAddress("https://lab.example", "  "))
        assertEquals(
            listOf(MachineAddress("https://relay.example"), MachineAddress("https://home.example", "Home"), MachineAddress("https://lab.example")),
            servicesA.addresses(),
        )
        for (again in listOf("https://home.example/", "HTTPS://Home.example", "https://relay.example")) {
            try {
                servicesA.addAddress(again, "Again")
                fail("$again is already in the list")
            } catch (e: IllegalArgumentException) {
                assertEquals("That address is already in the list.", e.message)
            }
        }
        try {
            servicesA.addAddress("https://relay.example/team?x=1")
            fail("a path or a query is refused")
        } catch (e: IllegalArgumentException) {
            assertEquals("Enter the address as an origin, without a path or query.", e.message)
        }
        try {
            services(auth, a, build = BuildKind.Release).addAddress("http://127.0.0.1:4711")
            fail("a release build never sends a credential over plain http")
        } catch (e: TransportPolicyError) {
            assertEquals("A credential never travels over plain http (127.0.0.1:4711); only https is used.", e.message)
        }
        assertEquals(3, servicesA.addresses().size)

        servicesA.renameAddress("https://lab.example", " Lab ")
        servicesA.renameAddress("https://home.example", " ")
        servicesA.renameAddress("https://unknown.example", "Nowhere")
        assertEquals(
            listOf(MachineAddress("https://relay.example"), MachineAddress("https://home.example"), MachineAddress("https://lab.example", "Lab")),
            servicesA.addresses(),
        )
        assertEquals(0, machine.calls.size)
    }

    @Test
    fun `removing an address drops its cache and moves the road, but keeps the credential, record and push token of a machine it listed`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        pairedThroughAddress(servicesA)
        assertEquals(listOf("m1"), servicesA.source.listing().machines.map { it.id })
        assertTrue(a.kv.get(machinesCacheKey(machine.base)) != null)
        val token = a.kv.get(pushTokenKey("m1"))
        assertTrue(token != null)
        val generation = a.pushWork.roadGeneration

        servicesA.removeAddress(machine.base)
        assertEquals(generation + 1, a.pushWork.roadGeneration)
        assertEquals(emptyList<MachineAddress>(), servicesA.addresses())
        assertNull(a.kv.get(machinesCacheKey(machine.base)))
        assertEquals(Credential(machine.base, "device-session"), a.credentials.get("m1"))
        assertEquals(listOf("m1"), servicesA.records.list().map { it.machineId })
        assertEquals(token, a.kv.get(pushTokenKey("m1")))
        assertEquals(0, machine.count("POST /devices/me/push-token/clear"))

        // An address not in the list changes nothing.
        servicesA.removeAddress("https://unknown.example")
        assertEquals(generation + 1, a.pushWork.roadGeneration)
    }

    @Test
    fun `a paired machine whose address was removed stays listed from its record, offline, at its own road`() = runBlocking {
        val auth = signedIn("sub-a")
        val servicesA = services(auth, storesOf(auth), defaultRelay = "")
        pairedThroughAddress(servicesA)
        servicesA.removeAddress(machine.base)
        val listing = servicesA.source.listing()
        assertEquals(emptyList<AddressListing>(), listing.addresses)
        assertEquals(
            listOf(Machine("m1", "Mac", MachinePlatform.Unknown, "", false, null, machine.base, "${machine.base}/push", address = null)),
            listing.machines,
        )
        // A record without a credential is no machine to reach.
        servicesA.records.set(EnrollmentRecord("lost", "device-9", "srv-9", "Lost", 9))
        assertEquals(listOf("m1"), servicesA.source.list().map { it.id })
    }

    @Test
    fun `a pairing still waiting when an address is removed never lands`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        servicesA.addAddress(machine.base)
        val approve = CompletableDeferred<Unit>()
        enrollment(approve)
        val states = CopyOnWriteArrayList<PairingState>()
        val pairing = scope.async { servicesA.pair(fixture, { states += it }, { false }) }
        until(what = "the pairing to wait for the approval") { states.any { it is PairingState.Waiting } }
        servicesA.removeAddress(machine.base)
        approve.complete(Unit)
        assertEquals(PairingState.Cancelled, awaitGate("the pairing to end", pairing))
        assertNull(a.credentials.get("m1"))
        assertEquals(emptyList<EnrollmentRecord>(), servicesA.records.list())
    }

    @Test
    fun `two addresses are read side by side and merged by machine id, a paired machine reached at its own road`() = runBlocking {
        val other = FakeMachine()
        try {
            val auth = signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a, defaultRelay = "")
            lists(machine, "a1", "shared", "paired")
            lists(other, "shared", "b1", "paired")
            servicesA.addAddress(machine.base, "A")
            servicesA.addAddress(other.base, "B")
            // Paired through the second address's road, though the first one lists it first.
            servicesA.records.set(EnrollmentRecord("paired", "device-1", "srv-1", "Paired", 1))
            servicesA.credentials.set("paired", Credential("${other.base}/m/paired", "paired-session"))

            val listing = servicesA.source.listing()
            assertEquals(listOf("a1", "shared", "paired", "b1"), listing.machines.map { it.id })
            assertEquals(listOf(machine.base, machine.base, machine.base, other.base), listing.machines.map { it.address })
            assertTrue(listing.machines.all { it.online })
            assertEquals("${machine.base}/m/shared", listing.machines[1].baseUrl)
            val paired = listing.machines[2]
            assertEquals("Mac paired", paired.name)
            assertEquals("${other.base}/m/paired", paired.baseUrl)
            assertEquals("${other.base}/m/paired/push", paired.pushUrl)
            assertEquals("${other.base}/m/b1/push", listing.machines[3].pushUrl)
            assertEquals(
                listOf(
                    AddressListing(MachineAddress(machine.base, "A"), listOf("a1", "shared", "paired"), null, fromCache = false),
                    AddressListing(MachineAddress(other.base, "B"), listOf("shared", "b1", "paired"), null, fromCache = false),
                ),
                listing.addresses,
            )
            assertTrue(a.kv.get(machinesCacheKey(machine.base)) != null)
            assertTrue(a.kv.get(machinesCacheKey(other.base)) != null)
            assertEquals(listing.machines, servicesA.source.list())
        } finally {
            other.close()
        }
    }

    /** [server] lists [ids] on `/machines` only once [release] opens (at most ten seconds). */
    private fun listsWhenReleased(server: FakeMachine, release: java.util.concurrent.CountDownLatch, vararg ids: String) {
        server.handler = { call ->
            if (call.rawPath == "/machines") {
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
                answer(200, machinesJson(*ids))
            } else answer(404, "{}")
        }
    }

    private suspend fun waitFor(what: String, check: () -> Boolean) {
        try {
            kotlinx.coroutines.withTimeout(5_000) { while (!check()) delay(20) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("waited 5 s for $what", e)
        }
    }

    @Test
    fun `a slow address holds back no other, the one that answered is heard while the slow one is still asked`() = runBlocking {
        val other = FakeMachine()
        val release = java.util.concurrent.CountDownLatch(1)
        try {
            val auth = signedIn("sub-a")
            val servicesA = services(auth, storesOf(auth), defaultRelay = "")
            listsWhenReleased(machine, release, "a1")
            lists(other, "b1")
            servicesA.addAddress(machine.base, "Slow")
            servicesA.addAddress(other.base, "Quick")
            val heard = java.util.concurrent.CopyOnWriteArrayList<MachineListing>()
            val reading = async(Dispatchers.Default) { servicesA.source.listing { heard += it } }

            // Both addresses are asked at once: the quick one while the slow one still holds its answer.
            waitFor("the slow address to be asked") { machine.calls.any { it.rawPath == "/machines" } }
            waitFor("the quick address to be asked while the slow one holds") { other.calls.any { it.rawPath == "/machines" } }
            waitFor("a listing with the quick address's machine") { heard.any { l -> l.machines.any { it.id == "b1" } } }
            val partial = heard.first { l -> l.machines.any { it.id == "b1" } }
            assertEquals(listOf("b1"), partial.machines.map { it.id })
            assertEquals(listOf(true, false), partial.addresses.map { it.pending })
            assertFalse("the slow address has not answered yet", reading.isCompleted)

            release.countDown()
            val listing = reading.await()
            assertEquals(listOf("a1", "b1"), listing.machines.map { it.id })
            assertEquals(listOf(false, false), listing.addresses.map { it.pending })
        } finally {
            release.countDown()
            other.close()
        }
    }

    @Test
    fun `an address removed while its read is under way gives no row and writes no cache back`() = runBlocking {
        val other = FakeMachine()
        val release = java.util.concurrent.CountDownLatch(1)
        try {
            val auth = signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a, defaultRelay = "")
            listsWhenReleased(machine, release, "gone")
            lists(other, "kept")
            servicesA.addAddress(machine.base, "Removed")
            servicesA.addAddress(other.base, "Kept")
            val reading = async(Dispatchers.Default) { servicesA.source.listing() }
            waitFor("the address to be asked") { machine.calls.any { it.rawPath == "/machines" } }

            servicesA.removeAddress(machine.base)
            assertEquals(listOf("kept"), servicesA.source.listing().machines.map { it.id })
            release.countDown()
            val older = reading.await()

            assertEquals(listOf("kept"), older.machines.map { it.id })
            assertEquals(listOf(other.base), older.addresses.map { it.address.url })
            assertNull("no cache comes back for the removed address", a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(listOf("kept"), servicesA.source.listing().machines.map { it.id })
        } finally {
            release.countDown()
            other.close()
        }
    }

    @Test
    fun `an address removed right after a listing read the list gives that listing no row and no cache`() = runBlocking {
        val other = FakeMachine()
        try {
            val auth = signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a, defaultRelay = "")
            lists(machine, "gone")
            lists(other, "kept")
            servicesA.addAddress(machine.base, "Removed")
            servicesA.addAddress(other.base, "Kept")
            // The listing has read the list with both addresses and starts a removal at once; the
            // removal waits for the listing's snapshot and lands before the answers do.
            val removing = java.util.concurrent.atomic.AtomicBoolean(true)
            var removal: kotlinx.coroutines.Deferred<Unit>? = null
            rawKv.afterRead = { key, _ ->
                if (key.endsWith(MACHINE_ADDRESSES_KEY) && removing.getAndSet(false)) {
                    removal = scope.async { servicesA.removeAddress(machine.base) }
                }
            }
            machine.handler = { call ->
                if (call.rawPath == "/machines") {
                    runBlocking { removal?.await() }
                    answer(200, machinesJson("gone"))
                } else answer(404, "{}")
            }
            val listing = servicesA.source.listing()
            rawKv.afterRead = null
            assertEquals(listOf("kept"), listing.machines.map { it.id })
            assertEquals(listOf(other.base), listing.addresses.map { it.address.url })
            assertNull(a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(listOf(MachineAddress(other.base, "Kept")), servicesA.addresses())
        } finally {
            rawKv.afterRead = null
            other.close()
        }
    }

    @Test
    fun `a listing that starts while a removal is being written sees the list before or after it, never a mix`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        lists(machine, "removed")
        servicesA.addAddress(machine.base, "Removed")
        // The removal has noted its epoch and holds before the shorter list is written.
        val writing = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        rawKv.beforeWrite = { key, value ->
            if (key.endsWith(MACHINE_ADDRESSES_KEY) && value == "[]") {
                writing.complete(Unit)
                finish.await()
            }
        }
        try {
            val removing = scope.async { servicesA.removeAddress(machine.base) }
            awaitGate("the removal to hold its write", writing)
            val reading = scope.async { servicesA.source.listing() }
            delay(200)
            finish.complete(Unit)
            awaitGate("the removal to end", removing)
            val listing = awaitGate("the listing to end", reading)
            assertEquals(emptyList<String>(), listing.machines.map { it.id })
            assertNull("no cache comes back for the removed address", a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(emptyList<MachineAddress>(), servicesA.addresses())
        } finally {
            finish.complete(Unit)
            rawKv.beforeWrite = null
        }
    }

    @Test
    fun `a listing that starts while a removal drops its cache sees the list from before or after it, never a mix`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        lists(machine, "removed")
        servicesA.addAddress(machine.base, "Removed")
        val writing = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        rawKv.beforeRemove = { key ->
            if (key.endsWith(machinesCacheKey(machine.base))) {
                writing.complete(Unit)
                finish.await()
            }
        }
        try {
            val removing = scope.async { servicesA.removeAddress(machine.base) }
            awaitGate("the removal to hold its cache removal", writing)
            val reading = scope.async { servicesA.source.listing() }
            delay(200)
            rawKv.beforeRemove = null
            finish.complete(Unit)
            awaitGate("the removal to end", removing)
            val listing = awaitGate("the listing to end", reading)
            assertEquals(emptyList<String>(), listing.machines.map { it.id })
            assertNull("no cache comes back for the removed address", a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(emptyList<MachineAddress>(), servicesA.addresses())
        } finally {
            finish.complete(Unit)
            rawKv.beforeRemove = null
        }
    }

    @Test
    fun `a listing queued on the address lock ahead of a removal is filtered by that removal`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        lists(machine, "removed")
        servicesA.addAddress(machine.base, "Removed")
        servicesA.addressWork.lock.lock()
        var unlocked = false
        try {
            val reading = scope.async { servicesA.source.listing() }
            delay(300)
            val removing = scope.async { servicesA.removeAddress(machine.base) }
            delay(300)
            servicesA.addressWork.lock.unlock()
            unlocked = true
            awaitGate("the removal to end", removing)
            val listing = awaitGate("the listing to end", reading)
            assertEquals(emptyList<String>(), listing.machines.map { it.id })
            assertNull("no cache comes back for the removed address", a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(emptyList<MachineAddress>(), servicesA.addresses())
        } finally {
            if (!unlocked) servicesA.addressWork.lock.unlock()
        }
    }


    @Test
    fun `a listing answer that waits on the lock while a removal holds it writes no cache for the removed address`() = runBlocking {
        val release = java.util.concurrent.CountDownLatch(1)
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        listsWhenReleased(machine, release, "removed")
        servicesA.addAddress(machine.base, "Removed")
        val writing = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        rawKv.beforeWrite = { key, value ->
            if (key.endsWith(MACHINE_ADDRESSES_KEY) && value == "[]") {
                writing.complete(Unit)
                finish.await()
            }
        }
        try {
            val reading = scope.async { servicesA.source.listing() }
            waitFor("the address to be asked") { machine.calls.any { it.rawPath == "/machines" } }
            val removing = scope.async { servicesA.removeAddress(machine.base) }
            awaitGate("the removal to hold its write", writing)
            release.countDown()
            delay(300)
            rawKv.beforeWrite = null
            finish.complete(Unit)
            awaitGate("the removal to end", removing)
            val listing = awaitGate("the listing to end", reading)
            assertEquals(emptyList<String>(), listing.machines.map { it.id })
            assertNull("no cache comes back for the removed address", a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(emptyList<MachineAddress>(), servicesA.addresses())
        } finally {
            release.countDown()
            finish.complete(Unit)
            rawKv.beforeWrite = null
        }
    }

    @Test
    fun `an answer from before an address was removed and added again never stands for the new one`() = runBlocking {
        val release = java.util.concurrent.CountDownLatch(1)
        val asked = java.util.concurrent.atomic.AtomicInteger(0)
        try {
            val auth = signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a, defaultRelay = "")
            machine.handler = { call ->
                if (call.rawPath == "/machines") {
                    if (asked.incrementAndGet() == 1) {
                        release.await(10, java.util.concurrent.TimeUnit.SECONDS)
                        answer(200, machinesJson("old-incarnation"))
                    } else answer(200, machinesJson("new-incarnation"))
                } else answer(404, "{}")
            }
            servicesA.addAddress(machine.base, "Again")
            val older = async(Dispatchers.Default) { servicesA.source.listing() }
            waitFor("the first answer to be held") { asked.get() == 1 }

            servicesA.removeAddress(machine.base)
            servicesA.addAddress(machine.base, "Again")
            assertEquals(listOf("new-incarnation"), servicesA.source.listing().machines.map { it.id })
            val cacheOfTheNewOne = a.kv.get(machinesCacheKey(machine.base))
            release.countDown()
            val old = older.await()

            assertEquals(emptyList<String>(), old.machines.map { it.id })
            assertEquals("the old answer writes no cache over the new one", cacheOfTheNewOne, a.kv.get(machinesCacheKey(machine.base)))
            assertEquals(listOf("new-incarnation"), servicesA.source.listing().machines.map { it.id })
        } finally {
            release.countDown()
        }
    }

    @Test
    fun `a listing never waits for the push lock a push registration holds across the network`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        lists(machine, "a1")
        servicesA.addAddress(machine.base)
        servicesA.pushWork.lock.lock()
        try {
            val listing = kotlinx.coroutines.withTimeout(5_000) { servicesA.source.listing() }
            assertEquals(listOf("a1"), listing.machines.map { it.id })
            assertTrue("the cache is written under the address lock alone", a.kv.get(machinesCacheKey(machine.base)) != null)
        } finally {
            servicesA.pushWork.lock.unlock()
        }
    }

    @Test
    fun `removing one address while another is still asked keeps the other's cache`() = runBlocking {
        val other = FakeMachine()
        val releaseRemoved = java.util.concurrent.CountDownLatch(1)
        val releaseKept = java.util.concurrent.CountDownLatch(1)
        try {
            val auth = signedIn("sub-a")
            val a = storesOf(auth)
            val servicesA = services(auth, a, defaultRelay = "")
            listsWhenReleased(machine, releaseRemoved, "gone")
            listsWhenReleased(other, releaseKept, "kept")
            servicesA.addAddress(machine.base, "Removed")
            servicesA.addAddress(other.base, "Kept")
            val reading = async(Dispatchers.Default) { servicesA.source.listing() }
            waitFor("both addresses to be asked") {
                machine.calls.any { it.rawPath == "/machines" } && other.calls.any { it.rawPath == "/machines" }
            }

            servicesA.removeAddress(machine.base)
            releaseKept.countDown()
            releaseRemoved.countDown()
            val listing = reading.await()
            assertEquals(listOf("kept"), listing.machines.map { it.id })
            assertTrue("the kept address's answer is its cache", a.kv.get(machinesCacheKey(other.base)) != null)
            assertNull(a.kv.get(machinesCacheKey(machine.base)))

            // Its next read fails: its last list stands in, offline.
            lists(other, "kept") { 503 }
            val later = servicesA.source.listing()
            assertEquals(listOf("kept"), later.machines.map { it.id })
            assertFalse(later.machines.single().online)
            assertTrue(later.addresses.single().fromCache)
        } finally {
            releaseRemoved.countDown()
            releaseKept.countDown()
            other.close()
        }
    }

    @Test
    fun `a listing that waits for the address lock while the account changes writes no cache`() = runBlocking {
        val authA = signedIn("sub-a")
        val a = storesOf(authA)
        val servicesA = services(authA, a, defaultRelay = "")
        servicesA.addAddress(machine.base)
        machine.handler = { call -> if (call.rawPath == "/machines") machine.hold(call) else answer(404, "{}") }
        val listing = scope.async { runCatching { servicesA.source.listing() } }
        // The listing has taken its snapshot and asked; the lock is held when its answer lands.
        until(what = "the address to be asked") { machine.held.size == 1 }
        servicesA.addressWork.lock.lock()
        try {
            machine.respond(0, answer(200, machinesJson("a1")))
            delay(300)
            authA.signOut()
        } finally {
            servicesA.addressWork.lock.unlock()
        }
        val outcome = awaitGate("the listing to end", listing)
        assertTrue("the old owner's listing is refused: $outcome", outcome.isFailure)
        assertNull(a.kv.get(machinesCacheKey(machine.base)))
    }

    @Test
    fun `an address answering 5xx lends its cache and says why beside the one that answers, and a refusal is never papered over`() = runBlocking {
        val other = FakeMachine()
        try {
            val auth = signedIn("sub-a")
            val servicesA = services(auth, storesOf(auth), defaultRelay = "")
            var status = 200
            lists(machine, "a1")
            lists(other, "b1") { status }
            servicesA.addAddress(machine.base)
            servicesA.addAddress(other.base)
            val fresh = servicesA.source.listing()
            assertEquals(listOf("a1", "b1"), fresh.machines.map { it.id })

            status = 503
            val cached = servicesA.source.listing()
            assertEquals(listOf("a1", "b1"), cached.machines.map { it.id })
            assertTrue(cached.machines[0].online)
            assertEquals(fresh.machines[1].copy(online = false), cached.machines[1])
            assertEquals(other.base, cached.machines[1].address)
            assertEquals(AddressListing(MachineAddress(machine.base), listOf("a1"), null, fromCache = false), cached.addresses[0])
            assertEquals(AddressListing(MachineAddress(other.base), listOf("b1"), "The relay answered 503.", fromCache = true), cached.addresses[1])

            status = 401
            val refused = servicesA.source.listing()
            assertEquals(listOf("a1"), refused.machines.map { it.id })
            assertEquals(AddressListing(MachineAddress(other.base), emptyList(), "The relay refused the sign-in.", fromCache = false), refused.addresses[1])
        } finally {
            other.close()
        }
    }

    @Test
    fun `an address that refuses the connection lends its cache, and one never read gives only its sentence`() = runBlocking {
        val other = FakeMachine()
        val never = FakeMachine()
        val neverBase = never.base
        never.close()
        try {
            val auth = signedIn("sub-a")
            val servicesA = services(auth, storesOf(auth), defaultRelay = "")
            lists(machine, "a1")
            lists(other, "b1")
            servicesA.addAddress(machine.base)
            servicesA.addAddress(other.base)
            assertEquals(listOf("a1", "b1"), servicesA.source.list().map { it.id })
            val otherBase = other.base
            other.close()
            servicesA.addAddress(neverBase)

            val listing = servicesA.source.listing()
            assertEquals(listOf("a1", "b1"), listing.machines.map { it.id })
            assertFalse(listing.machines[1].online)
            assertEquals(
                listOf(
                    AddressListing(MachineAddress(machine.base), listOf("a1"), null, fromCache = false),
                    AddressListing(MachineAddress(otherBase), listOf("b1"), "The relay could not be reached.", fromCache = true),
                    AddressListing(MachineAddress(neverBase), emptyList(), "The relay could not be reached.", fromCache = false),
                ),
                listing.addresses,
            )
        } finally {
            runCatching { other.close() }
        }
    }

    @Test
    fun `forgetting a machine clears its push registration first, then its credential, record and push token`() = runBlocking {
        val auth = signedIn("sub-a")
        val a = storesOf(auth)
        val servicesA = services(auth, a, defaultRelay = "")
        pairedThroughAddress(servicesA)
        val routes = machine.handler
        val pairedAtClear = CopyOnWriteArrayList<Boolean>()
        machine.handler = { call ->
            if (call.line == "POST /devices/me/push-token/clear") {
                pairedAtClear += rawSecure.map.keys.any { it.endsWith("clave.credential.m1") }
                pairedAtClear += rawKv.map.values.any { it.contains("\"machineId\":\"m1\"") }
            }
            routes(call)
        }
        assertEquals(PushCleanupResult(pending = 0, retryRecorded = true), servicesA.forgetMachine("m1"))
        assertEquals(1, machine.count("POST /devices/me/push-token/clear"))
        assertEquals(listOf(true, true), pairedAtClear)
        assertNull(a.credentials.get("m1"))
        assertNull(a.credentials.mainMachineId())
        assertEquals(emptyList<EnrollmentRecord>(), servicesA.records.list())
        assertNull(a.kv.get(pushTokenKey("m1")))
        // The address that lists it stays, and so does its row, now unpaired.
        assertEquals(listOf(MachineAddress(machine.base)), servicesA.addresses())
        assertEquals("${machine.base}/m/m1", servicesA.source.list().single().baseUrl)
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
