package com.clave.core.auth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64

class EncodingTest {
    @Test
    fun `encodes as the JDK does, without padding, for every length`() {
        val random = SecureRandom()
        for (length in 0 until 40) {
            val bytes = ByteArray(length).also { random.nextBytes(it) }
            assertEquals(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes), base64UrlEncode(bytes))
            assertArrayEquals(bytes, base64UrlDecode(base64UrlEncode(bytes)))
        }
    }

    @Test
    fun `refuses padding, the standard alphabet and an impossible length`() {
        assertThrows(IllegalArgumentException::class.java) { base64UrlDecode("YQ==") }
        assertThrows(IllegalArgumentException::class.java) { base64UrlDecode("a+b/") }
        assertThrows(IllegalArgumentException::class.java) { base64UrlDecode("abcde") }
        assertThrows(IllegalArgumentException::class.java) { base64UrlDecode("abéd") }
    }

    @Test
    fun `utf8Decode is strict`() {
        val sample = "Ada Éxample · 日本語 · 🚀"
        assertEquals(sample, utf8Decode(sample.toByteArray(Charsets.UTF_8)))
        assertThrows(IllegalArgumentException::class.java) { utf8Decode(byteArrayOf(0xe6.toByte(), 0x97.toByte())) }
        assertThrows(IllegalArgumentException::class.java) { utf8Decode(byteArrayOf(0xff.toByte())) }
    }

    @Test
    fun `asciiBytes takes ASCII and refuses the rest`() {
        assertArrayEquals(byteArrayOf(97, 98, 99, 45, 95), asciiBytes("abc-_"))
        assertThrows(IllegalArgumentException::class.java) { asciiBytes("é") }
    }
}
