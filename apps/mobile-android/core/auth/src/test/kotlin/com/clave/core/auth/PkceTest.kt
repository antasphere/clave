package com.clave.core.auth

import com.clave.core.ports.CryptoPort
import com.clave.core.ports.JvmCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PkceTest {
    @Test
    fun `the verifier is 32 random bytes as 43 base64url characters`() {
        val verifier = makeVerifier(JvmCrypto)
        assertEquals(43, verifier.length)
        assertTrue(verifier.matches(Regex("^[A-Za-z0-9_-]+$")))
        assertNotEquals(verifier, makeVerifier(JvmCrypto))
    }

    @Test
    fun `a state or a nonce is 16 bytes by default`() {
        assertEquals(22, randomValue(JvmCrypto).length)
        assertEquals(43, randomValue(JvmCrypto, 32).length)
    }

    @Test
    fun `the challenge is RFC 7636's own example`() {
        // RFC 7636, appendix B.
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", JvmCrypto),
        )
    }

    @Test
    fun `the random bytes come from the port`() {
        val fixed = object : CryptoPort {
            override fun randomBytes(n: Int) = ByteArray(n) { 0 }
            override fun sha256(data: ByteArray) = JvmCrypto.sha256(data)
        }
        assertEquals("A".repeat(43), makeVerifier(fixed))
    }
}
