package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The port of `contract-pin.test.ts`: the samples the contract's own Effect schemas decode
 * decode here to the values the contract answers, constructed by hand so a decoder that
 * drops or renames a field cannot agree with itself.
 */
class DecodeTest {
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    private fun assertRefused(sample: JsonElement, decode: (JsonElement) -> Any?) {
        try {
            val decoded = decode(sample)
            fail("expected a DecodeError for $sample, decoded $decoded")
        } catch (_: DecodeError) {
        }
    }

    private val session = Session(
        id = "s1",
        provider = "claude",
        transport = Transport.Events,
        cwd = "/tmp/scratch",
        windowKey = "server",
        state = AgentState.Working,
        createdAt = 1_730_000_000_000L,
        adapterId = "claude-chat",
        title = "A chat",
        viewId = "clave.chat/chat",
    )

    private val events: List<SessionEvent> = listOf(
        SessionEvent.UserMessage(text = "hello"),
        SessionEvent.UserMessage(
            text = "see [Image #1]",
            attachments = listOf(
                FileAttachment(
                    id = "a1",
                    label = "Image #1",
                    path = "/tmp/a.png",
                    name = "a.png",
                    mimeType = "image/png",
                    size = 12,
                    delivery = FileDelivery.Image,
                ),
                SessionAttachment(id = "a2", sessionId = "s2", name = "Other", agent = "claude", cwd = "/x"),
            ),
        ),
        SessionEvent.AssistantText(delta = "hel", final = false),
        SessionEvent.UserMessage(text = "subagent brief", parent = "parent"),
        SessionEvent.AssistantText(delta = "subagent answer", final = true, parent = "parent"),
        SessionEvent.ToolCall(id = "t1", name = "Read", input = Json.parseToJsonElement("""{"path":"/x"}"""), parent = "p"),
        SessionEvent.ToolResult(id = "t1", output = JsonPrimitive("ok"), error = false),
        SessionEvent.ToolResult(id = "sub", output = JsonPrimitive("ok"), parent = "parent"),
        SessionEvent.PermissionWithdrawn(id = "retired"),
        SessionEvent.PermissionRequest(
            id = "r1",
            description = "Run it?",
            options = listOf(IdLabel("allow-once", "Allow"), IdLabel("deny", "Deny")),
            toolName = "Bash",
            input = Json.parseToJsonElement("""{"command":"ls"}"""),
            detail = "ls",
            questions = listOf(
                AgentQuestion(
                    id = "q1",
                    question = "Which?",
                    header = "Pick",
                    options = listOf(AgentQuestionOption("A", "a"), AgentQuestionOption("B")),
                    multiSelect = true,
                ),
            ),
        ),
        SessionEvent.StateChange(AgentState.Blocked),
        SessionEvent.SessionMeta(model = "claude-opus-5-5", providerSessionId = null),
        SessionEvent.Effort("high"),
        SessionEvent.Error(message = "boom", fatal = true),
        SessionEvent.TurnInterrupted,
        SessionEvent.ContextUsage(used = 10, window = 200, parent = "p"),
        SessionEvent.SubagentModel(parent = "p", model = "m"),
        SessionEvent.PermissionMode(mode = "default", modes = listOf(IdLabel("default", "Default"))),
        SessionEvent.BackgroundTasks(
            listOf(
                BackgroundTask(
                    id = "b1",
                    kind = BackgroundTaskKind.Shell,
                    description = "d",
                    command = "echo example",
                    startedAt = 1,
                    outputFile = "/o",
                ),
            ),
        ),
        SessionEvent.ProviderEvent(provider = "codex", payload = Json.parseToJsonElement("""{"any":1}""")),
    )

    private val request = PendingRequest(
        id = "req-1",
        sessionId = "s1",
        kind = RequestKind.Clarification,
        description = "A question",
        createdAt = 1,
        providerRequestId = "native-1",
        options = listOf(IdLabel("answer", "Answer")),
        questions = listOf(AgentQuestion(id = "q", question = "Which?", options = listOf(AgentQuestionOption("A")), multiSelect = false)),
        secretQuestions = listOf("q"),
        toolName = "AskUserQuestion",
        detail = "d",
        input = Json.parseToJsonElement("""{"x":1}"""),
        action = SecretAction.EnvFile(file = "/tmp/.env", key = "KEY"),
    )

    private val workspace = WorkspaceView(id = "ws1", name = "scratch", rootDir = "/tmp/scratch", profileFile = null, createdAt = 1)

    private val cursor = SessionPosition("adoption", 4)

    // ── the mirror decodes what the contract decodes ──

