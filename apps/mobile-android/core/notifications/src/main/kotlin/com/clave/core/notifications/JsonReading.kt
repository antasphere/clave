package com.clave.core.notifications

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A JSON string as a string, as the TypeScript's `typeof value === 'string'`: never a
 *  number or a boolean read as text. */
internal fun JsonElement?.stringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonElement?.objectOrNull(): JsonObject? = this as? JsonObject

internal fun parseJsonOrNull(text: String): JsonElement? =
    try {
        Json.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }
