package com.clave.core.auth

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/*
 * The encodings the sign-in needs: base64url (RFC 4648 section 5, no padding) for the
 * PKCE challenge and the JWT segments, strict UTF-8 for a token's JSON, and ASCII for a
 * verifier. Written by hand, as the TypeScript is, so a decoder that is lenient about
 * padding or the standard alphabet can never let a malformed token through.
 */

private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
private val VALUE_OF = IntArray(128) { -1 }.also { table -> ALPHABET.forEachIndexed { i, c -> table[c.code] = i } }

/** The bytes as base64url, without padding. */
fun base64UrlEncode(bytes: ByteArray): String {
    val out = StringBuilder((bytes.size * 4 + 2) / 3)
    var i = 0
    while (i + 2 < bytes.size) {
        val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8) or (bytes[i + 2].toInt() and 0xff)
        out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
            .append(ALPHABET[n shr 6 and 63]).append(ALPHABET[n and 63])
        i += 3
    }
    if (i < bytes.size) {
        val second = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else 0
        val n = (bytes[i].toInt() and 0xff shl 16) or (second shl 8)
        out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
        if (i + 1 < bytes.size) out.append(ALPHABET[n shr 6 and 63])
    }
    return out.toString()
}

/**
 * The bytes of a base64url text. Throws [IllegalArgumentException] on a character
 * outside the alphabet, on padding, and on a length no byte sequence encodes to.
 */
fun base64UrlDecode(text: String): ByteArray {
    require(text.length % 4 != 1) { "not base64url: an impossible length" }
    val out = java.io.ByteArrayOutputStream(text.length * 3 / 4)
    var buffer = 0
    var bits = 0
    for (char in text) {
        val value = if (char.code < 128) VALUE_OF[char.code] else -1
        require(value >= 0) { "not base64url: a character outside the alphabet" }
        buffer = ((buffer shl 6) or value) and 0xffff
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.write((buffer shr bits) and 0xff)
        }
    }
    return out.toByteArray()
}

/** The text of strict UTF-8 bytes; a malformed or truncated sequence throws. */
fun utf8Decode(bytes: ByteArray): String {
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        decoder.decode(ByteBuffer.wrap(bytes)).toString()
    } catch (e: CharacterCodingException) {
        throw IllegalArgumentException("not utf-8", e)
    }
}

/** The bytes of an ASCII text (a PKCE verifier, a state); any code above 0x7f throws. */
fun asciiBytes(text: String): ByteArray = ByteArray(text.length) { i ->
    val code = text[i].code
    require(code <= 0x7f) { "not ascii" }
    code.toByte()
}