    @Test fun session() {
        assertEquals(session, Decode.session(Samples.at("session")))
    }

    @Test fun keepsTheSessionWorkspaceStampAbsentAndStamped() {
        assertEquals(session, Decode.session(Samples.at("session")))
        assertNull(Decode.session(Samples.at("session")).workspaceId)
        val stamped = session.copy(workspaceId = "ws1")
        assertEquals(stamped, Decode.session(Samples.at("sessionStamped")))
        for ((sample, expected) in listOf(Samples.obj("session") to session, Samples.obj("sessionStamped") to stamped)) {
            val frame = JsonObject(mapOf("_tag" to JsonPrimitive("subscribed"), "sessionId" to JsonPrimitive("s1"), "session" to sample))
            assertEquals(ServerFrame.Subscribed("s1", expected), Decode.serverFrame(frame))
        }
    }

    @Test fun sessionsList() {
        val list = JsonArray(listOf(Samples.at("session"), Samples.at("sessionStamped")))
        assertEquals(listOf(session, session.copy(workspaceId = "ws1")), Decode.sessions(list))
    }

    @Test fun everySessionEventMember() {
        val samples = Samples.list("events")
        assertEquals(events.size, samples.size)
        samples.forEachIndexed { i, sample -> assertEquals("events[$i]", events[i], Decode.sessionEvent(sample)) }
    }

    @Test fun historyPage() {
        val items = JsonArray(Samples.list("events").mapIndexed { i, event -> JsonObject(mapOf("event" to event, "at" to JsonPrimitive(i))) })
        val page = JsonObject(mapOf("items" to items, "before" to JsonPrimitive(12)))
        val expected = HistoryPage(events.mapIndexed { i, event -> HistoryItem(event, i.toLong()) }, 12)
        assertEquals(expected, Decode.historyPage(page))
        assertEquals(HistoryPage(emptyList(), null), Decode.historyPage(json("""{"items":[],"before":null}""")))
    }

    @Test fun sessionInfo() {
        val expected = SessionInfo(
            id = "s9",
            cwd = "/tmp/scratch",
            folderName = "scratch",
            alive = true,
            claudeSessionId = null,
            piSessionId = null,
            launchProfileId = "claude-chat",
            model = "m",
        )
        assertEquals(expected, Decode.sessionInfo(Samples.at("info")))
    }

    @Test fun pendingRequestAndRequestSnapshot() {
        assertEquals(request, Decode.pendingRequest(Samples.at("request")))
        assertEquals(RequestSnapshot(2, listOf(request)), Decode.requestSnapshot(Samples.at("requestSnapshot")))
    }

    @Test fun launchProfilePreferences() {
        val expected = LaunchProfilePreferencesView(
            customProfiles = listOf(
                LaunchProfileView(
                    id = "claude-chat",
                    name = "Claude (chat)",
                    family = LauncherFamily.Claude,
                    command = listOf("claude"),
                    additionalArgs = emptyList(),
                    builtIn = true,
                    sourceProfileId = "claude",
                ),
                LaunchProfileView(
                    id = "pi-x",
                    name = "Pi",
                    family = LauncherFamily.Pi,
                    command = listOf("pi"),
                    additionalArgs = listOf("--x"),
                    pi = PiOptions(provider = "openai", model = "gpt", thinking = PiThinkingLevel.High),
                ),
            ),
            globalDefaults = mapOf(LauncherFamily.Claude to "claude-chat"),
            workspaceOverrides = mapOf("ws1" to mapOf(LauncherFamily.Codex to "codex-chat")),
        )
        val decoded = Decode.launchProfiles(Samples.at("launchProfiles"))
        assertEquals(expected, decoded)
        assertEquals(1, decoded.version)
    }

    @Test fun launchProfilesRefuseAnotherVersion() {
        val sample = JsonObject(Samples.obj("launchProfiles") + ("version" to JsonPrimitive(2)))
        assertRefused(sample) { Decode.launchProfiles(it) }
    }

    @Test fun workspaceState() {
        val expected = WorkspaceStateView(
            workspaces = listOf(workspace),
            lastActiveWorkspaceId = "ws1",
            activeWorkspaceId = null,
            pins = json("""[{"anything":true}]""") as JsonArray,
            pinsMigrated = true,
            revision = 3,
            instance = "i-1",
        )
        assertEquals(expected, Decode.workspaceState(Samples.at("workspaces")))
    }

    @Test fun fileText() {
        assertEquals(
            FileText(content = "# hi", truncated = false, size = 4, binary = false),
            Decode.fileText(json("""{"content":"# hi","truncated":false,"size":4,"binary":false}""")),
        )
    }

