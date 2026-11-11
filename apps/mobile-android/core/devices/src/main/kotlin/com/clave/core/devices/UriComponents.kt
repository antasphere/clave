package com.clave.core.devices

/**
 * JavaScript's `encodeURIComponent` and `decodeURIComponent`, byte for byte: the keys of
 * the secure store, the relay's road and the deep links were all minted by the TypeScript
 * app with those two, so the phone has to produce the same strings. `URLEncoder` would not:
 * it is form encoding (a space is `+`, and `!'()*~` are escaped).
 */
public fun encodeUriComponent(value: String): String {
    val out = StringBuilder(value.length)
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val c = byte.toInt() and 0xff
        val ch = c.toChar()
        if (c < 0x80 && (ch.isLetterOrDigit() || ch in UNRESERVED)) out.append(ch)
        else out.append('%').append(HEX[c shr 4]).append(HEX[c and 0x0f])
    }
    return out.toString()
}

/** The inverse of [encodeUriComponent]; null on a malformed escape or invalid UTF-8, where
 *  JavaScript throws. */
public fun decodeUriComponent(value: String): String? {
    val bytes = java.io.ByteArrayOutputStream(value.length)
    var i = 0
    while (i < value.length) {
        val ch = value[i]
        if (ch == '%') {
            if (i + 2 >= value.length) return null
            val hi = Character.digit(value[i + 1], 16)
            val lo = Character.digit(value[i + 2], 16)
            if (hi < 0 || lo < 0) return null
            bytes.write(hi * 16 + lo)
            i += 3
        } else {
            bytes.write(ch.toString().toByteArray(Charsets.UTF_8))
            i += 1
        }
    }
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
    return try {
        decoder.decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (_: java.nio.charset.CharacterCodingException) {
        null
    }
}

private const val UNRESERVED = "-_.!~*'()"
private val HEX = "0123456789ABCDEF".toCharArray()
