package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * What the phone sends, against the `writes` samples the contract's command payloads
 * decode: equality of JSON elements, so a field written as `null` where the sample leaves
 * it out fails as surely as a renamed one.
 */
class EncodeTest {
    private val claudeChat = LaunchProfileView(
        id = "claude-chat",
        name = "Claude (chat)",
        family = LauncherFamily.Claude,
        command = listOf("claude"),
        additionalArgs = emptyList(),
        builtIn = true,
        sourceProfileId = "claude",
    )

    @Test fun startWithTheFamilyBooleanTheProfileIdAndItsDefinition() {
        val input = StartSessionInput(
            cwd = "/tmp/scratch",
            options = SpawnOptions(claudeMode = true, launchProfileId = "claude-chat", launchProfile = claudeChat, workspaceId = "ws1"),
        )
        val encoded = Encode.startSession(input)
        assertEquals(Samples.at("writes.start"), encoded)
        assertFalse("windowKey" in encoded)
        assertFalse("codexMode" in encoded.getValue("options").jsonObject)
    }

    @Test fun aMessageKeepsTheIdThePhoneMinted() {
        val input = SessionEvent.UserMessage(text = "hi", clientMessageId = "m-0123456789abcdef")
        val encoded = Encode.writeSession("s1", input)
        assertEquals(Samples.at("writes.userMessage"), encoded)
        val written = encoded.getValue("input").jsonObject
        assertFalse("attachments" in written)
        assertFalse("parent" in written)
    }

    @Test fun aMessageWithAttachmentsAndAParent() {
        val input = SessionEvent.UserMessage(
            text = "see [Image #1]",
            attachments = listOf(
                FileAttachment(id = "a1", label = "Image #1", path = "/tmp/a.png", name = "a.png", mimeType = "image/png", size = 12, delivery = FileDelivery.Image),
                FileAttachment(id = "a3", path = "/tmp/d", name = "d", mimeType = "inode/directory", size = 0, delivery = FileDelivery.Folder, entries = 3),
                SessionAttachment(id = "a2", sessionId = "s2", name = "Other", agent = "claude", cwd = "/x"),
            ),
            parent = "p",
        )
        val expected = Json.parseToJsonElement(
            """{"id":"s1","input":{"type":"user_message","text":"see [Image #1]","parent":"p","attachments":[
              {"id":"a1","label":"Image #1","path":"/tmp/a.png","name":"a.png","mimeType":"image/png","size":12,"delivery":"image"},
              {"id":"a3","path":"/tmp/d","name":"d","mimeType":"inode/directory","size":0,"delivery":"folder","entries":3},
              {"id":"a2","delivery":"session","sessionId":"s2","name":"Other","agent":"claude","cwd":"/x"}]}}""",
        )
        assertEquals(expected, Encode.writeSession("s1", input))
        // The attachments sample of the events list is what the server echoes back: the
        // phone's encoding must decode to the same value.
        val roundTrip = Decode.sessionEvent(Encode.sessionWriteInput(input))
        assertEquals(input, roundTrip)
    }

    @Test fun aPermissionResponseThroughTheWriteRoute() {
        val input = PermissionResponse(id = "r1", optionId = "answer", answers = mapOf("q1" to "A, B"))
        assertEquals(Samples.at("writes.permissionResponse"), Encode.writeSession("s1", input))
        val bare = Encode.sessionWriteInput(PermissionResponse(id = "r1", optionId = "allow-once"))
        assertFalse("answers" in bare)
    }

    @Test fun anInterrupt() {
        assertEquals(Samples.at("writes.interrupt"), Encode.writeSession("s1", Interrupt))
    }

    @Test fun everyRequestResponseTheFormsShape() {
        val responses = listOf(
            RequestResponse.Permission(optionId = "allow-once"),
            RequestResponse.Permission(optionId = "answer", answers = mapOf("q" to "A")),
            RequestResponse.Clarification(answers = mapOf("q" to "A")),
            RequestResponse.Secret(value = "shh"),
            RequestResponse.Dismiss,
        )
        val samples = Samples.list("writes.responses")
        assertEquals(responses.size, samples.size)
        responses.forEachIndexed { i, response ->
            val encoded = Encode.resolveRequest(ResolveRequestInput("req-1", response))
            assertEquals("responses[$i]", JsonObject(mapOf("requestId" to JsonPrimitive("req-1"), "response" to samples[i])), encoded)
        }
    }

    @Test fun theClientFrames() {
        val frames = listOf(
            ClientFrame.Hello(token = "t", client = "clave-mobile/android"),
            ClientFrame.Subscribe("s1"),
            ClientFrame.Unsubscribe("s1"),
            ClientFrame.Ping,
        )
        val samples = Samples.list("writes.clientFrames")
        assertEquals(frames.size, samples.size)
        frames.forEachIndexed { i, frame -> assertEquals("clientFrames[$i]", samples[i], Encode.clientFrame(frame)) }
        assertFalse("client" in Encode.clientFrame(ClientFrame.Hello(token = "t")))
    }

    @Test fun aPairingRequestAndAPushToken() {
        assertEquals(
            Json.parseToJsonElement("""{"idToken":"id","clientId":"clave-mobile","device":{"name":"Pixel","platform":"android","appVersion":"0.1.0"}}"""),
            Encode.pairingRequest("id", "clave-mobile", DeviceDescription("Pixel", DevicePlatform.Android, "0.1.0")),
        )
        assertEquals(
            Json.parseToJsonElement("""{"token":"fcm","platform":"android"}"""),
            Encode.pushToken("fcm", DevicePlatform.Android),
        )
    }

    @Test fun aPiProfileOmitsWhatItDoesNotSet() {
        val profile = LaunchProfileView(
            id = "pi-x",
            name = "Pi",
            family = LauncherFamily.Pi,
            command = listOf("pi"),
            additionalArgs = listOf("--x"),
            pi = PiOptions(thinking = PiThinkingLevel.High),
        )
        assertEquals(
            Json.parseToJsonElement("""{"id":"pi-x","name":"Pi","family":"pi","command":["pi"],"additionalArgs":["--x"],"pi":{"thinking":"high"}}"""),
            Encode.launchProfile(profile),
        )
        assertEquals(profile, Decode.launchProfile(Encode.launchProfile(profile)))
    }

    @Test fun toTextIsCompactJson() {
        assertEquals("""{"_tag":"subscribe","sessionId":"s1"}""", Encode.clientFrame(ClientFrame.Subscribe("s1")).toText())
    }
}
