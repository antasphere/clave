package com.clave.core.devices

import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.DevicePlatform
import com.clave.core.contract.DeviceSession
import com.clave.core.contract.DeviceView
import com.clave.core.contract.PairingRead
import com.clave.core.contract.PairingStatus
import com.clave.core.contract.PairingTicket
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpResponse
import com.clave.core.ports.MemoryKeyValueStore
import com.clave.core.ports.MemorySecureStore
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private val device = DeviceDescription("approve-me", DevicePlatform.Android, "0.1.0")

/**
 * A stub of the device routes, speaking them as the contract defines them, scripted by the
 * device's name: what the owner does on the Mac is what the name says.
 */
class EnrollmentClientTest {
    private val server = MockWebServer()
    private val requests = mutableListOf<Pair<RecordedRequest, String>>()
    private val pairings = mutableMapOf<String, Pair<String, Int>>()
    private val sessions = mutableSetOf<String>()
    private val revoked = mutableSetOf<String>()
    private val pushTokens = mutableListOf<Pair<String, String>>()
    private val clears = mutableListOf<String>()
    private var serial = 0
    private lateinit var url: String

    private fun json(status: Int, body: String) =
        MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body)

    private fun sessionJson(id: String) =
        """{"token":"ds-$id","deviceId":"dev-$id","serverId":"srv-1","serverName":"Valentin’s Mac"}"""

    @Before
    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@EnrollmentClientTest) {
                handle(request)
            }
        }
        server.start()
        url = "http://127.0.0.1:${server.port}"
    }

    @After
    fun stop() = server.shutdown()

    private fun handle(request: RecordedRequest): MockResponse {
        val path = request.path ?: "/"
        val route = "${request.method} ${path.substringBefore('?')}"
        val raw = request.body.readUtf8()
        if (route == "POST /devices/pair") {
            requests += request to raw
            val body = Json.parseToJsonElement(raw).jsonObject
            val name = body["device"]!!.jsonObject["name"]!!.jsonPrimitive.content
            val idToken = body["idToken"]!!.jsonPrimitive.content
            if (name == "hang") return json(200, "{}").setHeadersDelay(2, TimeUnit.SECONDS)
            if (idToken == "bad-token") {
                return json(422, """{"_tag":"DevicePairingRefused","check":"signature","message":"The sign-in was refused by the signature check."}""")
            }
            if (idToken == "no-owner") {
                return json(422, """{"_tag":"CapabilityUnavailable","capability":"devices","message":"No Antasphere account is signed in on this server."}""")
            }
            if (idToken == "odd-tag") return json(422, """{"_tag":"SomethingElse"}""")
            val id = "p-${++serial}"
            pairings[id] = name to 0
            return json(200, """{"pairingId":"$id","expiresAt":${System.currentTimeMillis() + 600_000}}""")
        }
        if (route == "GET /devices/pair") {
            val id = path.substringAfter("id=", "")
            val (name, reads) = pairings[id] ?: return json(200, """{"status":"expired"}""")
            val n = reads + 1
            pairings[id] = name to n
            return when {
                n < 3 -> json(200, """{"status":"pending"}""")
                n == 3 -> {
                    sessions += "ds-$id"
                    json(200, """{"status":"approved","deviceSession":${sessionJson(id)}}""")
                }
                else -> json(200, """{"status":"approved"}""")
            }
        }
        val bearer = request.getHeader("Authorization")?.removePrefix("Bearer ")
        if (bearer == null || bearer !in sessions) return json(401, """{"error":"Unauthenticated"}""")
        if (bearer in revoked) return json(422, """{"_tag":"DeviceNotFound","id":"x","message":"No such device."}""")
        return when (route) {
            "GET /devices/me" -> json(
                200,
                """{"id":"dev-${bearer.drop(3)}","name":"Pixel 10","platform":"android","appVersion":"0.1.0","createdAt":1,"lastSeenAt":null}""",
            )
            "POST /devices/me/push-token" -> {
                pushTokens += bearer to raw
                MockResponse().setResponseCode(204)
            }
            "POST /devices/me/push-token/clear" -> {
                clears += bearer
                MockResponse().setResponseCode(204)
            }
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    private fun client(timeoutMs: Long = 10_000) = EnrollmentClient(url, JvmHttp(), BuildKind.Development, timeoutMs)

    private suspend fun failureOf(block: suspend () -> Unit): EnrollmentError {
        try {
            block()
        } catch (e: EnrollmentError) {
            return e
        }
        throw AssertionError("expected an EnrollmentError")
    }

    @Test
    fun `asks to pair with the ID token, the client id and the device, and no bearer`() = runBlocking {
        val ticket = client().requestPairing("id-1", "c-1", device)
        assertTrue(ticket.pairingId.startsWith("p-"))
        assertTrue(ticket.expiresAt > System.currentTimeMillis())
        assertEquals(1, requests.size)
        assertNull(requests[0].first.getHeader("Authorization"))
        assertEquals("application/json", requests[0].first.getHeader("Content-Type"))
        val sent = Json.parseToJsonElement(requests[0].second)
        assertEquals(
            Json.parseToJsonElement("""{"idToken":"id-1","clientId":"c-1","device":{"name":"approve-me","platform":"android","appVersion":"0.1.0"}}"""),
            sent,
        )
    }

    @Test
    fun `a token the server refuses is said with the check that refused it, never the token`() = runBlocking {
        val error = failureOf { client().requestPairing("bad-token", "c-1", device) }
        assertEquals(EnrollmentFailure.Refused, error.kind)
        assertEquals("signature", error.check)
        assertEquals(422, error.status)
        assertFalse(error.message!!.contains("bad-token"))
    }

    @Test
    fun `a server nobody owns admits no phone`() = runBlocking {
        val error = failureOf { client().requestPairing("no-owner", "c-1", device) }
        assertEquals(EnrollmentFailure.NoOwner, error.kind)
        assertEquals("This machine has no Antasphere login. Sign in on it first, then pair.", error.message)
    }

    @Test
    fun `a refusal of a tag this client does not read is a protocol failure`() = runBlocking {
        val error = failureOf { client().requestPairing("odd-tag", "c-1", device) }
        assertEquals(EnrollmentFailure.Protocol, error.kind)
        assertEquals("The machine refused (SomethingElse).", error.message)
    }

    @Test
    fun `reads the pairing, the session carried once`() = runBlocking {
        val c = client()
        val pairingId = c.requestPairing("id-1", "c-1", device).pairingId
        assertEquals(PairingRead(PairingStatus.Pending), c.readPairing(pairingId))
        assertEquals(PairingRead(PairingStatus.Pending), c.readPairing(pairingId))
        val approved = c.readPairing(pairingId)
        assertEquals(PairingStatus.Approved, approved.status)
        assertEquals(DeviceSession("ds-$pairingId", "dev-$pairingId", "srv-1", "Valentin’s Mac"), approved.deviceSession)
        assertEquals(PairingRead(PairingStatus.Approved), c.readPairing(pairingId))
        assertEquals(PairingRead(PairingStatus.Expired), c.readPairing("never"))
    }

    @Test
    fun `the device's own routes carry the device session as the bearer`() = runBlocking {
        sessions += "ds-ok"
        val c = client()
        assertEquals(DeviceView("dev-ok", "Pixel 10", DevicePlatform.Android, "0.1.0", 1, null), c.me("ds-ok"))
        c.setPushToken("ds-ok", "fcm-token-1", DevicePlatform.Android)
        c.clearPushToken("ds-ok")
        assertEquals(1, pushTokens.size)
        assertEquals("ds-ok", pushTokens[0].first)
        assertEquals(Json.parseToJsonElement("""{"token":"fcm-token-1","platform":"android"}"""), Json.parseToJsonElement(pushTokens[0].second))
        assertEquals(listOf("ds-ok"), clears)
    }

    @Test
    fun `a session the server does not know is unauthenticated, a revoked phone is revoked`() = runBlocking {
        val c = client()
        val unknown = failureOf { c.me("ds-nope") }
        assertEquals(EnrollmentFailure.Unauthenticated, unknown.kind)
        assertFalse(unknown.message!!.contains("ds-nope"))
        sessions += "ds-gone"
        revoked += "ds-gone"
        val gone = failureOf { c.me("ds-gone") }
        assertEquals(EnrollmentFailure.Revoked, gone.kind)
        assertFalse(gone.message!!.contains("ds-gone"))
        val push = failureOf { c.setPushToken("ds-gone", "fcm-secret", DevicePlatform.Android) }
        assertFalse(push.message!!.contains("fcm-secret"))
    }

    @Test
    fun `DeviceSessionRequired is revoked too`() = runBlocking {
        val http = HttpPort { HttpResponse(422, """{"_tag":"DeviceSessionRequired","message":""}""") }
        val error = failureOf { EnrollmentClient("https://relay.example/m/a", http).me("ds") }
        assertEquals(EnrollmentFailure.Revoked, error.kind)
        assertEquals("This phone is no longer paired with the machine.", error.message)
    }

    @Test
    fun `a release build sends no credential to a plain-http address`() {
        try {
            EnrollmentClient(url, JvmHttp(), BuildKind.Release)
            fail("expected a policy refusal")
        } catch (e: EnrollmentError) {
            assertEquals(EnrollmentFailure.Policy, e.kind)
        }
        EnrollmentClient("https://relay.example/m/abc", JvmHttp())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `an unreachable machine is a network failure, a silent one a timeout`() = runBlocking {
        val dead = EnrollmentClient("http://127.0.0.1:1", JvmHttp(), BuildKind.Development)
        assertEquals(EnrollmentFailure.Network, failureOf { dead.requestPairing("id", "c", device) }.kind)
        val timeout = failureOf { client(timeoutMs = 300).requestPairing("id", "c", device.copy(name = "hang")) }
        assertEquals(EnrollmentFailure.Timeout, timeout.kind)
        assertEquals("The machine did not answer within 0.3 s.", timeout.message)
    }

    @Test
    fun `a 2xx answer that is not JSON is a protocol failure`() = runBlocking {
        val http = HttpPort { HttpResponse(200, "<html>") }
        assertEquals(EnrollmentFailure.Protocol, failureOf { EnrollmentClient("https://a.example", http).readPairing("p") }.kind)
        val noStatus = HttpPort { HttpResponse(200, """{"status":"maybe"}""") }
        assertEquals(EnrollmentFailure.Protocol, failureOf { EnrollmentClient("https://a.example", noStatus).readPairing("p") }.kind)
    }

    @Test
    fun `the whole pairing against the routes keeps the session under the machine id`() = runBlocking {
        val credentials = SecureCredentialStore(MemorySecureStore())
        val records = EnrollmentRecords(MemoryKeyValueStore())
        val end = pair(
            PairingInput("m-1", url, "id-1", "c-1", device),
            PairingPorts(client(), credentials, records, sleep = {}, clock = { System.currentTimeMillis() }),
        )
        assertTrue(end is PairingState.Approved)
        assertEquals(Credential(url, "ds-p-1"), credentials.get("m-1"))
        assertEquals("dev-p-1", records.get("m-1")?.deviceId)
    }
}

/** A client whose answers the test writes in order; a [Throwable] in the script is thrown. */
private class ScriptedClient(
    private val ticket: Any = PairingTicket("p-1", 10_000),
    reads: List<Any> = emptyList(),
) : PairingClient {
    private val reads = ArrayDeque(reads)
    var readCount = 0
    var onRead: (PairingRead) -> Unit = {}

    override suspend fun requestPairing(idToken: String, clientId: String, device: DeviceDescription): PairingTicket {
        if (ticket is Exception) throw ticket
        return ticket as PairingTicket
    }

    override suspend fun readPairing(pairingId: String): PairingRead {
        readCount += 1
        val next = reads.removeFirstOrNull() ?: PairingRead(PairingStatus.Pending)
        if (next is Exception) throw next
        return (next as PairingRead).also(onRead)
    }
}

private val pending = PairingRead(PairingStatus.Pending)
private val approved = PairingRead(PairingStatus.Approved, DeviceSession("ds-p-1", "dev-p-1", "srv-1", "Valentin’s Mac"))

class PairingTest {
    private val credentials = SecureCredentialStore(MemorySecureStore())
    private val records = EnrollmentRecords(MemoryKeyValueStore())
    private val states = mutableListOf<PairingState>()
    private val sleeps = mutableListOf<Long>()
    private var now = 1_000L
    private val input = PairingInput("m-1", "https://relay.example/m/m-1", "id-1", "c-1", device)

    private fun ports(
        client: PairingClient,
        cancelled: () -> Boolean = { false },
        persist: (suspend (EnrollmentRecord, Credential) -> Boolean)? = null,
    ) = PairingPorts(
        client = client,
        credentials = credentials,
        records = records,
        persist = persist,
        sleep = { ms -> sleeps += ms; now += ms },
        clock = { now },
        onState = { states += it },
        cancelled = cancelled,
    )

    @Test
    fun `waits two seconds between reads, then keeps the session under the machine id`() = runTest {
        val end = pair(input, ports(ScriptedClient(reads = listOf(pending, pending, approved))))
        assertTrue(end is PairingState.Approved)
        assertEquals(
            listOf("Requesting", "Waiting", "Waiting", "Waiting", "Approved"),
            states.map { it::class.simpleName },
        )
        assertEquals(listOf(2_000L, 2_000L, 2_000L), sleeps)
        assertEquals(listOf(0, 1, 2), states.filterIsInstance<PairingState.Waiting>().map { it.polls })
        assertEquals(Credential("https://relay.example/m/m-1", "ds-p-1"), credentials.get("m-1"))
        assertEquals("m-1", credentials.mainMachineId())
        val record = records.get("m-1")
        assertEquals(EnrollmentRecord("m-1", "dev-p-1", "srv-1", "Valentin’s Mac", now), record)
        assertEquals(record, records.byServerId("srv-1"))
        assertEquals(PairingState.Approved(record!!), end)
    }

    @Test
    fun `a refusal on the Mac is refused here, nothing kept`() = runTest {
        val end = pair(input, ports(ScriptedClient(reads = listOf(pending, PairingRead(PairingStatus.Refused)))))
        assertEquals(PairingState.Refused, end)
        assertNull(credentials.get("m-1"))
        assertNull(records.get("m-1"))
    }

    @Test
    fun `discards an approved response cancelled while the polling request was awaited`() = runTest {
        var cancelled = false
        val client = ScriptedClient(reads = listOf(pending, approved)).apply {
            onRead = { if (it.status == PairingStatus.Approved) cancelled = true }
        }
        assertEquals(PairingState.Cancelled, pair(input, ports(client, cancelled = { cancelled })))
        assertNull(credentials.get("m-1"))
        assertNull(records.get("m-1"))
    }

    @Test
    fun `a pairing the server let lapse is expired`() = runTest {
        assertEquals(PairingState.Expired, pair(input, ports(ScriptedClient(reads = listOf(PairingRead(PairingStatus.Expired))))))
    }

    @Test
    fun `a pairing still pending past the deadline and the grace is expired here`() = runTest {
        val client = ScriptedClient(ticket = PairingTicket("p-1", now))
        assertEquals(PairingState.Expired, pair(input, ports(client), PairingOptions(graceMs = 0)))
        assertEquals(1, client.readCount)
    }

    @Test
    fun `an approval already handed out is a failure that says to pair again`() = runTest {
        val end = pair(input, ports(ScriptedClient(reads = listOf(PairingRead(PairingStatus.Approved)))))
        assertEquals(
            PairingState.Failed(EnrollmentFailure.Consumed, "The approval was already handed out and cannot be read again. Pair again."),
            end,
        )
        assertNull(credentials.get("m-1"))
    }

    @Test
    fun `a read the network loses keeps the wait, and the approval still lands`() = runTest {
        val lost = EnrollmentError(EnrollmentFailure.Network, "The machine could not be reached.")
        val timedOut = EnrollmentError(EnrollmentFailure.Timeout, "The machine did not answer within 10 s.")
        val client = ScriptedClient(reads = listOf(lost, timedOut, approved))
        val end = pair(input, ports(client))
        assertTrue(end is PairingState.Approved)
        assertEquals(3, sleeps.size)
        assertNotNull(credentials.get("m-1"))
    }

    @Test
    fun `a transient failure past the deadline and the grace is a failure`() = runTest {
        val lost = EnrollmentError(EnrollmentFailure.Network, "The machine could not be reached.")
        val end = pair(input, ports(ScriptedClient(ticket = PairingTicket("p-1", now), reads = listOf(lost))), PairingOptions(graceMs = 0))
        assertEquals(PairingState.Failed(EnrollmentFailure.Network, "The machine could not be reached."), end)
    }

    @Test
    fun `a failure that is not the network ends the pairing`() = runTest {
        val revoked = EnrollmentError(EnrollmentFailure.Protocol, "The machine answered 500.", status = 500)
        val end = pair(input, ports(ScriptedClient(reads = listOf(pending, revoked))))
        assertEquals(PairingState.Failed(EnrollmentFailure.Protocol, "The machine answered 500."), end)
    }

    @Test
    fun `leaving the screen stops the polling`() = runTest {
        val client = ScriptedClient()
        val end = pair(input, ports(client, cancelled = { sleeps.size >= 1 }))
        assertEquals(PairingState.Cancelled, end)
        assertEquals(0, client.readCount)
    }

    @Test
    fun `a refused token fails with the check named`() = runTest {
        val refused = EnrollmentError(EnrollmentFailure.Refused, "The sign-in was refused by the signature check.", check = "signature")
        val end = pair(input.copy(idToken = "bad-token"), ports(ScriptedClient(ticket = refused)))
        assertEquals(PairingState.Failed(EnrollmentFailure.Refused, "The sign-in was refused by the signature check.", "signature"), end)
        assertEquals(emptyList<Long>(), sleeps)
    }

    @Test
    fun `persist owns the commit, and false is cancelled with nothing kept`() = runTest {
        val handed = mutableListOf<Pair<EnrollmentRecord, Credential>>()
        val end = pair(input, ports(ScriptedClient(reads = listOf(approved)), persist = { r, c -> handed += r to c; false }))
        assertEquals(PairingState.Cancelled, end)
        assertEquals(Credential("https://relay.example/m/m-1", "ds-p-1"), handed.single().second)
        assertNull(credentials.get("m-1"))
        assertNull(records.get("m-1"))
        states.clear()
        val kept = pair(input, ports(ScriptedClient(reads = listOf(approved)), persist = { _, _ -> true }))
        assertTrue(kept is PairingState.Approved)
        assertNull(credentials.get("m-1"))
    }

    @Test
    fun `the pairing input printed says nothing of the ID token`() {
        assertFalse(input.copy(idToken = "secret-id-token").toString().contains("secret-id-token"))
    }

    @Test
    fun `a transient failure on the request itself is a failure, not a wait`() = runTest {
        val end = pair(input, ports(ScriptedClient(ticket = HttpFailure.Network())))
        assertTrue(end is PairingState.Failed)
        assertEquals(EnrollmentFailure.Protocol, (end as PairingState.Failed).failure)
    }
}

class EnrollmentRecordsTest {
    @Test
    fun `keeps one record per machine, finds the latest by server, survives a restart`() = runTest {
        val kv = MemoryKeyValueStore()
        val first = EnrollmentRecords(kv)
        first.set(EnrollmentRecord("m-1", "d-1", "s-1", "A", 1))
        first.set(EnrollmentRecord("m-2", "d-2", "s-1", "A", 2))
        first.set(EnrollmentRecord("m-1", "d-3", "s-1", "A", 3))
        val second = EnrollmentRecords(kv)
        assertEquals(listOf("m-2", "m-1"), second.list().map { it.machineId })
        assertEquals("m-1", second.byServerId("s-1")?.machineId)
        assertNull(second.byServerId("s-9"))
        second.remove("m-1")
        assertEquals("m-2", second.byServerId("s-1")?.machineId)
        second.remove("m-2")
        assertNull(kv.get(ENROLLMENTS_KEY))
    }

    @Test
    fun `concurrent approvals retain both enrollment records`() = runBlocking {
        val records = EnrollmentRecords(SlowStore())
        listOf("m-1", "m-2").map { id ->
            async(kotlinx.coroutines.Dispatchers.Default) { records.set(EnrollmentRecord(id, "d-1", id, "Fixture", 1)) }
        }.awaitAll()
        assertEquals(setOf("m-1", "m-2"), records.list().map { it.machineId }.toSet())
    }

    @Test
    fun `an unreadable list is no record`() = runTest {
        val kv = MemoryKeyValueStore()
        kv.set(ENROLLMENTS_KEY, "{oops")
        assertEquals(emptyList<EnrollmentRecord>(), EnrollmentRecords(kv).list())
        kv.set(ENROLLMENTS_KEY, """[{"machineId":"m"},{"machineId":"m","deviceId":"d","serverId":"s"}]""")
        assertEquals(listOf(EnrollmentRecord("m", "d", "s", "", 0)), EnrollmentRecords(kv).list())
    }

    /** A store that yields between its read and its write, where an unserialized
     *  read-modify-write loses one of two records. */
    private class SlowStore : com.clave.core.ports.KeyValueStore {
        private val map = java.util.concurrent.ConcurrentHashMap<String, String>()
        override suspend fun get(key: String): String? = map[key].also { kotlinx.coroutines.delay(20) }
        override suspend fun set(key: String, value: String) { map[key] = value }
        override suspend fun remove(key: String) { map.remove(key) }
    }
}
