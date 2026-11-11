package com.clave.core.auth

import com.clave.core.ports.SecureStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/*
 * What the sign-in keeps on the phone, in the secure store: the client the app
 * registered (its id and its issuer, nothing secret, kept beside the rest for one port
 * rather than two), the person, and the three tokens. Each token sits under its own key
 * so no single value grows past what a keystore-backed store accepts. Nothing here is
 * ever logged. The records are read tolerantly: a value of the wrong shape reads as
 * absent rather than failing the boot.
 */

data class StoredClient(val issuer: String, val clientId: String, val registeredAt: Long)

data class StoredAccount(val subject: String, val name: String?, val email: String?, val emailVerified: Boolean)

data class StoredSession(val issuer: String, val clientId: String, val account: StoredAccount, val signedInAt: Long)

data class StoredToken(
    val token: String,
    /** Epoch milliseconds: the ID token's `exp`, the access token's `expires_in` from its arrival. */
    val expiresAt: Long,
) {
    override fun toString(): String = "StoredToken(expiresAt=$expiresAt)"
}

object StoreKeys {
    const val CLIENT = "clave.hub.client"
    const val SESSION = "clave.hub.session"
    const val REFRESH_TOKEN = "clave.hub.refresh-token"
    const val ACCESS_TOKEN = "clave.hub.access-token"
    const val ID_TOKEN = "clave.hub.id-token"
    val ALL = listOf(CLIENT, SESSION, REFRESH_TOKEN, ACCESS_TOKEN, ID_TOKEN)
}

private fun JsonElement?.numberOrNull(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.doubleOrNull?.takeIf { it.isFinite() }

private fun readClient(value: JsonElement): StoredClient? {
    val obj = value as? JsonObject ?: return null
    val issuer = obj["issuer"].stringOrNull() ?: return null
    val clientId = obj["clientId"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    return StoredClient(issuer, clientId, obj["registeredAt"].numberOrNull()?.toLong() ?: 0)
}

private fun readSession(value: JsonElement): StoredSession? {
    val obj = value as? JsonObject ?: return null
    val account = obj["account"] as? JsonObject ?: return null
    val issuer = obj["issuer"].stringOrNull() ?: return null
    val clientId = obj["clientId"].stringOrNull() ?: return null
    val subject = account["subject"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    return StoredSession(
        issuer = issuer,
        clientId = clientId,
        account = StoredAccount(
            subject = subject,
            name = account["name"].stringOrNull(),
            email = account["email"].stringOrNull(),
            emailVerified = (account["emailVerified"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true,
        ),
        signedInAt = obj["signedInAt"].numberOrNull()?.toLong() ?: 0,
    )
}

private fun readToken(value: JsonElement): StoredToken? {
    val obj = value as? JsonObject ?: return null
    val token = obj["token"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    val expiresAt = obj["expiresAt"].numberOrNull() ?: return null
    return StoredToken(token, expiresAt.toLong())
}

class HubTokenStore(private val secure: SecureStore) {
    private suspend fun <T> readJson(key: String, read: (JsonElement) -> T?): T? {
        val raw = secure.get(key)
        if (raw.isNullOrEmpty()) return null
        return try {
            read(Json.parseToJsonElement(raw))
        } catch (_: Exception) {
            null
        }
    }

    suspend fun readClient(): StoredClient? = readJson(StoreKeys.CLIENT, ::readClient)

    suspend fun writeClient(client: StoredClient) = secure.set(
        StoreKeys.CLIENT,
        buildJsonObject {
            put("issuer", client.issuer)
            put("clientId", client.clientId)
            put("registeredAt", client.registeredAt)
        }.toString(),
    )

    suspend fun clearClient() = secure.remove(StoreKeys.CLIENT)

    suspend fun readSession(): StoredSession? = readJson(StoreKeys.SESSION, ::readSession)

    suspend fun writeSession(session: StoredSession) = secure.set(
        StoreKeys.SESSION,
        buildJsonObject {
            put("issuer", session.issuer)
            put("clientId", session.clientId)
            put(
                "account",
                buildJsonObject {
                    put("subject", session.account.subject)
                    put("name", session.account.name)
                    put("email", session.account.email)
                    put("emailVerified", session.account.emailVerified)
                },
            )
            put("signedInAt", session.signedInAt)
        }.toString(),
    )

    suspend fun readRefreshToken(): String? = secure.get(StoreKeys.REFRESH_TOKEN)?.takeIf { it.isNotEmpty() }

    suspend fun writeRefreshToken(token: String) = secure.set(StoreKeys.REFRESH_TOKEN, token)

    suspend fun readAccessToken(): StoredToken? = readJson(StoreKeys.ACCESS_TOKEN, ::readToken)

    suspend fun writeAccessToken(token: StoredToken) = secure.set(StoreKeys.ACCESS_TOKEN, tokenJson(token))

    suspend fun readIdToken(): StoredToken? = readJson(StoreKeys.ID_TOKEN, ::readToken)

    suspend fun writeIdToken(token: StoredToken) = secure.set(StoreKeys.ID_TOKEN, tokenJson(token))

    /** The person and every token go; the client registration stays. */
    suspend fun clearSession() {
        for (key in listOf(StoreKeys.SESSION, StoreKeys.REFRESH_TOKEN, StoreKeys.ACCESS_TOKEN, StoreKeys.ID_TOKEN)) {
            secure.remove(key)
        }
    }

    private fun tokenJson(token: StoredToken): String = buildJsonObject {
        put("token", token.token)
        put("expiresAt", token.expiresAt)
    }.toString()
}
