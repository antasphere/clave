package com.clave.core.devices

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * The few readings these decoders make of an untyped answer, as the TypeScript does with
 * `typeof`: a JSON string is a string (never the number 1 nor `true` read as text), a
 * number is a finite number, `true` is the literal. The contract module's decoders are
 * another lane's; these bodies are small enough to read here, on purpose, without them.
 */
internal fun JsonElement?.stringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonElement?.numberOrNull(): Double? {
    val p = this as? JsonPrimitive ?: return null
    if (p.isString) return null
    return p.doubleOrNull?.takeIf { it.isFinite() }
}

internal fun JsonElement?.isTrue(): Boolean =
    (this as? JsonPrimitive)?.let { !it.isString && it.content == "true" } == true

internal fun JsonElement?.objectOrNull(): JsonObject? = this as? JsonObject

/** Parses a body; null when it is not JSON. */
internal fun parseJsonOrNull(text: String): JsonElement? =
    try {
        Json.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }
