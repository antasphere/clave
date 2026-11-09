package com.clave.core.auth

import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.URLEncoder

/*
 * The phone's client of the hub's OAuth surface: discovery, the dynamic registration of
 * the app as an anonymous public native client, the authorization URL, the code
 * exchange and the refresh grant. Every request is pinned to the issuer's origin and
 * waits at most 15 s, the Mac's two bounds. The registration carries `type: native`
 * (the hub's own field) beside `application_type: native` (RFC 7591); one that comes
 * back confidential or without the code grant is refused and nothing is kept. The hub
 * answers 200 where RFC 7591 says 201: both are a registration.
 */

enum class HubFailure { Network, Timeout, InvalidResponse, Registration, InvalidGrant, InvalidClient }

class HubError(val kind: HubFailure, message: String, val status: Int? = null) : Exception(message)

data class HubMetadata(
    val issuer: String,
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val registrationEndpoint: String?,
    val jwksUri: String,
    val userinfoEndpoint: String?,
)

data class TokenResponse(
    val accessToken: String,
    val tokenType: String,
    /** Seconds, when the hub states one. */
    val expiresIn: Long?,
    val idToken: String?,
    val refreshToken: String?,
    val scope: String?,
) {
    /** Never prints a token, should one reach a log by accident. */
    override fun toString(): String = "TokenResponse(tokenType=$tokenType, expiresIn=$expiresIn, idToken=${idToken != null}, refreshToken=${refreshToken != null}, scope=$scope)"
}

const val REQUEST_TIMEOUT_MS: Long = 15_000

