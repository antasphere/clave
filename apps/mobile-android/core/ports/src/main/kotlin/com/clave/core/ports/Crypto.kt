package com.clave.core.ports

import java.security.MessageDigest
import java.security.SecureRandom

/** Randomness and SHA-256, the two things PKCE and the owner namespace need. */
interface CryptoPort {
    fun randomBytes(n: Int): ByteArray
    fun sha256(data: ByteArray): ByteArray
}

object JvmCrypto : CryptoPort {
    private val random = SecureRandom()
    override fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }
    override fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)
}

/** The sha256 of a text as lowercase hex. */
fun CryptoPort.sha256Hex(text: String): String =
    sha256(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
