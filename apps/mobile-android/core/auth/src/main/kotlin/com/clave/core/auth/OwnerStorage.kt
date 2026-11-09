package com.clave.core.auth

import com.clave.core.ports.CryptoPort
import com.clave.core.ports.sha256Hex
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * The owner namespace that keeps one account's records apart from the next one's. The
 * stores that apply it are `NamespacedKeyValueStore` and `NamespacedSecureStore` in
 * :core:ports. The hashed text is byte for byte the TypeScript's
 * `JSON.stringify([issuer, subject === null ? null : { subject }])`, so a phone that
 * moves from the prototype to this app finds the same namespace.
 */
fun ownerNamespace(issuer: String, subject: String?, crypto: CryptoPort): String {
    val owner = if (subject == null) JsonNull else buildJsonObject { put("subject", subject) }
    val text = JsonArray(listOf(JsonPrimitive(issuer), owner)).toString()
    return "clave.owner.${crypto.sha256Hex(text)}"
}
