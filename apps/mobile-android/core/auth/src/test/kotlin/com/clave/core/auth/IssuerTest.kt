package com.clave.core.auth

import org.junit.Assert.assertEquals
import org.junit.Test

class IssuerTest {
    @Test
    fun `is the hub when nothing is set`() {
        val hub = IssuerResolution.Ok(IssuerConfig(DEFAULT_ISSUER, insecure = false))
        assertEquals(hub, resolveIssuer(null))
        assertEquals(hub, resolveIssuer("  "))
        assertEquals(hub, resolveIssuer(""))
    }

    @Test
    fun `takes an https origin and the literal loopback over http`() {
        assertEquals(IssuerResolution.Ok(IssuerConfig("https://hub.example", false)), resolveIssuer("https://hub.example/"))
        assertEquals(IssuerResolution.Ok(IssuerConfig("https://hub.example", false)), resolveIssuer("https://HUB.example:443"))
        assertEquals(IssuerResolution.Ok(IssuerConfig("http://127.0.0.1:4321", true)), resolveIssuer("http://127.0.0.1:4321"))
    }

    @Test
    fun `refuses everything else and never falls back to the hub`() {
        val cases = listOf(
            "not a URL" to "nope",
            "not a bare origin" to "https://hub.example/path",
            "not a bare origin" to "https://hub.example/?x=1",
            "not a bare origin" to "https://hub.example/#frag",
            "not a bare origin" to "https://user:pw@hub.example",
            "plain http is only accepted for 127.0.0.1" to "http://localhost:4321",
            "plain http is only accepted for 127.0.0.1" to "http://192.168.1.10:8080",
            "plain http is only accepted for 127.0.0.1" to "ftp://127.0.0.1",
        )
        for ((reason, raw) in cases) {
            assertEquals(raw, IssuerResolution.Refused(reason), resolveIssuer(raw))
        }
    }

    @Test
    fun `the redirect is the Android app's own scheme`() {
        assertEquals("clave-android://oauth/callback", REDIRECT_URI)
        assertEquals("openid profile email offline_access", SCOPE)
    }
}
