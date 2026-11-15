package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A newer server says things this phone has not learned yet. One event of a type it does not
 * know, or of a known type in a shape it cannot read, must never cost the person a whole page
 * of history or a positioned live frame: it is carried as [SessionEvent.Unknown], position and
 * all, and the readers skip it. The events the desktop added since the port (the permission's
 * reading, a hosted form's updates) are read in their contract shapes
 * (packages/contract/src/sessions.ts and its sessions.test.ts samples).
 */
class EventRobustnessTest {
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test fun anUnknownTypeIsCarriedByItsType() {
        assertEquals(SessionEvent.Unknown("brand_new"), Decode.sessionEvent(json("""{"type":"brand_new","x":1}""")))
    }

    @Test fun aTimelinePageWithAnUnknownEventStillDecodesEveryOtherItem() {
        val page = Decode.timelinePage(
            json(
                """{"items":[
                  {"event":{"type":"user_message","text":"hi"},"position":{"generation":"g","sequence":1}},
                  {"event":{"type":"from_the_future","whatever":[1]},"position":{"generation":"g","sequence":2}},
                  {"event":{"type":"assistant_text","delta":"yes","final":true},"position":{"generation":"g","sequence":3}}
                ],"before":null,"cursor":{"generation":"g","sequence":3},"truncated":false}""",
            ),
        )
        assertEquals(3, page.items.size)
        assertEquals(SessionEvent.UserMessage(text = "hi"), page.items[0].event)
        assertEquals(SessionEvent.Unknown("from_the_future"), page.items[1].event)
        assertEquals(SessionPosition("g", 2), page.items[1].position)
        assertEquals(SessionEvent.AssistantText("yes", true), page.items[2].event)
    }

    @Test fun aKnownTypeInAShapeThisPhoneCannotReadDoesNotFailThePage() {
        val page = Decode.historyPage(
            json(
                """{"items":[
                  {"event":{"type":"context_usage","used":"lots"}},
                  {"event":{"type":"user_message","text":"still here"}}
                ],"before":null}""",
            ),
        )
        assertEquals(SessionEvent.Unknown("context_usage"), page.items[0].event)
        assertEquals(SessionEvent.UserMessage(text = "still here"), page.items[1].event)
    }

    @Test fun anItemThatIsNoEventAtAllIsStillRefused() {
        try {
            Decode.historyPage(json("""{"items":[{"event":{"text":"no type"}}],"before":null}"""))
            fail("an event without a type is no event")
        } catch (_: DecodeError) {
        }
    }

    @Test fun aLiveFrameWithAnUnknownEventKeepsItsPosition() {
        val frame = parseServerFrame(
            """{"_tag":"stream","sessionId":"s1","stream":{"kind":"event","event":{"type":"later_thing"},"position":{"generation":"g","sequence":9}}}""",
        )
        assertEquals(
            ServerFrame.Stream("s1", SessionStream.Event(SessionEvent.Unknown("later_thing"), SessionPosition("g", 9))),
            frame,
        )
        val malformed = parseServerFrame(
            """{"_tag":"stream","sessionId":"s1","stream":{"kind":"event","event":{"type":"assistant_text","delta":3},"position":{"generation":"g","sequence":10}}}""",
        )
        assertTrue(malformed is ServerFrame.Stream)
        assertEquals(SessionEvent.Unknown("assistant_text"), ((malformed as ServerFrame.Stream).stream as SessionStream.Event).event)
    }

    // ── the events the desktop added: the contract's own samples ──

    @Test fun permissionExplainedInEveryShapeTheContractAccepts() {
        assertEquals(
            SessionEvent.PermissionExplained("p", level = RiskLevel.Reads),
            Decode.sessionEvent(json("""{"type":"permission_explained","id":"p","level":"reads"}""")),
        )
        assertEquals(
            SessionEvent.PermissionExplained("p", sentence = "Runs the tests.", asked = AskedMatch.Yes),
            Decode.sessionEvent(json("""{"type":"permission_explained","id":"p","sentence":"Runs the tests.","asked":"yes"}""")),
        )
        assertEquals(
            SessionEvent.PermissionExplained("p", level = RiskLevel.Irreversible, sentence = "Deletes the branch.", asked = AskedMatch.No),
            Decode.sessionEvent(
                json("""{"type":"permission_explained","id":"p","level":"irreversible","sentence":"Deletes the branch.","asked":"no"}"""),
            ),
        )
        assertEquals(
            SessionEvent.PermissionExplained("p", level = RiskLevel.Outside, failed = "timeout"),
            Decode.sessionEvent(json("""{"type":"permission_explained","id":"p","level":"outside","failed":"timeout"}""")),
        )
    }

    @Test fun permissionUpdatedKeepsStringsAndListsApart() {
        assertEquals(
            SessionEvent.PermissionUpdated(
                "p",
                linkedMapOf("login" to FormAnswer.Text("luca-a"), "projects" to FormAnswer.Choices(listOf("reb"))),
            ),
            Decode.sessionEvent(json("""{"type":"permission_updated","id":"p","answers":{"login":"luca-a","projects":["reb"]}}""")),
        )
        assertEquals(
            SessionEvent.PermissionUpdated("p", mapOf("login" to FormAnswer.Text("luca-a")), sent = true),
            Decode.sessionEvent(json("""{"type":"permission_updated","id":"p","answers":{"login":"luca-a"},"sent":true}""")),
        )
        assertEquals(
            SessionEvent.PermissionUpdated("p", mapOf("login" to FormAnswer.Text("luca-b")), typed = true, notes = mapOf("team" to "Not said")),
            Decode.sessionEvent(
                json("""{"type":"permission_updated","id":"p","answers":{"login":"luca-b"},"typed":true,"notes":{"team":"Not said"}}"""),
            ),
        )
    }

    @Test fun aHostedQuestionReadsEveryFieldOfItsKind() {
        val question = Decode.agentQuestion(
            json(
                """{"id":"n","question":"How many?","options":[],"kind":"number","hint":"Whole","placeholder":"3",
                   "default":"2","optional":true,"min":1,"max":9,"optionsOnly":false}""",
            ),
        )
        assertEquals(
            AgentQuestion(
                id = "n", question = "How many?", options = emptyList(), kind = InputKind.Number, hint = "Whole",
                placeholder = "3", default = "2", optional = true, min = 1.0, max = 9.0, optionsOnly = false,
            ),
            question,
        )
        val link = Decode.agentQuestion(json("""{"question":"Sign in","options":[],"kind":"link","url":"https://x","confirm":"I'm back"}"""))
        assertEquals(InputKind.Link, link.kind)
        assertEquals("https://x", link.url)
        assertEquals("I'm back", link.confirm)
    }

    @Test fun aFormAnswerMessageKeepsItsForm() {
        assertEquals(
            SessionEvent.UserMessage(text = "Approved", form = "req-1"),
            Decode.sessionEvent(json("""{"type":"user_message","text":"Approved","form":"req-1"}""")),
        )
    }

    @Test fun modelsAndCommands() {
        assertEquals(
            listOf(
                ModelOption(
                    id = "claude-opus-5-5", label = "Opus 5.5", hint = "Best", resolved = "claude-opus-5-5",
                    efforts = listOf(EffortOption("high", "High"), EffortOption("max", "Max", "Slow")), defaultEffort = "high",
                ),
                ModelOption(id = "gpt", label = "GPT"),
            ),
            Decode.modelOptions(
                json(
                    """[{"id":"claude-opus-5-5","label":"Opus 5.5","hint":"Best","resolved":"claude-opus-5-5",
                        "efforts":[{"id":"high","label":"High"},{"id":"max","label":"Max","hint":"Slow"}],"defaultEffort":"high"},
                       {"id":"gpt","label":"GPT"}]""",
                ),
            ),
        )
        assertEquals(
            listOf(CommandOption("compact", "Compact the context", "/compact "), CommandOption("review", insert = "/review")),
            Decode.commandOptions(json("""[{"name":"compact","description":"Compact the context","insert":"/compact "},{"name":"review","insert":"/review"}]""")),
        )
    }

    @Test fun theNewWritesInTheirContractShapes() {
        assertEquals(json("""{"id":"s","input":{"type":"set_model","model":"claude-opus-5-5"}}"""), Encode.writeSession("s", SetModel("claude-opus-5-5")))
        assertEquals(json("""{"id":"s","input":{"type":"set_model","model":null,"remember":false}}"""), Encode.writeSession("s", SetModel(null, remember = false)))
        assertEquals(json("""{"id":"s","input":{"type":"set_effort","effort":"high"}}"""), Encode.writeSession("s", SetEffort("high")))
        assertEquals(json("""{"id":"s","input":{"type":"set_permission_mode","mode":"plan"}}"""), Encode.writeSession("s", SetPermissionMode("plan")))
        assertEquals(json("""{"id":"s","input":{"type":"stop_task","taskId":"b1"}}"""), Encode.writeSession("s", StopTask("b1")))
    }

    @Test fun aHostedMultiSelectAnswersWithAnArrayBesideTheStrings() {
        assertEquals(
            json("""{"id":"s","input":{"type":"permission_response","id":"f","optionId":"answer","answers":{"login":"luca","teams":["a","b"]}}}"""),
            Encode.writeSession("s", PermissionResponse("f", "answer", mapOf("login" to "luca"), lists = mapOf("teams" to listOf("a", "b")))),
        )
        assertEquals(
            json("""{"id":"s","input":{"type":"permission_response","id":"f","optionId":"deny"}}"""),
            Encode.writeSession("s", PermissionResponse("f", "deny")),
        )
    }
}
