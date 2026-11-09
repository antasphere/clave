package com.clave.core.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/*
 * The ID token's claims, read on the phone: the decode and the shape checks, nothing
 * more. The phone does not verify the signature: the server does, against the hub's
 * keys, when the token is presented to pair. What the phone checks is that the token it
 * was handed is the one it asked for. A token failing a check is refused by the name of
 * the check, never with the token in the message; the names are the server's own words.
 */

data class IdTokenClaims(
    val iss: String,
    val sub: String,
    val aud: List<String>,
    /** Epoch seconds. */
    val exp: Long,
    /** Epoch seconds. */
    val iat: Long,
    val nonce: String? = null,
    val azp: String? = null,
    val name: String? = null,
    val email: String? = null,
    val emailVerified: Boolean? = null,
)

enum class IdTokenRefusal(val wire: String) {
    Format("format"),
    Algorithm("algorithm"),
    Issuer("issuer"),
    Audience("audience"),
    AuthorizedParty("authorized-party"),
    Expired("expired"),
    NotYetValid("not-yet-valid"),
    Nonce("nonce"),
    Subject("subject"),
}

class IdTokenRefused(val check: IdTokenRefusal) : Exception("The ID token was refused by the ${check.wire} check.")

/** The clock skew the lifetime checks tolerate, the server's own figure. */
const val CLOCK_SKEW_SEC: Long = 60

private fun refuse(check: IdTokenRefusal): Nothing = throw IdTokenRefused(check)

private fun segmentJson(segment: String): JsonObject {
    if (segment.isEmpty()) refuse(IdTokenRefusal.Format)
    val parsed = try {
        Json.parseToJsonElement(utf8Decode(base64UrlDecode(segment)))
    } catch (_: Exception) {
        refuse(IdTokenRefusal.Format)
    }
    return parsed as? JsonObject ?: refuse(IdTokenRefusal.Format)
}



/** A JSON number (not a quoted one), finite. */
private fun JsonElement?.numberOrNull(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.doubleOrNull?.takeIf { it.isFinite() }

private fun optionalString(value: JsonElement?): String? {
    if (value == null) return null
    return value.stringOrNull() ?: refuse(IdTokenRefusal.Format)
}

/** The claims of a compact JWS, by shape alone; throws [IdTokenRefused]. */
fun decodeIdToken(token: String): IdTokenClaims {
    val parts = token.split('.')
    if (parts.size != 3) refuse(IdTokenRefusal.Format)
    val (headerPart, payloadPart, signaturePart) = parts
    if (signaturePart.isEmpty()) refuse(IdTokenRefusal.Format)
    try {
        base64UrlDecode(signaturePart)
    } catch (_: IllegalArgumentException) {
        refuse(IdTokenRefusal.Format)
    }
    val header = segmentJson(headerPart)
    val typ = header["typ"]
    if (typ != null && typ.stringOrNull() != "JWT") refuse(IdTokenRefusal.Format)
    if (header["alg"].stringOrNull() != "RS256") refuse(IdTokenRefusal.Algorithm)
    val payload = segmentJson(payloadPart)
    val iss = payload["iss"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: refuse(IdTokenRefusal.Format)
    val sub = payload["sub"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: refuse(IdTokenRefusal.Subject)
    val aud = when (val raw = payload["aud"]) {
        is JsonArray -> raw.map { it.stringOrNull() ?: refuse(IdTokenRefusal.Format) }
        else -> listOf(raw.stringOrNull() ?: refuse(IdTokenRefusal.Format))
    }
    if (aud.isEmpty()) refuse(IdTokenRefusal.Format)
    val exp = payload["exp"].numberOrNull() ?: refuse(IdTokenRefusal.Format)
    val iat = payload["iat"].numberOrNull() ?: refuse(IdTokenRefusal.Format)
    val emailVerified = payload["email_verified"]?.let { value ->
        (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: refuse(IdTokenRefusal.Format)
    }
    return IdTokenClaims(
        iss = iss,
        sub = sub,
        aud = aud,
        exp = exp.toLong(),
        iat = iat.toLong(),
        nonce = optionalString(payload["nonce"]),
        azp = optionalString(payload["azp"]),
        name = optionalString(payload["name"]),
        email = optionalString(payload["email"]),
        emailVerified = emailVerified,
    )
}

data class ExpectedIdToken(
    val issuer: String,
    val clientId: String,
    /** The nonce the request carried; a token from a refresh carries none. */
    val nonce: String? = null,
    /** Epoch milliseconds. */
    val nowMs: Long,
    val skewSec: Long = CLOCK_SKEW_SEC,
)

/** The claims against what the phone asked for; throws [IdTokenRefused]. */
fun checkIdToken(claims: IdTokenClaims, expected: ExpectedIdToken) {
    val nowSec = expected.nowMs / 1000.0
    if (claims.iss != expected.issuer) refuse(IdTokenRefusal.Issuer)
    if (expected.clientId !in claims.aud) refuse(IdTokenRefusal.Audience)
    if (claims.azp != null && claims.azp != expected.clientId) refuse(IdTokenRefusal.AuthorizedParty)
    if (claims.exp + expected.skewSec <= nowSec) refuse(IdTokenRefusal.Expired)
    if (claims.iat - expected.skewSec > nowSec) refuse(IdTokenRefusal.NotYetValid)
    if (expected.nonce != null && claims.nonce != expected.nonce) refuse(IdTokenRefusal.Nonce)
}