    @Test fun capabilitiesAndResolveOutcome() {
        assertEquals(SessionCapabilities(images = true), Decode.sessionCapabilities(json("""{"images":true}""")))
        assertEquals(ResolveOutcome(accepted = false), Decode.resolveOutcome(json("""{"accepted":false}""")))
    }

    @Test fun serverEventEnvelopesAndTheEventsThePhoneReads() {
        assertEquals(
            ServerEventEnvelope("e1", 4, 2, ServerEvent.SessionStateChanged("s1", AgentState.Done)),
            Decode.serverEventEnvelope(Samples.at("envelope")),
        )
        assertEquals(
            ServerEventEnvelope("e1", 4, 2, ServerEvent.RequestsChanged(7)),
            Decode.serverEventEnvelope(Samples.at("envelopeRequestsChanged")),
        )
        assertEquals(
            ServerEventEnvelope("e1", 4, 2, ServerEvent.WorkspacesStateChanged(listOf(workspace), 1, "i")),
            Decode.serverEventEnvelope(Samples.at("envelopeWorkspaces")),
        )
    }

    @Test fun serverEventOfAnUnknownTagIsCarriedByTag() {
        assertEquals(ServerEvent.Unknown("devices.changed"), Decode.serverEvent(json("""{"_tag":"devices.changed","revision":1}""")))
        assertRefused(json("""{"_tag":""}""")) { Decode.serverEvent(it) }
    }

    @Test fun everyServerFrameThePhoneReads() {
        val expected = listOf(
            ServerFrame.Welcome("srv", 1, "2.4.0"),
            ServerFrame.Welcome("srv", 1),
            ServerFrame.Subscribed("s1", session),
            ServerFrame.Unsubscribed("s1"),
            ServerFrame.Stream("s1", SessionStream.Event(SessionEvent.AssistantText("hel", false))),
            // The contract decodes terminal bytes; the phone keeps the base64.
            ServerFrame.Stream("s1", SessionStream.Pty("aGk=")),
            ServerFrame.Exit("s1", 0),
            ServerFrame.Event(ServerEventEnvelope("e1", 4, 2, ServerEvent.SessionStateChanged("s1", AgentState.Done))),
            ServerFrame.Error("s1", "Unknown session"),
            ServerFrame.Error(message = "Malformed frame"),
            ServerFrame.Pong,
        )
        val samples = Samples.list("frames")
        assertEquals(expected.size, samples.size)
        samples.forEachIndexed { i, sample ->
            assertEquals("frames[$i]", expected[i], Decode.serverFrame(sample))
            assertEquals("frames[$i] as text", expected[i], parseServerFrame(sample.toString()))
        }
    }

    @Test fun aFrameTheContractWillAddLaterIsCarriedByTag() {
        val samples = Samples.list("unknownFrames")
        assertEquals(ServerFrame.Unknown("request"), Decode.serverFrame(samples[0]))
        assertEquals(ServerFrame.Unknown("something-new"), Decode.serverFrame(samples[1]))
    }

    @Test fun welcomeRefusesAnotherProtocol() {
        assertRefused(json("""{"_tag":"welcome","serverId":"srv","protocol":2}""")) { Decode.serverFrame(it) }
    }

    @Test fun parseServerFrameAnswersNullOnUnreadableText() {
        assertNull(parseServerFrame("not json"))
        assertNull(parseServerFrame("{\"_tag\":"))
        assertNull(parseServerFrame("[1,2]"))
        assertNull(parseServerFrame("""{"_tag":"exit","sessionId":"s1"}"""))
        assertEquals(ServerFrame.Pong, parseServerFrame("""{"_tag":"pong"}"""))
    }

    @Test fun aDeclaredFailureAsA422CarriesIt() {
        assertEquals(
            ServerFailure(tag = "SessionStartFailed", message = "Program \"claude\" was not found"),
            Decode.serverFailure(Samples.at("failures.sessionStartFailed")),
        )
        assertEquals(
            ServerFailure(tag = "CapabilityUnavailable", message = "This server holds no requests.", capability = "requests"),
            Decode.serverFailure(Samples.at("failures.capabilityUnavailable")),
        )
        assertEquals(
            ServerFailure(tag = "DevicePairingRefused", message = "The identity token was refused (audience).", check = "audience"),
            Decode.serverFailure(Samples.at("devices.refusal")),
        )
        assertEquals(
            ServerFailure(tag = "CapabilityUnavailable", message = "This server has no Antasphere login.", capability = "antasphereAccount"),
            Decode.serverFailure(Samples.at("devices.noOwner")),
        )
        assertEquals(ServerFailure(tag = "Mystery", message = "The server refused (Mystery)."), Decode.serverFailure(json("""{"_tag":"Mystery"}""")))
    }

