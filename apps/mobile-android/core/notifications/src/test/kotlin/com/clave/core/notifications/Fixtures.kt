package com.clave.core.notifications

import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The server's permission payload, as `packages/server/src/notify/payload.ts` builds it. */
val permission = NotificationPayload(
    category = NotificationCategory.Permission,
    serverId = "srv-1",
    serverName = "Valentin’s Mac",
    sessionId = "s-1",
    sessionTitle = "Fix the flaky test",
    workspaceName = "clave",
    requestId = "r-1",
    text = "Run npm test in /Users/v/clave?",
    actions = listOf(NotificationAction.Allow, NotificationAction.Deny, NotificationAction.Open),
)

val question = permission.copy(
    category = NotificationCategory.Question,
    requestId = "r-2",
    text = "Which branch should the fix land on?",
    actions = listOf(NotificationAction.Reply, NotificationAction.Open),
)

/** The payload's fields as JSON, the actions an array, an absent field left out. */
fun payloadJson(payload: NotificationPayload, actions: JsonElement? = null): JsonObject = buildJsonObject {
    put("category", payload.category.wire)
    put("serverId", payload.serverId)
    put("serverName", payload.serverName)
    put("sessionId", payload.sessionId)
    put("sessionTitle", payload.sessionTitle)
    payload.workspaceName?.let { put("workspaceName", it) }
    payload.requestId?.let { put("requestId", it) }
    put("text", payload.text)
    put("actions", actions ?: JsonArray(payload.actions.map { JsonPrimitive(it.wire) }))
}

/** What APNs hands an app: `clave` beside `aps`. */
fun iosData(payload: NotificationPayload): JsonObject = buildJsonObject {
    put("aps", buildJsonObject { put("category", "clave.${payload.category.wire}") })
    put("clave", payloadJson(payload))
}

/** What FCM hands the app: the data map, every field a string, the actions joined by commas. */
fun androidData(payload: NotificationPayload): Map<String, String> = buildMap {
    put("categoryId", "clave.${payload.category.wire}")
    put("category", payload.category.wire)
    put("serverId", payload.serverId)
    put("serverName", payload.serverName)
    put("sessionId", payload.sessionId)
    put("sessionTitle", payload.sessionTitle)
    payload.workspaceName?.let { put("workspaceName", it) }
    payload.requestId?.let { put("requestId", it) }
    put("text", payload.text)
    put("actions", payload.actions.joinToString(",") { it.wire })
}

fun androidJson(payload: NotificationPayload): JsonObject = JsonObject(androidData(payload).mapValues { JsonPrimitive(it.value) })

fun response(data: JsonElement?, action: String = DEFAULT_ACTION_IDENTIFIER, userText: String? = null) =
    IncomingResponse(notificationId = "n-1", date = 1, actionIdentifier = action, data = data, userText = userText)