class HubClient(
    val issuer: IssuerConfig,
    private val http: HttpPort,
    private val timeoutMs: Long = REQUEST_TIMEOUT_MS,
) {
    private val metadataLock = Mutex()

    @Volatile
    private var metadataCache: HubMetadata? = null

    /**
     * The discovery document, read once; every endpoint must sit on the issuer's origin
     * or the metadata is refused before the browser is sent anywhere.
     */
    suspend fun metadata(): HubMetadata {
        metadataCache?.let { return it }
        return metadataLock.withLock {
            metadataCache ?: readMetadata().also { metadataCache = it }
        }
    }

    private suspend fun readMetadata(): HubMetadata {
        val (status, json) = request("GET", "${issuer.origin}/.well-known/openid-configuration")
        if (status != 200 || json !is JsonObject) {
            throw HubError(HubFailure.InvalidResponse, "The issuer served no discovery document.", status)
        }
        if (json["issuer"].stringOrNull() != issuer.origin) {
            throw HubError(HubFailure.InvalidResponse, "The metadata names another issuer.")
        }
        fun endpoint(key: String, required: Boolean): String? {
            val value = json[key]
            if (value == null) {
                if (required) throw HubError(HubFailure.InvalidResponse, "$key is missing.")
                return null
            }
            val url = value.stringOrNull()
            if (url == null || !onIssuer(url)) throw HubError(HubFailure.InvalidResponse, "$key is off the issuer.")
            return url
        }
        return HubMetadata(
            issuer = issuer.origin,
            authorizationEndpoint = endpoint("authorization_endpoint", true)!!,
            tokenEndpoint = endpoint("token_endpoint", true)!!,
            jwksUri = endpoint("jwks_uri", true)!!,
            registrationEndpoint = endpoint("registration_endpoint", false),
            userinfoEndpoint = endpoint("userinfo_endpoint", false),
        )
    }

    /** Registers the app; answers the client id. */
    suspend fun register(): String {
        val endpoint = metadata().registrationEndpoint
            ?: throw HubError(HubFailure.Registration, "The issuer registers no clients.")
        val body = buildJsonObject {
            put("client_name", CLIENT_NAME)
            put("type", "native")
            put("application_type", "native")
            putJsonArray("redirect_uris") { add(REDIRECT_URI) }
            put("token_endpoint_auth_method", "none")
            putJsonArray("grant_types") { add("authorization_code"); add("refresh_token") }
            putJsonArray("response_types") { add("code") }
            put("scope", SCOPE)
        }.toString()
        val (status, json) = request("POST", endpoint, body, "application/json")
        if (status != 200 && status != 201) {
            throw HubError(HubFailure.Registration, "The issuer refused the registration.", status)
        }
        val clientId = (json as? JsonObject)?.get("client_id").stringOrNull()?.takeIf { it.isNotEmpty() }
            ?: throw HubError(HubFailure.Registration, "The registration answered no client id.", status)
        json as JsonObject
        val authMethod = json["token_endpoint_auth_method"]
        if (json["client_secret"] != null || (authMethod != null && authMethod.stringOrNull() != "none")) {
            throw HubError(HubFailure.Registration, "The issuer registered a confidential client.", status)
        }
        val grants = json["grant_types"] as? JsonArray
        if (grants == null || grants.none { it.stringOrNull() == "authorization_code" }) {
            throw HubError(HubFailure.Registration, "The registration lacks the code grant.", status)
        }
        return clientId
    }

    suspend fun authorizationUrl(clientId: String, codeChallenge: String, state: String, nonce: String): String {
        val base = metadata().authorizationEndpoint
        val query = formEncode(
            linkedMapOf(
                "response_type" to "code",
                "client_id" to clientId,
                "redirect_uri" to REDIRECT_URI,
                "scope" to SCOPE,
                "code_challenge" to codeChallenge,
                "code_challenge_method" to "S256",
                "state" to state,
                "nonce" to nonce,
            ),
        )
        return if ('?' in base) "$base&$query" else "$base?$query"
    }

    suspend fun exchangeCode(clientId: String, code: String, verifier: String): TokenResponse = tokenRequest(
        linkedMapOf(
            "grant_type" to "authorization_code",
            "client_id" to clientId,
            "code" to code,
            "redirect_uri" to REDIRECT_URI,
            "code_verifier" to verifier,
        ),
    )

    suspend fun refresh(clientId: String, refreshToken: String): TokenResponse = tokenRequest(
        linkedMapOf(
            "grant_type" to "refresh_token",
            "client_id" to clientId,
            "refresh_token" to refreshToken,
        ),
    )

    private suspend fun tokenRequest(form: Map<String, String>): TokenResponse {
        val endpoint = metadata().tokenEndpoint
        val (status, json) = request("POST", endpoint, formEncode(form), "application/x-www-form-urlencoded")
        val obj = json as? JsonObject
        if (status !in 200..299) {
            // The error code is matched against known words only; the server's text is never echoed.
            when (obj?.get("error").stringOrNull()) {
                "invalid_grant" -> throw HubError(HubFailure.InvalidGrant, "The issuer refused the grant.", status)
                "invalid_client" -> throw HubError(HubFailure.InvalidClient, "The issuer no longer knows this client.", status)
                else -> throw HubError(HubFailure.InvalidResponse, "The token endpoint answered $status.", status)
            }
        }
        val accessToken = obj?.get("access_token").stringOrNull()?.takeIf { it.isNotEmpty() }
        if (obj == null || accessToken == null) {
            throw HubError(HubFailure.InvalidResponse, "The token endpoint answered no access token.", status)
        }
        fun optional(key: String): String? = obj[key].stringOrNull()?.takeIf { it.isNotEmpty() }
        val expiresIn = (obj["expires_in"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            ?.takeIf { it.isFinite() }?.toLong()
        return TokenResponse(
            accessToken = accessToken,
            tokenType = obj["token_type"].stringOrNull() ?: "Bearer",
            expiresIn = expiresIn,
            idToken = optional("id_token"),
            refreshToken = optional("refresh_token"),
            scope = optional("scope"),
        )
    }

    private fun onIssuer(url: String): Boolean = originOf(url) == issuer.origin

    /** One exchange: refused before it is sent when it would leave the issuer, bounded by [timeoutMs]. */
    private suspend fun request(
        method: String,
        url: String,
        body: String? = null,
        contentType: String? = null,
    ): Pair<Int, JsonElement?> {
        if (!onIssuer(url)) throw HubError(HubFailure.InvalidResponse, "A request would leave the issuer.")
        val headers = buildMap {
            put("Accept", "application/json")
            if (contentType != null) put("Content-Type", contentType)
        }
        val timeoutError = { HubError(HubFailure.Timeout, "The issuer did not answer within ${timeoutMs / 1000.0} s.") }
        val response = try {
            withTimeoutOrNull(timeoutMs) { http.send(HttpRequest(method, url, headers, body, timeoutMs)) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: HttpFailure.Timeout) {
            throw timeoutError()
        } catch (_: Exception) {
            throw HubError(HubFailure.Network, "The issuer could not be reached.")
        } ?: throw timeoutError()
        val json = if (response.body.isEmpty()) null else try {
            Json.parseToJsonElement(response.body)
        } catch (_: Exception) {
            null
        }
        return response.status to json
    }
}

internal fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** application/x-www-form-urlencoded, as URLSearchParams writes it. */
internal fun formEncode(form: Map<String, String>): String =
    form.entries.joinToString("&") { (k, v) -> "${URLEncoder.encode(k, Charsets.UTF_8)}=${URLEncoder.encode(v, Charsets.UTF_8)}" }
