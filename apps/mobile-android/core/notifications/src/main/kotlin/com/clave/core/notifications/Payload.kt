package com.clave.core.notifications

import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The server's notification payload as the phone reads it (`packages/contract/src/notify.ts`):
 * the category, the machine, the session, the text and the actions the phone may offer.
 * Never a secret, never a token: the server's own test holds every category to that.
 *
 * Where it lands differs by platform, and this reads both. FCM carries every field as a
 * string in its `data` map (the actions joined by commas, `categoryId` beside them); APNs
 * carries it under a top-level `clave` key beside `aps`. A JSON string in either place is
 * read too, at most three levels deep, so a payload wrapped in itself cannot loop.
 */
public const val APNS_KEY: String = "clave"

private const val MAX_DEPTH = 3

/** The payload in a push's data, whichever platform delivered it; null when nothing
 *  readable is there (a push that is not Clave's). */
public fun parsePayload(data: JsonElement?): NotificationPayload? = parse(data, 0)

/** The FCM shape as `RemoteMessage.getData()` hands it: every value a string. */
public fun parsePayload(data: Map<String, String>): NotificationPayload? =
    parse(JsonObject(data.mapValues { JsonPrimitive(it.value) }), 0)

private fun parse(data: JsonElement?, depth: Int): NotificationPayload? {
    if (depth > MAX_DEPTH) return null
    val text = data.stringOrNull()
    if (text != null) return parse(parseJsonOrNull(text) ?: return null, depth + 1)
    val record = data.objectOrNull() ?: return null
    if (record.containsKey(APNS_KEY)) return parse(record[APNS_KEY], depth + 1)
    val category = NotificationCategory.of(record["category"].stringOrNull()) ?: return null
    val serverId = record["serverId"].stringOrNull().orEmpty()
    if (serverId.isEmpty()) return null
    return NotificationPayload(
        category = category,
        serverId = serverId,
        serverName = record["serverName"].stringOrNull().orEmpty(),
        sessionId = record["sessionId"].stringOrNull().orEmpty(),
        sessionTitle = record["sessionTitle"].stringOrNull().orEmpty(),
        workspaceName = record["workspaceName"].stringOrNull()?.takeIf { it.isNotEmpty() },
        requestId = record["requestId"].stringOrNull()?.takeIf { it.isNotEmpty() },
        text = record["text"].stringOrNull().orEmpty(),
        actions = actionsOf(record["actions"]),
    )
}

/** The actions from an array or a comma-joined string; unknown names dropped, duplicates
 *  once, and a plain open when nothing is left. */
private fun actionsOf(value: JsonElement?): List<NotificationAction> {
    val names: List<String?> = when {
        value is JsonArray -> value.map { it.stringOrNull() }
        value.stringOrNull() != null -> value.stringOrNull()!!.split(',').map { it.trim() }
        else -> emptyList()
    }
    val actions = names.mapNotNull { name -> name?.let { NotificationAction.of(it) } }.distinct()
    return actions.ifEmpty { listOf(NotificationAction.Open) }
}