    @Test fun theConstants() {
        val c = Samples.obj("constants")
        fun n(key: String): Long = (c[key] as JsonPrimitive).content.toLong()
        assertEquals((c["PUSH_PATH"] as JsonPrimitive).content, Push.PATH)
        assertEquals(n("PUSH_PROTOCOL"), Push.PROTOCOL.toLong())
        assertEquals(n("CLOSE_UNAUTHORIZED"), Push.CLOSE_UNAUTHORIZED.toLong())
        assertEquals(n("CLOSE_MALFORMED"), Push.CLOSE_MALFORMED.toLong())
        assertEquals(n("CLOSE_HELLO_TIMEOUT"), Push.CLOSE_HELLO_TIMEOUT.toLong())
        assertEquals(n("CLOSE_SERVER_STOPPING"), Push.CLOSE_SERVER_STOPPING.toLong())
        assertEquals(n("HELLO_TIMEOUT_MS"), Push.HELLO_TIMEOUT_MS)
        assertEquals(n("CLOSE_DEVICE_REVOKED"), Push.CLOSE_DEVICE_REVOKED.toLong())
    }

    // ── the mirror refuses what the contract refuses ──

    @Test fun anUnknownAgentStateAMissingFieldAWrongType() {
        val bad = Samples.list("badSessions")
        assertEquals(5, bad.size)
        for (sample in bad) assertRefused(sample) { Decode.session(it) }
        assertRefused(Samples.at("badEvent")) { Decode.sessionEvent(it) }
    }

    @Test fun anErrorNamesThePath() {
        val e = try {
            Decode.session(Samples.list("badSessions")[0])
            null
        } catch (error: DecodeError) {
            error
        }
        assertEquals("session.state", e?.path)
        assertEquals("one of idle, working, blocked, done, ended", e?.expected)
        val missing = try {
            Decode.sessions(JsonArray(listOf(Samples.at("session"), Samples.list("badSessions")[1])))
            null
        } catch (error: DecodeError) {
            error
        }
        assertEquals("sessions[1].id", missing?.path)
    }

    @Test fun aQuotedNumberIsNotANumber() {
        val sample = JsonObject(Samples.obj("session") + ("createdAt" to JsonPrimitive("1730000000000")))
        assertRefused(sample) { Decode.session(it) }
    }

    @Test fun untypedPayloadsKeepNullAndAbsenceApart() {
        val absent = Decode.sessionEvent(json("""{"type":"tool_call","id":"t","name":"n"}""")) as SessionEvent.ToolCall
        assertNull(absent.input)
        val explicit = Decode.sessionEvent(json("""{"type":"tool_call","id":"t","name":"n","input":null}""")) as SessionEvent.ToolCall
        assertEquals(JsonNull, explicit.input)
    }

    @Test fun aNullableFieldMustBePresent() {
        assertRefused(json("""{"type":"session_meta","model":"m"}""")) { Decode.sessionEvent(it) }
        assertRefused(json("""{"items":[]}""")) { Decode.historyPage(it) }
    }

    // ── ordered timeline mirror ──

    @Test fun timelinePositionsPagesAndPushPositions() {
        val event = SessionEvent.UserMessage(text = "a", clientMessageId = "message-123")
        assertEquals(
            TimelinePage(listOf(TimelineItem(event, 1, cursor)), 4, cursor, true),
            Decode.timelinePage(Samples.at("timeline.page")),
        )
        assertEquals(cursor, Decode.sessionPosition(Samples.at("timeline.cursor")))
        val streams = Samples.list("timeline.streamsWithPosition")
        assertEquals(SessionStream.Event(event, cursor), Decode.sessionStream(streams[0]))
        assertEquals(SessionStream.Event(event), Decode.sessionStream(streams[1]))
    }

    @Test fun timelineRefusesBadPositionsAndAMissingTruncated() {
        val bad = Samples.list("timeline.badPositions")
        assertEquals(4, bad.size)
        for (sample in bad) assertRefused(sample) { Decode.sessionPosition(it) }
        assertRefused(Samples.at("timeline.pageMissingTruncated")) { Decode.timelinePage(it) }
    }

    @Test fun theLargestSafeSequenceIsAccepted() {
        assertEquals(SessionPosition("g", 9_007_199_254_740_991L), Decode.sessionPosition(json("""{"generation":"g","sequence":9007199254740991}""")))
        assertEquals(SessionPosition("g", 3), Decode.sessionPosition(json("""{"generation":"g","sequence":3.0}""")))
    }

