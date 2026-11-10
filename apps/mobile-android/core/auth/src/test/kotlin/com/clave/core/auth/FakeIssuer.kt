package com.clave.core.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

/**
 * A local OpenID Connect provider on 127.0.0.1, the Kotlin twin of
 * tests/e2e/fixtures/oidc-provider.mjs: discovery, dynamic registration, an
 * authorization endpoint that approves on sight, the token endpoint (PKCE S256 and the
 * redirect checked; refresh tokens rotated), the JWKS and userinfo. ID tokens are
 * RS256-signed with a real key pair. It reads the time from the test's clock, so a
 * token issued "now" lapses when the test moves the clock. Nothing here ever reaches
 * account.antasphere.com.
 *
 * It uses java.util.Base64, not the module's own encoder, so the two check each other.
 */
class FakeIssuer(private val clock: () -> Long) : AutoCloseable {
    /** Turns the NEXT token response into a wrong one; cleared after use. */
    data class Tamper(
        val iss: String? = null,
        val sub: String? = null,
        val aud: String? = null,
        val azp: String? = null,
        val exp: Long? = null,
        val iat: Long? = null,
        val nonce: String? = null,
        /** Leave the nonce claim out of an ID token the request asked one for. */
        val omitNonce: Boolean = false,
        val alg: String? = null,
        /** Sign with another key than the one the JWKS publishes. */
        val otherKey: Boolean = false,
        val omitRefresh: Boolean = false,
    )

    data class User(val sub: String, val name: String, val email: String, val emailVerified: Boolean)

    data class Registration(val sent: JsonObject, val registered: JsonObject) {
        val clientId: String get() = registered["client_id"].stringOrNull()!!
    }

    private data class IssuedCode(
        val clientId: String,
        val redirectUri: String,
        val codeChallenge: String,
        val nonce: String?,
        val scope: String,
        var used: Boolean = false,
    )

    private data class IssuedRefresh(val sub: String, val clientId: String, val scope: String)

    data class LoggedRequest(val method: String, val path: String, val body: String)

    @Volatile var user = User("user-7f3a", "Ada Example", "ada@example.test", true)
    @Volatile var issueRefresh = true
    @Volatile var idTokenTtlSec = 3600L
    @Volatile var accessTokenTtlSec = 3600L
    /** The hub answers 200; RFC 7591 providers answer 201. */
    @Volatile var registrationStatus = 201
    @Volatile var tamper: Tamper? = null
    @Volatile var denyNext = false
    @Volatile var confidentialNext = false
    /** Refuse the next registration with this status, once. */
    @Volatile var refuseRegistrationOnce: Int? = null
    /** Which grant types the registration echoes back (null: as asked). */
    @Volatile var grantTypesOverride: List<String>? = null
    /** Answer a token endpoint on another origin, for the pinning test. */
    @Volatile var foreignTokenEndpoint: String? = null
    /** Refresh grants answer with neither an ID token nor `expires_in`. */
    @Volatile var bareRefresh = false
    /** Hold the token endpoint's answer this long, for the races and the timeout. */
    @Volatile var tokenDelayMs = 0L

    val log: MutableList<LoggedRequest> = java.util.Collections.synchronizedList(mutableListOf())
    val registrations: MutableList<Registration> = java.util.Collections.synchronizedList(mutableListOf())
    private val codes = java.util.concurrent.ConcurrentHashMap<String, IssuedCode>()
    private val refreshTokens = java.util.concurrent.ConcurrentHashMap<String, IssuedRefresh>()
    private val accessTokens = java.util.concurrent.ConcurrentHashMap<String, String>()

    val discoveryCount = AtomicInteger()
    val registerCount = AtomicInteger()
    val authorizeCount = AtomicInteger()
    val tokenCount = AtomicInteger()
    val refreshCount = AtomicInteger()
    val jwksCount = AtomicInteger()
    val userinfoCount = AtomicInteger()

    private val random = SecureRandom()
    private val signingKey: KeyPair = rsaKeyPair()
    private val otherKey: KeyPair = rsaKeyPair()
    private val server = MockWebServer()
    private var closed = false

