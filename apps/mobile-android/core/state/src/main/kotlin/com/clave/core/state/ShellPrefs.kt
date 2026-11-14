package com.clave.core.state

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What the phone remembers of one machine's shell, in the owner's own store: the workspace
 * and the chat profile a new chat last started on, the ones Settings set as the defaults
 * (none means "the last used"), and the groups the person folded or opened on the phone, which
 * win over the desktop's fold. Never a secret: ids and booleans only.
 */
public data class ShellPrefs(
    val lastWorkspace: String? = null,
    val lastProfile: String? = null,
    val defaultWorkspace: String? = null,
    val defaultProfile: String? = null,
    /** Group id → folded on the phone. */
    val folds: Map<String, Boolean> = emptyMap(),
) {
    /** The workspace a new chat starts in, before the Mac's own last active one. */
    val preferredWorkspace: String? get() = defaultWorkspace ?: lastWorkspace

    /** The chat profile a new chat starts on, before the Mac's default. */
    val preferredProfile: String? get() = defaultProfile ?: lastProfile
}

/** The key of one machine's shell preferences in the owner's store. */
public fun shellPrefsKey(machineId: String): String = "clave.shell.$machineId"

public fun encodeShellPrefs(prefs: ShellPrefs): String = buildJsonObject {
    prefs.lastWorkspace?.let { put("lastWorkspace", it) }
    prefs.lastProfile?.let { put("lastProfile", it) }
    prefs.defaultWorkspace?.let { put("defaultWorkspace", it) }
    prefs.defaultProfile?.let { put("defaultProfile", it) }
    if (prefs.folds.isNotEmpty()) put("folds", JsonObject(prefs.folds.mapValues { JsonPrimitive(it.value) }))
}.toString()

/** The stored preferences; anything unreadable is read as nothing remembered, never as a failure. */
public fun decodeShellPrefs(text: String?): ShellPrefs {
    if (text.isNullOrEmpty()) return ShellPrefs()
    val o = try {
        Json.parseToJsonElement(text) as? JsonObject
    } catch (_: IllegalArgumentException) {
        null
    } ?: return ShellPrefs()
    fun str(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
    val folds = (o["folds"] as? JsonObject)?.mapNotNull { (k, v: JsonElement) -> (v as? JsonPrimitive)?.booleanOrNull?.let { k to it } }?.toMap()
    return ShellPrefs(str("lastWorkspace"), str("lastProfile"), str("defaultWorkspace"), str("defaultProfile"), folds.orEmpty())
}
