package com.clave.core.devices

import com.clave.core.devices.BuildKind.Development
import com.clave.core.devices.BuildKind.Release
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TransportPolicyTest {
    private fun ok(url: String, build: BuildKind) = credentialMayTravelTo(url, build).ok

    @Test
    fun `https and wss, always`() {
        assertEquals(TransportVerdict.Allowed, credentialMayTravelTo("https://relay.example/m/x", Release))
        assertEquals(TransportVerdict.Allowed, credentialMayTravelTo("wss://relay.example/m/x/push", Release))
        assertEquals(TransportVerdict.Allowed, credentialMayTravelTo("https://192.168.1.5:43201", Release))
    }

    @Test
    fun `plain http to the loopback in a development build only`() {
        assertTrue(ok("http://127.0.0.1:43201", Development))
        assertTrue(ok("ws://localhost:43201/push", Development))
        assertFalse(ok("http://192.168.1.5:43201", Development))
        assertFalse(ok("http://127.0.0.1:43201", Release))
        assertFalse(ok("ws://127.0.0.1:43201/push", Release))
        assertFalse(ok("http://100.64.0.2:43127", Release))
    }

    @Test
    fun `the loopback is the exact name the debug build lets through, and an address names a host`() {
        // Plain http only to 127.0.0.1 and localhost, as the debug network security config says;
        // a name that starts like one, another loopback form or the IPv6 loopback is refused.
        for (url in listOf(
            "http://localhost.evil.example/",
            "http://127.0.0.1.example/",
            "http://127.0.0.1./",
            "http://localhost./",
            "http://127.0.0.2/",
            "http://127.1/",
            "http://2130706433/",
            "http://0.0.0.0/",
            "http://[::1]:43201",
            "ws://[::1]:43201/push",
        )) {
            assertFalse(url, ok(url, Development))
        }
        assertTrue(ok("http://LOCALHOST:43201", Development))
        // An address with no host is no address, whatever its scheme and build.
        for (url in listOf("https:///m/x", "wss:///push", "http:///x")) {
            assertEquals(url, TransportVerdict.Refused("\"$url\" is not an address."), credentialMayTravelTo(url, Development))
            assertEquals(url, TransportVerdict.Refused("\"$url\" is not an address."), credentialMayTravelTo(url, Release))
        }
    }

    @Test
    fun `anything else never`() {
        assertFalse(ok("ftp://x", Development))
        assertFalse(ok("not an address", Release))
    }

    @Test
    fun `the reasons are the TypeScript's`() {
        assertEquals(
            TransportVerdict.Refused("A credential never travels over plain http (192.168.1.5:43201); only https is used."),
            credentialMayTravelTo("http://192.168.1.5:43201", Release),
        )
        assertEquals(
            TransportVerdict.Refused("Plain ws is allowed to 127.0.0.1 only in a development build; use https for 192.168.1.5:43201."),
            credentialMayTravelTo("ws://192.168.1.5:43201/push", Development),
        )
        assertEquals(TransportVerdict.Refused("\"ftp:\" is not a scheme a credential travels over."), credentialMayTravelTo("ftp://x", Development))
        assertEquals(TransportVerdict.Refused("\"not an address\" is not an address."), credentialMayTravelTo("not an address", Release))
        assertTrue(isLoopbackHost("LOCALHOST"))
    }

    @Test
    fun `assert throws the policy error with the address`() {
        try {
            assertCredentialMayTravelTo("http://192.168.1.5:43201", Release)
            fail("expected a TransportPolicyError")
        } catch (e: TransportPolicyError) {
            assertEquals("http://192.168.1.5:43201", e.url)
            assertTrue(e.message!!.contains("never travels over plain http"))
        }
    }

    @Test
    fun `a release build refuses a plain-http relay and a plain-http server before any request`() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val plain = server.url("/").toString().trimEnd('/')
            val http = JvmHttp()
            try {
                RelayMachineSource(plain, { "hub-token" }, http, Release)
                fail("expected the relay to be refused")
            } catch (e: TransportPolicyError) {
                assertFalse(e.message!!.contains("hub-token"))
            }
            try {
                EnrollmentClient(plain, http, Release)
                fail("expected the server to be refused")
            } catch (e: EnrollmentError) {
                assertEquals(EnrollmentFailure.Policy, e.kind)
            }
            assertTrue(http.sent.isEmpty())
            assertEquals(0, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a release relay ignores the direct addresses a record carries`() = runBlocking {
        val calls = mutableListOf<String>()
        val http = com.clave.core.ports.HttpPort { request ->
            calls += request.url
            com.clave.core.ports.HttpResponse(
                200,
                """{"machines":[{"id":"mac-1","name":"Mac","platform":"macos","version":"2.4.0","online":true,"lastSeen":null,
                   "direct":[{"url":"http://192.168.1.5:43201"},{"url":"http://100.64.0.2:43127"}]}]}""",
            )
        }
        val machine = RelayMachineSource("https://relay.example", { "t" }, http, Release).list().single()
        assertEquals("https://relay.example/m/mac-1", machine.baseUrl)
        assertEquals("https://relay.example/m/mac-1/push", machine.pushUrl)
        assertEquals(listOf("https://relay.example/machines"), calls)
    }
}
