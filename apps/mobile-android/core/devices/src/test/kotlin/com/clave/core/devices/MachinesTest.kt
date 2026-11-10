package com.clave.core.devices

import com.clave.core.contract.MachinePlatform
import com.clave.core.ports.MemoryKeyValueStore
import com.clave.core.ports.MemorySecureStore
import java.time.Instant
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private const val HUB_TOKEN = "hub-access-token"
private const val SERVER_TOKEN = "server-token"

private fun json(status: Int, body: String) =
    MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body)

class MachinesTest {
    /** A stub of the relay's wire, as its contract states it; a body can be swapped per test. */
    private val relay = MockWebServer()
    private val clave = MockWebServer()
    private var relayBody: String? = null
    private lateinit var relayUrl: String
    private lateinit var claveUrl: String

    @Before
    fun start() {
        relay.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path != "/machines") return MockResponse().setResponseCode(404)
                if (request.getHeader("Authorization") != "Bearer $HUB_TOKEN") return json(401, """{"error":"Unauthenticated"}""")
                return json(200, relayBody ?: MACHINES)
            }
        }
        clave.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.getHeader("Authorization") != "Bearer $SERVER_TOKEN") return json(401, """{"error":"Unauthenticated"}""")
                return json(200, """{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}""")
            }
        }
        relay.start()
        clave.start()
        relayUrl = "http://127.0.0.1:${relay.port}"
        claveUrl = "http://127.0.0.1:${clave.port}"
    }

    @After
    fun stop() {
        relay.shutdown()
        clave.shutdown()
    }

    private fun source(token: String = HUB_TOKEN, url: String = relayUrl) =
        RelayMachineSource(url, { token }, JvmHttp(), BuildKind.Development)

    @Test
    fun `lists the machines of the token's subject with the relay road as base`() = runBlocking {
        val machines = source(url = "$relayUrl/").list()
        assertEquals(3, machines.size)
        assertEquals(
            Machine(
                id = "mac-1",
                name = "Valentin's Mac",
                platform = MachinePlatform.Macos,
                version = "2.4.0",
                online = true,
                lastSeen = Instant.parse("2026-10-29T15:00:00Z").toEpochMilli(),
                baseUrl = "$relayUrl/m/mac-1",
                pushUrl = "$relayUrl/m/mac-1/push",
            ),
            machines[0],
        )
        with(machines[1]) {
            assertEquals("vps 1", id)
            assertFalse(online)
            assertNull(lastSeen)
            assertEquals("$relayUrl/m/vps%201", baseUrl)
            assertEquals(MachinePlatform.Linux, platform)
        }
        with(machines[2]) {
            assertEquals("odd", id)
            assertEquals("odd", name)
            assertEquals(MachinePlatform.Unknown, platform)
            assertFalse(online)
            assertEquals("", version)
        }
    }

    @Test
    fun `sends the hub token as the bearer, and a number is a last-seen too`() = runBlocking {
        relayBody = """{"machines":[{"id":"m","lastSeen":1700000000000}]}"""
        assertEquals(1_700_000_000_000L, source().list().single().lastSeen)
        val recorded = relay.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("Bearer $HUB_TOKEN", recorded.getHeader("Authorization"))
    }

    @Test
    fun `a bad hub token is unauthenticated, and the token is in no message`() = runBlocking {
        try {
            source(token = "stale").list()
            fail("expected a refusal")
        } catch (e: MachinesError) {
            assertEquals(MachinesError.Kind.Unauthenticated, e.kind)
            assertEquals(401, e.status)
            assertFalse(e.message!!.contains("stale"))
        }
    }

    private suspend fun protocolOf(body: String): MachinesError {
        relayBody = body
        try {
            source().list()
        } catch (e: MachinesError) {
            return e
        }
        throw AssertionError("expected a protocol failure for $body")
    }

    @Test
    fun `an unreadable answer, a missing list or a row without an id is a protocol failure`() = runBlocking {
        assertEquals(MachinesError.Kind.Protocol, protocolOf("not json").kind)
        assertEquals(MachinesError.Kind.Protocol, protocolOf("""{"rows":[]}""").kind)
        val noId = protocolOf("""{"machines":[{"id":"a"},{"name":"b"}]}""")
        assertEquals(MachinesError.Kind.Protocol, noId.kind)
        assertEquals("The relay's machine 1 has no id.", noId.message)
    }

    @Test
    fun `a relay that answers 500 is a protocol failure, an unreachable one a network failure`() = runBlocking {
        try {
            source(url = "$relayUrl/elsewhere").list()
            fail("expected a failure")
        } catch (e: MachinesError) {
            assertEquals(MachinesError.Kind.Protocol, e.kind)
            assertEquals(404, e.status)
        }
        try {
            RelayMachineSource("http://127.0.0.1:1", { HUB_TOKEN }, JvmHttp(), BuildKind.Development).list()
            fail("expected a failure")
        } catch (e: MachinesError) {
            assertEquals(MachinesError.Kind.Network, e.kind)
        }
    }

    @Test
    fun `builds the road URLs`() {
        assertEquals("https://relay.example/m/abc", machineBaseUrl("https://relay.example/", "abc"))
        assertEquals("https://relay.example/m/abc/push", machinePushUrl("https://relay.example", "abc"))
    }

    @Test
    fun `keeps one credential per machine, the first paired as main`() = runBlocking {
        val secure = MemorySecureStore()
        val store = SecureCredentialStore(secure)
        assertNull(store.get("m1"))
        store.set("m1", Credential("http://a", "x"))
        store.set("m 2", Credential("http://b", "y"))
        assertEquals(Credential("http://a", "x"), store.get("m1"))
        assertEquals(Credential("http://b", "y"), store.get("m 2"))
        assertEquals("m1", store.mainMachineId())
        assertTrue(secure.map.containsKey("clave.credential.m_202"))
        for (key in secure.map.keys) assertTrue(key, Regex("^[A-Za-z0-9._-]+$").matches(key))
        store.remove("m1")
        assertNull(store.get("m1"))
        assertNull(store.mainMachineId())
        secure.map["clave.credential.bad"] = "{not json"
        assertNull(store.get("bad"))
    }

    @Test
    fun `a credential printed says nothing of its bearer`() {
        assertFalse(Credential("https://a", "secret-bearer").toString().contains("secret-bearer"))
    }

    @Test
    fun `normalizes the address`() {
        assertEquals("http://127.0.0.1:43201", normalizeServerUrl(" 127.0.0.1:43201/ "))
        assertEquals("https://relay.example/m/x", normalizeServerUrl("https://relay.example/m/x/"))
        try {
            normalizeServerUrl("ftp://x")
            fail("expected a refusal")
        } catch (_: IllegalArgumentException) {
        }
        assertEquals("dev:127.0.0.1:43201", developerMachineId("http://127.0.0.1:43201"))
    }

    @Test
    fun `tries the token once, keeps it in the credential store and lists the machine`() = runBlocking {
        val kv = MemoryKeyValueStore()
        val credentials = SecureCredentialStore(MemorySecureStore())
        val source = DeveloperMachineSource(kv, credentials, JvmHttp(), clock = { 42 })
        try {
            source.add(claveUrl, "wrong", "Dev")
            fail("expected a refusal")
        } catch (e: MachinesError) {
            assertEquals(MachinesError.Kind.Unauthenticated, e.kind)
            assertFalse(e.message!!.contains("wrong"))
        }
        assertEquals(emptyList<Machine>(), source.list())
        val machine = source.add(claveUrl, SERVER_TOKEN, "Dev")
        assertEquals("dev:127.0.0.1:${clave.port}", machine.id)
        assertEquals("Dev", machine.name)
        assertEquals(claveUrl, machine.baseUrl)
        assertEquals("$claveUrl/push", machine.pushUrl)
        assertTrue(machine.online)
        assertEquals(Credential(claveUrl, SERVER_TOKEN), credentials.get(machine.id))
        assertEquals(listOf(machine), source.list())
        assertEquals(DeveloperMachineRecord(machine.id, "Dev", claveUrl, 42), source.records().single())
        assertFalse(kv.map.values.any { it.contains(SERVER_TOKEN) })
        val recorded = clave.takeRequest()
        assertEquals("/launch-profiles", recorded.path)
        source.remove(machine.id)
        assertEquals(emptyList<Machine>(), source.list())
        assertNull(credentials.get(machine.id))
    }

    @Test
    fun `a developer machine off the loopback is refused before the token is sent`() = runBlocking {
        val source = DeveloperMachineSource(MemoryKeyValueStore(), SecureCredentialStore(MemorySecureStore()), JvmHttp())
        try {
            source.add("http://192.168.1.5:43201", SERVER_TOKEN)
            fail("expected a refusal")
        } catch (e: TransportPolicyError) {
            assertFalse(e.message!!.contains(SERVER_TOKEN))
        }
        assertEquals(0, clave.requestCount)
    }

    private companion object {
        const val MACHINES = """{"machines":[
            {"id":"mac-1","name":"Valentin's Mac","platform":"macos","version":"2.4.0","online":true,
             "lastSeen":"2026-10-29T15:00:00Z","direct":[{"url":"http://100.64.0.2:43127"}]},
            {"id":"vps 1","name":"VPS","platform":"linux","version":"2.3.0","online":false,"lastSeen":null,"direct":[]},
            {"id":"odd","platform":"windows","online":"yes"}
        ]}"""
    }
}