    val issuer: String

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        issuer = "http://127.0.0.1:${server.port}"
    }

    /** The hub forgets every refresh token: the next refresh is `invalid_grant`. */
    fun revokeRefreshTokens() = refreshTokens.clear()

    /** The hub purges every client: the next token request is `invalid_client`. */
    fun purgeClients() = registrations.clear()

    /** The token requests seen, as their decoded forms. */
    fun tokenForms(): List<Map<String, String>> =
        synchronized(log) { log.filter { it.path == "/token" }.map { parseForm(it.body) } }

    /**
     * Plays the person's browser: GETs the authorization URL without following the
     * redirect, and answers the Location it was sent to (what the Custom Tab hands back).
     */
    fun browse(authorizationUrl: String): String {
        val connection = URL(authorizationUrl).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            val status = connection.responseCode
            check(status == 302) { "authorize answered $status" }
            return connection.getHeaderField("Location")
        } finally {
            connection.disconnect()
        }
    }

    override fun close() {
        synchronized(this) {
            if (closed) return
            closed = true
        }
        server.shutdown()
    }

    private fun handle(request: RecordedRequest): MockResponse {
        val url = request.requestUrl!!
        val path = url.encodedPath
        val body = request.body.readUtf8()
        log.add(LoggedRequest(request.method ?: "", path, body))
        return when {
            path == "/.well-known/openid-configuration" -> discovery()
            path == "/jwks" -> {
                jwksCount.incrementAndGet()
                json(200, jwks())
            }
            path == "/register" && request.method == "POST" -> register(body)
            path == "/authorize" && request.method == "GET" -> authorize { url.queryParameter(it) }
            path == "/token" && request.method == "POST" -> token(parseForm(body))
            path == "/userinfo" -> userinfo(request.getHeader("Authorization"))
            else -> json(404, buildJsonObject { put("error", "not_found") })
        }
    }

    private fun discovery(): MockResponse {
        discoveryCount.incrementAndGet()
        return json(
            200,
            buildJsonObject {
                put("issuer", issuer)
                put("authorization_endpoint", "$issuer/authorize")
                put("token_endpoint", foreignTokenEndpoint ?: "$issuer/token")
                put("jwks_uri", "$issuer/jwks")
                put("registration_endpoint", "$issuer/register")
                put("userinfo_endpoint", "$issuer/userinfo")
                putJsonArray("response_types_supported") { add(JsonPrimitive("code")) }
                putJsonArray("code_challenge_methods_supported") { add(JsonPrimitive("S256")) }
                putJsonArray("id_token_signing_alg_values_supported") { add(JsonPrimitive("RS256")) }
                put("authorization_response_iss_parameter_supported", true)
            },
        )
    }

    private fun register(body: String): MockResponse {
        registerCount.incrementAndGet()
        refuseRegistrationOnce?.let { status ->
            refuseRegistrationOnce = null
            return json(status, buildJsonObject { put("error", "invalid_client_metadata") })
        }
        val metadata = try {
            Json.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            return json(400, buildJsonObject { put("error", "invalid_client_metadata") })
        }
        val clientId = "dcr-${hex(6)}"
        val confidential = confidentialNext
        confidentialNext = false
        val registered = buildJsonObject {
            put("client_id", clientId)
            put("client_id_issued_at", clock() / 1000)
            metadata["redirect_uris"]?.let { put("redirect_uris", it) }
            put(
                "token_endpoint_auth_method",
                if (confidential) JsonPrimitive("client_secret_post")
                else metadata["token_endpoint_auth_method"] ?: JsonPrimitive("client_secret_basic"),
            )
            put(
                "grant_types",
                grantTypesOverride?.let { list -> JsonArray(list.map { JsonPrimitive(it) }) }
                    ?: metadata["grant_types"] ?: JsonArray(listOf(JsonPrimitive("authorization_code"))),
            )
            put("response_types", metadata["response_types"] ?: JsonArray(listOf(JsonPrimitive("code"))))
            metadata["client_name"]?.let { put("client_name", it) }
            metadata["application_type"]?.let { put("application_type", it) }
            put("scope", "openid profile email offline_access account:read account:write")
            if (confidential) {
                put("client_secret", "not-for-a-native-client")
                put("client_secret_expires_at", 0)
            }
        }
        registrations.add(Registration(metadata, registered))
        return json(registrationStatus, registered)
    }

    private fun clientOf(clientId: String?): Registration? =
        synchronized(registrations) { registrations.firstOrNull { it.clientId == clientId } }

    private fun authorize(query: (String) -> String?): MockResponse {
        authorizeCount.incrementAndGet()
        val clientId = query("client_id")
        val redirect = query("redirect_uri")
        val client = clientOf(clientId)
        val allowed = (client?.registered?.get("redirect_uris") as? JsonArray)?.map { it.stringOrNull() } ?: emptyList()
        if (client == null || redirect == null || redirect !in allowed) {
            return json(400, buildJsonObject { put("error", "invalid_request") })
        }
        val back = linkedMapOf<String, String>()
        query("state")?.let { back["state"] = it }
        back["iss"] = issuer
        val challenge = query("code_challenge")
        if (query("response_type") != "code" || query("code_challenge_method") != "S256" || challenge.isNullOrEmpty()) {
            back["error"] = "invalid_request"
        } else if (denyNext) {
            denyNext = false
            back["error"] = "access_denied"
        } else {
            val code = "code-${hex(8)}"
            codes[code] = IssuedCode(clientId!!, redirect, challenge, query("nonce"), query("scope") ?: "")
            back["code"] = code
        }
        val location = redirect + (if ('?' in redirect) "&" else "?") +
            back.entries.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, Charsets.UTF_8.name())}" }
        return MockResponse().setResponseCode(302).addHeader("Location", location)
    }

    private fun token(form: Map<String, String>): MockResponse {
        tokenCount.incrementAndGet()
        if (tokenDelayMs > 0) Thread.sleep(tokenDelayMs)
        val grant = form["grant_type"]
        val clientId = form["client_id"]
        clientOf(clientId) ?: return json(401, buildJsonObject { put("error", "invalid_client") })
        val sub: String
        val scope: String
        val nonce: String?
        when (grant) {
            "authorization_code" -> {
                val issued = codes[form["code"]]
                if (issued == null || issued.used || issued.clientId != clientId) return grantError()
                if (issued.redirectUri != form["redirect_uri"]) return grantError()
                val verifier = form["code_verifier"] ?: ""
                val challenge = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
                if (challenge != issued.codeChallenge) return grantError()
                issued.used = true
                sub = user.sub
                scope = issued.scope
                nonce = issued.nonce
            }
            "refresh_token" -> {
                refreshCount.incrementAndGet()
                // Rotation with no grace: the presented token is retired as it is used.
                val issued = refreshTokens.remove(form["refresh_token"] ?: "")
                if (issued == null || issued.clientId != clientId) return grantError()
                sub = issued.sub
                scope = issued.scope
                nonce = null
            }
            else -> return json(400, buildJsonObject { put("error", "unsupported_grant_type") })
        }
        val now = clock() / 1000
        val t = tamper
        tamper = null
        val claims = buildJsonObject {
            put("iss", t?.iss ?: issuer)
            put("sub", t?.sub ?: sub)
            put("aud", t?.aud ?: clientId)
            t?.azp?.let { put("azp", it) }
            put("exp", t?.exp ?: (now + idTokenTtlSec))
            put("iat", t?.iat ?: now)
            if (nonce != null && t?.omitNonce != true) put("nonce", t?.nonce ?: nonce)
            put("name", user.name)
            put("email", user.email)
            put("email_verified", user.emailVerified)
        }
        val idToken = signJwt(if (t?.otherKey == true) otherKey else signingKey, claims, t?.alg ?: "RS256")
        val accessToken = "at-${hex(12)}"
        accessTokens[accessToken] = claims["sub"].stringOrNull()!!
        val bare = grant == "refresh_token" && bareRefresh
        val response = buildJsonObject {
            put("access_token", accessToken)
            put("token_type", "Bearer")
            put("scope", scope)
            if (!bare) {
                put("expires_in", accessTokenTtlSec)
                put("id_token", idToken)
            }
            if (issueRefresh && "offline_access" in scope.split(' ') && t?.omitRefresh != true) {
                val refresh = "rt-${hex(12)}"
                refreshTokens[refresh] = IssuedRefresh(claims["sub"].stringOrNull()!!, clientId!!, scope)
                put("refresh_token", refresh)
            }
        }
        return json(200, response).addHeader("Cache-Control", "no-store")
    }

    private fun userinfo(authorization: String?): MockResponse {
        userinfoCount.incrementAndGet()
        val sub = authorization?.removePrefix("Bearer ")?.trim()?.let { accessTokens[it] }
            ?: return json(401, buildJsonObject { put("error", "invalid_token") })
        return json(
            200,
            buildJsonObject {
                put("sub", sub)
                put("name", user.name)
                put("email", user.email)
                put("email_verified", user.emailVerified)
            },
        )
    }

    private fun grantError() = json(400, buildJsonObject { put("error", "invalid_grant") })

    private fun jwks(): JsonObject {
        val key = signingKey.public as RSAPublicKey
        return buildJsonObject {
            putJsonArray("keys") {
                add(
                    buildJsonObject {
                        put("kty", "RSA")
                        put("kid", SIGNING_KID)
                        put("alg", "RS256")
                        put("use", "sig")
                        put("n", b64(unsigned(key.modulus)))
                        put("e", b64(unsigned(key.publicExponent)))
                    },
                )
            }
        }
    }

    /** A compact JWS, RS256: RSASSA-PKCS1-v1_5 over SHA-256, whatever `alg` the header claims. */
    private fun signJwt(key: KeyPair, payload: JsonObject, alg: String): String {
        val header = b64(
            buildJsonObject {
                put("alg", alg)
                put("typ", "JWT")
                put("kid", SIGNING_KID)
            }.toString().toByteArray(Charsets.UTF_8),
        )
        val body = b64(payload.toString().toByteArray(Charsets.UTF_8))
        val signer = Signature.getInstance("SHA256withRSA")
        signer.initSign(key.private)
        signer.update("$header.$body".toByteArray(Charsets.US_ASCII))
        return "$header.$body.${b64(signer.sign())}"
    }

    private fun hex(bytes: Int): String = ByteArray(bytes).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

    private fun json(status: Int, body: JsonElement): MockResponse =
        MockResponse().setResponseCode(status).addHeader("Content-Type", "application/json").setBody(body.toString())

    private companion object {
        const val SIGNING_KID = "clave-test-signing"

        fun rsaKeyPair(): KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

        fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

        fun unsigned(value: BigInteger): ByteArray = value.toByteArray().let { if (it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }

        fun parseForm(body: String): Map<String, String> = body.split('&').filter { it.isNotEmpty() }.associate { part ->
            val eq = part.indexOf('=')
            val name = if (eq < 0) part else part.substring(0, eq)
            val value = if (eq < 0) "" else part.substring(eq + 1)
            URLDecoder.decode(name, Charsets.UTF_8.name()) to URLDecoder.decode(value, Charsets.UTF_8.name())
        }
    }
}
