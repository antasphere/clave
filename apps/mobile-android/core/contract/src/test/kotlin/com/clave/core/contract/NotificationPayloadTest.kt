package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The notify samples as each platform delivers them: the payload as an object, the FCM
 *  data map with every field a string, a JSON string, and the APNs wrapper. */
class NotificationPayloadTest {
    private val question = NotificationPayload(
        category = NotificationCategory.Question,
        serverId = "6f1c",
        serverName = "Valentins-MacBook-Pro",
        sessionId = "clave-1",
        sessionTitle = "Fix the build",
        workspaceName = "clave-app",
        requestId = "3a9e",
        text = "Which branch do we ship from?",
        actions = listOf(NotificationAction.Reply, NotificationAction.Open),
    )

    private val permission = NotificationPayload(
        category = NotificationCategory.Permission,
        serverId = "6f1c",
        serverName = "Valentins-MacBook-Pro",
        sessionId = "clave-1",
        sessionTitle = "Fix the build",
        requestId = "3a9e",
        text = "Run npm test?",
        actions = listOf(NotificationAction.Allow, NotificationAction.Deny, NotificationAction.Open),
    )

    @Test fun thePayloadWithItsActionsAsAnArray() {
        assertEquals(question, Decode.notificationPayload(Samples.at("notify.payload")))
    }

    @Test fun theFcmDataMapWithItsActionsCommaJoined() {
        assertEquals(permission, Decode.notificationPayload(Samples.at("notify.fcmData")))
        val map = Samples.obj("notify.fcmData").mapValues { it.value.jsonPrimitive.content }
        assertEquals(permission, Decode.notificationPayload(map))
    }

    @Test fun aJsonStringIsRead() {
        val text = Samples.at("notify.payload").toString()
        assertEquals(question, Decode.notificationPayload(JsonPrimitive(text)))
        assertNull(Decode.notificationPayload(JsonPrimitive("not json")))
    }

    @Test fun theApnsWrapperIsUnwrapped() {
        val apns = JsonObject(mapOf("aps" to Json.parseToJsonElement("""{"category":"clave.question"}"""), "clave" to Samples.at("notify.payload")))
        assertEquals(question, Decode.notificationPayload(apns))
        val wrappedString = JsonObject(mapOf("clave" to JsonPrimitive(Samples.at("notify.fcmData").toString())))
        assertEquals(permission, Decode.notificationPayload(wrappedString))
    }

    @Test fun anUnknownCategoryOrAMissingServerIdIsNotClaves() {
        val sample = Samples.obj("notify.payload")
        assertNull(Decode.notificationPayload(JsonObject(sample + ("category" to JsonPrimitive("marketing")))))
        assertNull(Decode.notificationPayload(JsonObject(sample - "serverId")))
        assertNull(Decode.notificationPayload(JsonObject(sample + ("serverId" to JsonPrimitive("")))))
        assertNull(Decode.notificationPayload(Json.parseToJsonElement("[1]")))
    }

    @Test fun unknownActionsAreDroppedAndNoneLeftMeansOpen() {
        val sample = Samples.obj("notify.payload")
        val odd = Decode.notificationPayload(JsonObject(sample + ("actions" to JsonPrimitive("allow, snooze ,allow"))))
        assertEquals(listOf(NotificationAction.Allow), odd?.actions)
        val none = Decode.notificationPayload(JsonObject(sample + ("actions" to Json.parseToJsonElement("""["snooze"]"""))))
        assertEquals(listOf(NotificationAction.Open), none?.actions)
        val absent = Decode.notificationPayload(JsonObject(sample - "actions"))
        assertEquals(listOf(NotificationAction.Open), absent?.actions)
    }

    @Test fun emptyOptionalsAreAbsent() {
        val sample = Samples.obj("notify.payload")
        val decoded = Decode.notificationPayload(JsonObject(sample + ("workspaceName" to JsonPrimitive("")) - "requestId"))
        assertNull(decoded?.workspaceName)
        assertNull(decoded?.requestId)
    }

    @Test fun theCategoriesAndActionsMatchTheContract() {
        assertEquals(
            Samples.list("notify.categories").map { it.jsonPrimitive.content },
            NotificationCategory.entries.map { it.wire },
        )
        assertEquals(
            Samples.list("notify.actions").map { it.jsonPrimitive.content },
            NotificationAction.entries.map { it.wire },
        )
    }
}
