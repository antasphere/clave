package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/** The contract's pin vectors (src/test/resources/samples.json), read once per test run. */
object Samples {
    val root: JsonObject by lazy {
        val text = requireNotNull(Samples::class.java.getResourceAsStream("/samples.json")) { "samples.json is not on the test classpath" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }

    /** A sample by its dotted path, `timeline.page` for instance. */
    fun at(path: String): JsonElement = path.split('.').fold(root as JsonElement) { node, key ->
        requireNotNull(node.jsonObject[key]) { "samples.json has no $path" }
    }

    fun obj(path: String): JsonObject = at(path).jsonObject

    fun list(path: String): JsonArray = at(path).jsonArray
}
