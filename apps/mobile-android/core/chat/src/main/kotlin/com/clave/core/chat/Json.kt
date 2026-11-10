package com.clave.core.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/* The few JavaScript readings of an untyped payload the ported files rely on, kept in
   one place so every port reads a payload the same way the TypeScript did. */

/** `record(value)`: the object, or an empty one for anything else. */
internal fun record(value: JsonElement?): JsonObject = value as? JsonObject ?: JsonObject(emptyMap())

/** The text of a JSON string, or null for anything else (`typeof value === 'string'`). */
internal fun stringOf(value: JsonElement?): String? =
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `text(value)`: the string, or '' for anything else. */
internal fun textOf(value: JsonElement?): String = stringOf(value) ?: ""

/** A finite JSON number, or null (`typeof value === 'number' && Number.isFinite(value)`). */
internal fun numberOf(value: JsonElement?): Double? {
    val p = value as? JsonPrimitive ?: return null
    if (p.isString || p is JsonNull || p.booleanOrNull != null) return null
    return p.doubleOrNull?.takeIf { it.isFinite() }
}

/** A number the way JavaScript prints it: `10`, not `10.0`. */
internal fun jsNumber(value: Double): String =
    if (value == Math.floor(value) && Math.abs(value) < 1e21) value.toLong().toString() else value.toString()

/** The array when every item is a string, or null. */
internal fun stringsOf(value: JsonElement?): List<String>? {
    val array = value as? JsonArray ?: return null
    return array.map { stringOf(it) ?: return null }
}