    @Test fun timelineRefusesAPageThatMixesGenerationsOrReversesPositions() {
        val bad = Samples.list("timeline.badPages")
        assertEquals(3, bad.size)
        for (sample in bad) {
            val e = try {
                Decode.timelinePage(sample)
                null
            } catch (error: DecodeError) {
                error
            }
            assertEquals("timeline", e?.path)
        }
    }

    @Test fun anUnknownStreamKindIsRefused() {
        assertRefused(json("""{"kind":"video"}""")) { Decode.sessionStream(it) }
    }

    // ── devices ──

    @Test fun pairing() {
        assertEquals(PairingTicket("pair-1", 1_730_000_600_000L), Decode.pairingTicket(Samples.at("devices.pairingTicket")))
        assertEquals(PairingRead(PairingStatus.Pending), Decode.pairingRead(Samples.at("devices.pairingPending")))
        assertEquals(
            PairingRead(
                PairingStatus.Approved,
                DeviceSession(
                    token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    deviceId = "dev-1",
                    serverId = "6f1c",
                    serverName = "Valentins-MacBook-Pro",
                ),
            ),
            Decode.pairingRead(Samples.at("devices.pairingApproved")),
        )
        assertEquals(PairingRead(PairingStatus.Approved), Decode.pairingRead(Samples.at("devices.pairingApprovedConsumed")))
        assertEquals(PairingRead(PairingStatus.Refused), Decode.pairingRead(Samples.at("devices.pairingRefused")))
        assertEquals(PairingRead(PairingStatus.Expired), Decode.pairingRead(Samples.at("devices.pairingExpired")))
        assertRefused(json("""{"status":"lost"}""")) { Decode.pairingRead(it) }
    }

    @Test fun deviceView() {
        assertEquals(
            DeviceView(id = "dev-1", name = "Pixel", platform = DevicePlatform.Android, appVersion = "0.1.0", createdAt = 1, lastSeenAt = null),
            Decode.deviceView(Samples.at("devices.deviceView")),
        )
    }

    @Test fun writeStatusesAndAnswers() {
        val statuses = Samples.list("devices.writeStatuses").map { Decode.writeStatus(it) }
        assertEquals(
            listOf(
                WriteStatus(WriteStatusKind.Accepted, at = 1),
                WriteStatus(WriteStatusKind.Pending),
                WriteStatus(WriteStatusKind.Rejected, reason = "server restarted before dispatch"),
                WriteStatus(WriteStatusKind.Absent),
                WriteStatus(WriteStatusKind.Unknown),
            ),
            statuses,
        )
        val answers = Samples.list("devices.writeAnswers").map { Decode.writeAnswer(it) }
        assertEquals(listOf(WriteAnswer(WriteAnswerStatus.Accepted, 1), WriteAnswer(WriteAnswerStatus.Pending)), answers)
    }

    // ── relay ──

    @Test fun relayMachines() {
        assertEquals(
            listOf(
                RelayMachine("m1", "Valentins-MacBook-Pro", MachinePlatform.Macos, "3.0.0", true, 1_730_000_000_000L, emptyList()),
                RelayMachine("m2", "box", MachinePlatform.Linux, "3.0.0", false, null, listOf("https://10.0.0.2:4711")),
            ),
            Decode.relayMachines(Samples.at("relay.machines")),
        )
    }

    @Test fun relayMachinesAreReadLeniently() {
        val body = json(
            """{"machines":[{"id":"m3","platform":"windows","lastSeen":"2024-10-27T03:33:20Z","direct":[{"url":"https://a"},{"nope":1}]}]}""",
        )
        assertEquals(
            listOf(RelayMachine("m3", "m3", MachinePlatform.Unknown, "", false, 1_730_000_000_000L, listOf("https://a"))),
            Decode.relayMachines(body),
        )
        val unreadableDate = json("""{"machines":[{"id":"m4","lastSeen":"yesterday"}]}""")
        assertNull(Decode.relayMachines(unreadableDate).single().lastSeen)
    }

    @Test fun aRelayRowWithoutAnIdIsRefused() {
        val e = try {
            Decode.relayMachines(json("""{"machines":[{"id":"m1"},{"name":"anonymous"}]}"""))
            null
        } catch (error: DecodeError) {
            error
        }
        assertTrue(e?.path?.startsWith("relay.machines[1]") == true)
        assertRefused(json("""{"rows":[]}""")) { Decode.relayMachines(it) }
    }
}
