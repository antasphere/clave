package com.clave.core.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** A JSON payload written as the TypeScript tests write their object literals. */
internal fun j(text: String): JsonElement = Json.parseToJsonElement(text)
