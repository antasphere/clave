package com.clave.core.auth

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class JwtTest {
    private fun segment(value: JsonElement): String = base64UrlEncode(value.toString().toByteArray(Charsets.UTF_8))
    private val sig = base64UrlEncode(byteArrayOf(1, 2, 3, 4))

    private val claims: JsonObject = buildJsonObject {
        put("iss", "https://hub.test")
        put("sub", "user-1")
        put("aud", "client-1")
        put("exp", 2_000_000_000)
        put("iat", 1_900_000_000)
        put("nonce", "n-1")
        put("name", "Ada")
        put("email", "ada@example.test")
        put("email_verified", true)
    }
    private val rs256: JsonObject = buildJsonObject {
        put("alg", "RS256")
        put("typ", "JWT")
    }

    private fun with(key: String, value: JsonElement) = JsonObject(claims + (key to value))
    private fun token(header: JsonElement = rs256, payload: JsonElement = claims) = "${segment(header)}.${segment(payload)}.$sig"

    private fun refusal(run: () -> Unit): IdTokenRefusal {
        try {
            run()
        } catch (e: IdTokenRefused) {
            return e.check
        }
        fail("not refused")
        error("unreachable")
    }

    @Test
    fun `reads the claims of a well-formed token without verifying its signature`() {
        assertEquals(
            IdTokenClaims(
                iss = "https://hub.test",
                sub = "user-1",
                aud = listOf("client-1"),
                exp = 2_000_000_000,
                iat = 1_900_000_000,
                nonce = "n-1",
                azp = null,
                name = "Ada",
                email = "ada@example.test",
                emailVerified = true,
            ),
            decodeIdToken(token()),
        )
    }

    @Test
    fun `takes an audience list`() {
        val aud = JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("client-1")))
        assertEquals(listOf("a", "client-1"), decodeIdToken(token(payload = with("aud", aud))).aud)
    }

    @Test
    fun `refuses every malformed token by the name of its check`() {
        val alg = buildJsonObject { put("alg", "RS256") }
        val cases = listOf(
            Triple("two segments", "${segment(alg)}.${segment(claims)}", IdTokenRefusal.Format),
            Triple("an empty signature", "${segment(alg)}.${segment(claims)}.", IdTokenRefusal.Format),
            Triple("a signature outside the alphabet", "${segment(alg)}.${segment(claims)}.a+b/", IdTokenRefusal.Format),
            Triple("a header that is not JSON", "abc.${segment(claims)}.$sig", IdTokenRefusal.Format),
            Triple("a payload with padding", "${segment(alg)}.${segment(claims)}=.$sig", IdTokenRefusal.Format),
            Triple("alg none", token(buildJsonObject { put("alg", "none") }), IdTokenRefusal.Algorithm),
            Triple("alg HS256", token(buildJsonObject { put("alg", "HS256"); put("typ", "JWT") }), IdTokenRefusal.Algorithm),
            Triple("no alg", token(buildJsonObject { put("typ", "JWT") }), IdTokenRefusal.Algorithm),
            Triple("a typ that is not JWT", token(buildJsonObject { put("alg", "RS256"); put("typ", "JWE") }), IdTokenRefusal.Format),
            Triple("no issuer", token(payload = with("iss", JsonPrimitive(""))), IdTokenRefusal.Format),
            Triple("no subject", token(payload = with("sub", JsonPrimitive(""))), IdTokenRefusal.Subject),
            Triple("an empty audience", token(payload = with("aud", JsonArray(emptyList()))), IdTokenRefusal.Format),
            Triple("a non-string audience", token(payload = with("aud", JsonPrimitive(7))), IdTokenRefusal.Format),
            Triple("no expiry", token(payload = with("exp", JsonPrimitive("soon"))), IdTokenRefusal.Format),
            Triple("a quoted iat", token(payload = with("iat", JsonPrimitive("1900000000"))), IdTokenRefusal.Format),
            Triple("a non-boolean email_verified", token(payload = with("email_verified", JsonPrimitive("yes"))), IdTokenRefusal.Format),
            Triple("a non-string nonce", token(payload = with("nonce", JsonPrimitive(1))), IdTokenRefusal.Format),
            Triple("a payload that is an array", token(payload = JsonArray(emptyList())), IdTokenRefusal.Format),
        )
        for ((name, value, check) in cases) assertEquals(name, check, refusal { decodeIdToken(value) })
    }

    private val expected = ExpectedIdToken(issuer = "https://hub.test", clientId = "client-1", nonce = "n-1", nowMs = 1_950_000_000L * 1000)
    private val decoded by lazy { decodeIdToken(token()) }

    @Test
    fun `passes the token the phone asked for`() {
        checkIdToken(decoded, expected)
    }

    @Test
    fun `passes a token from a refresh, which carries no nonce to compare`() {
        checkIdToken(decoded.copy(nonce = null), expected.copy(nonce = null))
    }

    @Test
    fun `refuses by each check`() {
        val cases = listOf(
            IdTokenRefusal.Issuer to expected.copy(issuer = "https://other.test"),
            IdTokenRefusal.Audience to expected.copy(clientId = "client-2"),
            IdTokenRefusal.Nonce to expected.copy(nonce = "n-2"),
            IdTokenRefusal.Expired to expected.copy(nowMs = 2_000_000_100L * 1000),
            IdTokenRefusal.NotYetValid to expected.copy(nowMs = 1_899_999_000L * 1000),
        )
        for ((check, against) in cases) assertEquals(check, refusal { checkIdToken(decoded, against) })
    }

    @Test
    fun `a sign-in token without a nonce is refused, and a refresh token without one is read`() {
        val noNonce = decodeIdToken(token(payload = JsonObject(claims - "nonce")))
        assertEquals(null, noNonce.nonce)
        // The sign-in asked for a nonce: a token that carries none is not the answer to it.
        assertEquals(IdTokenRefusal.Nonce, refusal { checkIdToken(noNonce, expected) })
        // A refresh asks for none, so none is expected.
        checkIdToken(noNonce, expected.copy(nonce = null))
    }

    @Test
    fun `tolerates a minute of clock skew on the lifetime, and not a second more`() {
        checkIdToken(decoded, expected.copy(nowMs = 2_000_000_030L * 1000))
        checkIdToken(decoded, expected.copy(nowMs = 1_899_999_970L * 1000))
        assertEquals(IdTokenRefusal.Expired, refusal { checkIdToken(decoded, expected.copy(nowMs = 2_000_000_060L * 1000)) })
        assertEquals(IdTokenRefusal.NotYetValid, refusal { checkIdToken(decoded, expected.copy(nowMs = 1_899_999_939L * 1000)) })
        assertEquals(CLOCK_SKEW_SEC, 60L)
    }

    @Test
    fun `refuses an authorized party that is not this client`() {
        val withAzp = decodeIdToken(token(payload = with("azp", JsonPrimitive("client-9"))))
        assertEquals(IdTokenRefusal.AuthorizedParty, refusal { checkIdToken(withAzp, expected) })
        checkIdToken(decodeIdToken(token(payload = with("azp", JsonPrimitive("client-1")))), expected)
    }

    @Test
    fun `a refusal never carries the token in its message`() {
        val value = token(buildJsonObject { put("alg", "none") })
        try {
            decodeIdToken(value)
            fail("not refused")
        } catch (e: IdTokenRefused) {
            assertEquals("The ID token was refused by the algorithm check.", e.message)
        }
    }
}
