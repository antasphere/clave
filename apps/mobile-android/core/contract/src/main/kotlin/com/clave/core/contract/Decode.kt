/**
 * The decoders of the mirror (Types.kt), ported from the phone's TypeScript
 * (`apps/mobile/src/contract/decode.ts`): each one takes a parsed JSON element and
 * answers the typed value or throws a [DecodeError] naming the path. No schema library:
 * the shapes are pinned to the contract by the samples in the tests.
 *
 * Absence and JSON null are two different things on this wire, as they are to the
 * contract: an optional field may be absent but not null (`workspaceId: null` is a
 * refusal), a nullable field may be null but not absent. A Kotlin `null` handed to a
 * helper below therefore always means "the key was not there".
 */
package com.clave.core.contract

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class DecodeError(val path: String, val expected: String) : Exception("$path: expected $expected")

object Decode {
    /** Number.MAX_SAFE_INTEGER: the contract's bound on a sequence, past which a
     *  JavaScript peer could no longer tell two positions apart. */
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    // ── primitives ──

    private fun fail(path: String, expected: String): Nothing = throw DecodeError(path, expected)

    private fun obj(value: JsonElement?, path: String): JsonObject =
        value as? JsonObject ?: fail(path, "an object")

    private fun str(value: JsonElement?, path: String): String =
        (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content ?: fail(path, "a string")

    private fun nonEmpty(value: JsonElement?, path: String): String =
        (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString && it.content.isNotEmpty() }?.content
            ?: fail(path, "a non-empty string")

    private fun bool(value: JsonElement?, path: String): Boolean {
        val p = value as? JsonPrimitive
        if (p == null || p is JsonNull || p.isString) fail(path, "a boolean")
        return when (p.content) {
            "true" -> true
            "false" -> false
            else -> fail(path, "a boolean")
        }
    }

    /** The finite number a JSON literal holds, or null when it is not one: a quoted
     *  "12" is a string to the contract, never a number. */
    private fun finite(value: JsonElement?): Double? {
        val p = value as? JsonPrimitive ?: return null
        if (p is JsonNull || p.isString) return null
        return p.content.toDoubleOrNull()?.takeIf { it.isFinite() }
    }

    private fun num(value: JsonElement?, path: String): Double = finite(value) ?: fail(path, "a number")

    /** A number held as Long: the exact integer when the literal is one (a timestamp
     *  above 2^53 keeps its digits), otherwise the finite value truncated, since the
     *  contract's `Schema.Number` admits a fraction the Kotlin mirror types as Long. */
    private fun long(value: JsonElement?, path: String): Long {
        val d = num(value, path)
        return (value as JsonPrimitive).content.toLongOrNull() ?: d.toLong()
    }

    private fun int(value: JsonElement?, path: String): Int = long(value, path).toInt()

    private fun sequence(value: JsonElement?, path: String): Long {
        val d = finite(value)
        val n = when {
            d == null -> null
            else -> (value as JsonPrimitive).content.toLongOrNull()
                ?: d.takeIf { it == Math.floor(it) && Math.abs(it) <= MAX_SAFE_INTEGER }?.toLong()
        }
        return n?.takeIf { it in 0..MAX_SAFE_INTEGER } ?: fail(path, "a nonnegative safe integer")
    }

    private fun <T> opt(value: JsonElement?, path: String, decode: (JsonElement?, String) -> T): T? =
        if (value == null) null else decode(value, path)

    private fun <T> nullable(value: JsonElement?, path: String, decode: (JsonElement?, String) -> T): T? =
        if (value is JsonNull) null else decode(value, path)

    private fun <T> arr(value: JsonElement?, path: String, decode: (JsonElement?, String) -> T): List<T> =
        (value as? JsonArray ?: fail(path, "an array")).mapIndexed { i, item -> decode(item, "$path[$i]") }

    private fun <E> lit(value: JsonElement?, path: String, entries: List<E>, wire: (E) -> String): E {
        val s = (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
        return entries.firstOrNull { wire(it) == s } ?: fail(path, "one of ${entries.joinToString(", ") { wire(it) }}")
    }

    private fun agentStateOf(value: JsonElement?, path: String): AgentState =
        lit(value, path, AgentState.entries) { it.wire }

    // ── sessions ──

    fun agentState(value: JsonElement, path: String = "state"): AgentState = agentStateOf(value, path)

    fun session(value: JsonElement, path: String = "session"): Session = sessionOf(value, path)

    private fun sessionOf(value: JsonElement?, path: String): Session {
        val o = obj(value, path)
        return Session(
            id = nonEmpty(o["id"], "$path.id"),
            provider = nonEmpty(o["provider"], "$path.provider"),
            transport = lit(o["transport"], "$path.transport", Transport.entries) { it.wire },
            cwd = str(o["cwd"], "$path.cwd"),
            windowKey = str(o["windowKey"], "$path.windowKey"),
            workspaceId = opt(o["workspaceId"], "$path.workspaceId", ::str),
            groupId = opt(o["groupId"], "$path.groupId", ::str),
            state = agentStateOf(o["state"], "$path.state"),
            createdAt = long(o["createdAt"], "$path.createdAt"),
            adapterId = nonEmpty(o["adapterId"], "$path.adapterId"),
            title = str(o["title"], "$path.title"),
            viewId = opt(o["viewId"], "$path.viewId", ::nonEmpty),
        )
    }

    fun sessions(value: JsonElement, path: String = "sessions"): List<Session> = arr(value, path, ::sessionOf)

    private fun attachment(value: JsonElement?, path: String): Attachment {
        val o = obj(value, path)
        val delivery = str(o["delivery"], "$path.delivery")
        if (delivery == "session") {
            return SessionAttachment(
                id = nonEmpty(o["id"], "$path.id"),
                label = opt(o["label"], "$path.label", ::str),
                sessionId = nonEmpty(o["sessionId"], "$path.sessionId"),
                name = nonEmpty(o["name"], "$path.name"),
                agent = nonEmpty(o["agent"], "$path.agent"),
                cwd = str(o["cwd"], "$path.cwd"),
            )
        }
        return FileAttachment(
            id = nonEmpty(o["id"], "$path.id"),
            label = opt(o["label"], "$path.label", ::str),
            path = nonEmpty(o["path"], "$path.path"),
            name = nonEmpty(o["name"], "$path.name"),
            mimeType = nonEmpty(o["mimeType"], "$path.mimeType"),
            size = long(o["size"], "$path.size"),
            delivery = lit(o["delivery"], "$path.delivery", FileDelivery.entries) { it.wire },
            entries = opt(o["entries"], "$path.entries", ::long),
        )
    }

    fun agentQuestion(value: JsonElement, path: String = "question"): AgentQuestion = agentQuestionOf(value, path)

    private fun agentQuestionOf(value: JsonElement?, path: String): AgentQuestion {
        val o = obj(value, path)
        return AgentQuestion(
            id = opt(o["id"], "$path.id", ::nonEmpty),
            question = str(o["question"], "$path.question"),
            header = opt(o["header"], "$path.header", ::str),
            options = arr(o["options"], "$path.options") { item, p ->
                val option = obj(item, p)
                AgentQuestionOption(
                    label = str(option["label"], "$p.label"),
                    description = opt(option["description"], "$p.description", ::str),
                )
            },
            multiSelect = opt(o["multiSelect"], "$path.multiSelect", ::bool),
            optionsOnly = opt(o["optionsOnly"], "$path.optionsOnly", ::bool),
            kind = opt(o["kind"], "$path.kind") { v, p -> lit(v, p, InputKind.entries) { it.wire } },
            hint = opt(o["hint"], "$path.hint", ::str),
            placeholder = opt(o["placeholder"], "$path.placeholder", ::str),
            default = opt(o["default"], "$path.default", ::str),
            optional = opt(o["optional"], "$path.optional", ::bool),
            url = opt(o["url"], "$path.url", ::str),
            confirm = opt(o["confirm"], "$path.confirm", ::str),
            min = opt(o["min"], "$path.min", ::num),
            max = opt(o["max"], "$path.max", ::num),
        )
    }

    /** A form's answers by the question's key: a string, or the labels of a multi-select. */
    private fun formAnswers(value: JsonElement?, path: String): Map<String, FormAnswer> {
        val o = obj(value, path)
        val answers = LinkedHashMap<String, FormAnswer>()
        for ((key, item) in o) {
            answers[key] = if (item is JsonArray) {
                FormAnswer.Choices(arr(item, "$path.$key", ::str))
            } else {
                FormAnswer.Text(str(item, "$path.$key"))
            }
        }
        return answers
    }

    private fun stringRecord(value: JsonElement?, path: String): Map<String, String> {
        val o = obj(value, path)
        val record = LinkedHashMap<String, String>()
        for ((key, item) in o) record[key] = str(item, "$path.$key")
        return record
    }

    private fun idLabel(value: JsonElement?, path: String): IdLabel {
        val o = obj(value, path)
        return IdLabel(id = str(o["id"], "$path.id"), label = str(o["label"], "$path.label"))
    }

    fun sessionEvent(value: JsonElement, path: String = "event"): SessionEvent = sessionEventOf(value, path)

    /**
     * An event as a page or a live frame carries it: a member this phone cannot read (a
     * malformed one of a known type included) is carried as [SessionEvent.Unknown] by its
     * type, so one event never fails a whole page of history nor drops a positioned frame,
     * whose position the order of the stream still needs. Only an item that is not an event
     * at all (no object, no string type) is refused.
     */
    private fun carriedEventOf(value: JsonElement?, path: String): SessionEvent = try {
        sessionEventOf(value, path)
    } catch (e: DecodeError) {
        val type = ((value as? JsonObject)?.get("type") as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
        if (type == null) throw e
        SessionEvent.Unknown(type)
    }

    private fun sessionEventOf(value: JsonElement?, path: String): SessionEvent {
        val o = obj(value, path)
        return when (val type = str(o["type"], "$path.type")) {
            "user_message" -> SessionEvent.UserMessage(
                clientMessageId = opt(o["clientMessageId"], "$path.clientMessageId", ::str),
                text = str(o["text"], "$path.text"),
                attachments = opt(o["attachments"], "$path.attachments") { v, p -> arr(v, p, ::attachment) },
                parent = opt(o["parent"], "$path.parent", ::str),
                form = opt(o["form"], "$path.form", ::str),
            )
            "assistant_text" -> SessionEvent.AssistantText(
                delta = str(o["delta"], "$path.delta"),
                final = bool(o["final"], "$path.final"),
                parent = opt(o["parent"], "$path.parent", ::str),
            )
            "tool_call" -> SessionEvent.ToolCall(
                id = str(o["id"], "$path.id"),
                name = str(o["name"], "$path.name"),
                input = o["input"],
                parent = opt(o["parent"], "$path.parent", ::str),
            )
            "tool_result" -> SessionEvent.ToolResult(
                id = str(o["id"], "$path.id"),
                output = o["output"],
                error = opt(o["error"], "$path.error", ::bool),
                parent = opt(o["parent"], "$path.parent", ::str),
            )
            "permission_request" -> SessionEvent.PermissionRequest(
                id = str(o["id"], "$path.id"),
                description = str(o["description"], "$path.description"),
                options = arr(o["options"], "$path.options", ::idLabel),
                toolName = opt(o["toolName"], "$path.toolName", ::str),
                input = o["input"],
                detail = opt(o["detail"], "$path.detail", ::str),
                questions = opt(o["questions"], "$path.questions") { v, p -> arr(v, p, ::agentQuestionOf) },
            )
            "permission_withdrawn" -> SessionEvent.PermissionWithdrawn(id = str(o["id"], "$path.id"))
            "permission_updated" -> SessionEvent.PermissionUpdated(
                id = str(o["id"], "$path.id"),
                answers = formAnswers(o["answers"], "$path.answers"),
                sent = opt(o["sent"], "$path.sent", ::bool),
                typed = opt(o["typed"], "$path.typed", ::bool),
                notes = opt(o["notes"], "$path.notes", ::stringRecord),
            )
            "permission_explained" -> SessionEvent.PermissionExplained(
                id = str(o["id"], "$path.id"),
                level = opt(o["level"], "$path.level") { v, p -> lit(v, p, RiskLevel.entries) { it.wire } },
                sentence = opt(o["sentence"], "$path.sentence", ::str),
                asked = opt(o["asked"], "$path.asked") { v, p -> lit(v, p, AskedMatch.entries) { it.wire } },
                failed = opt(o["failed"], "$path.failed", ::str),
            )
            "state_change" -> SessionEvent.StateChange(state = agentStateOf(o["state"], "$path.state"))
            "session_meta" -> SessionEvent.SessionMeta(
                model = nullable(o["model"], "$path.model", ::str),
                providerSessionId = nullable(o["providerSessionId"], "$path.providerSessionId", ::str),
            )
            "effort" -> SessionEvent.Effort(effort = nullable(o["effort"], "$path.effort", ::str))
            "error" -> SessionEvent.Error(
                message = str(o["message"], "$path.message"),
                fatal = bool(o["fatal"], "$path.fatal"),
            )
            "turn_interrupted" -> SessionEvent.TurnInterrupted
            "context_usage" -> SessionEvent.ContextUsage(
                used = long(o["used"], "$path.used"),
                window = nullable(o["window"], "$path.window", ::long),
                parent = opt(o["parent"], "$path.parent", ::str),
            )
            "subagent_model" -> SessionEvent.SubagentModel(
                parent = str(o["parent"], "$path.parent"),
                model = str(o["model"], "$path.model"),
            )
            "permission_mode" -> SessionEvent.PermissionMode(
                mode = str(o["mode"], "$path.mode"),
                modes = arr(o["modes"], "$path.modes", ::idLabel),
            )
            "background_tasks" -> SessionEvent.BackgroundTasks(
                tasks = arr(o["tasks"], "$path.tasks") { item, p ->
                    val task = obj(item, p)
                    BackgroundTask(
                        id = str(task["id"], "$p.id"),
                        kind = lit(task["kind"], "$p.kind", BackgroundTaskKind.entries) { it.wire },
                        description = str(task["description"], "$p.description"),
                        command = opt(task["command"], "$p.command", ::str),
                        toolUseId = opt(task["toolUseId"], "$p.toolUseId", ::str),
                        startedAt = long(task["startedAt"], "$p.startedAt"),
                        outputFile = opt(task["outputFile"], "$p.outputFile", ::str),
                        model = opt(task["model"], "$p.model", ::str),
                    )
                },
            )
            "provider_event" -> SessionEvent.ProviderEvent(
                provider = str(o["provider"], "$path.provider"),
                payload = o["payload"],
            )
            // A closed union on the server, but a newer server grows it before this phone
            // learns the member: carried by its type, read by nobody, never a refusal.
            else -> SessionEvent.Unknown(type)
        }
    }

    fun sessionStream(value: JsonElement, path: String = "stream"): SessionStream = sessionStreamOf(value, path)

    private fun sessionStreamOf(value: JsonElement?, path: String): SessionStream {
        val o = obj(value, path)
        return when (str(o["kind"], "$path.kind")) {
            "pty" -> SessionStream.Pty(data = str(o["data"], "$path.data"))
            "event" -> SessionStream.Event(
                event = carriedEventOf(o["event"], "$path.event"),
                position = opt(o["position"], "$path.position", ::sessionPositionOf),
            )
            else -> fail("$path.kind", "pty or event")
        }
    }

    fun sessionPosition(value: JsonElement, path: String = "position"): SessionPosition = sessionPositionOf(value, path)

    private fun sessionPositionOf(value: JsonElement?, path: String): SessionPosition {
        val o = obj(value, path)
        return SessionPosition(
            generation = nonEmpty(o["generation"], "$path.generation"),
            sequence = sequence(o["sequence"], "$path.sequence"),
        )
    }

    /** The order check is the reason this page exists: a reducer that merges history by
     *  position trusts that a page never mixes generations, never reverses, and never
     *  runs past the cursor it was cut at. */
    fun timelinePage(value: JsonElement, path: String = "timeline"): TimelinePage {
        val o = obj(value, path)
        val cursor = sessionPositionOf(o["cursor"], "$path.cursor")
        val items = arr(o["items"], "$path.items") { item, p ->
            val entry = obj(item, p)
            TimelineItem(
                event = carriedEventOf(entry["event"], "$p.event"),
                at = opt(entry["at"], "$p.at", ::long),
                position = sessionPositionOf(entry["position"], "$p.position"),
            )
        }
        var previous = -1L
        for (item in items) {
            if (item.position.generation != cursor.generation ||
                item.position.sequence <= previous ||
                item.position.sequence > cursor.sequence
            ) {
                fail(path, "ordered items in the cursor generation at or below its watermark")
            }
            previous = item.position.sequence
        }
        return TimelinePage(
            items = items,
            before = nullable(o["before"], "$path.before", ::sequence),
            cursor = cursor,
            truncated = bool(o["truncated"], "$path.truncated"),
        )
    }

    fun historyPage(value: JsonElement, path: String = "history"): HistoryPage {
        val o = obj(value, path)
        return HistoryPage(
            items = arr(o["items"], "$path.items") { item, p ->
                val entry = obj(item, p)
                HistoryItem(event = carriedEventOf(entry["event"], "$p.event"), at = opt(entry["at"], "$p.at", ::long))
            },
            before = nullable(o["before"], "$path.before", ::long),
        )
    }

    fun sessionInfo(value: JsonElement, path: String = "info"): SessionInfo {
        val o = obj(value, path)
        return SessionInfo(
            id = nonEmpty(o["id"], "$path.id"),
            cwd = str(o["cwd"], "$path.cwd"),
            folderName = str(o["folderName"], "$path.folderName"),
            alive = bool(o["alive"], "$path.alive"),
            claudeSessionId = nullable(o["claudeSessionId"], "$path.claudeSessionId", ::str),
            piSessionId = nullable(o["piSessionId"], "$path.piSessionId", ::str),
            launchProfileId = opt(o["launchProfileId"], "$path.launchProfileId", ::str),
            model = opt(o["model"], "$path.model", ::str),
            piProvider = opt(o["piProvider"], "$path.piProvider", ::str),
            piThinking = opt(o["piThinking"], "$path.piThinking", ::str),
        )
    }

    fun sessionCapabilities(value: JsonElement, path: String = "capabilities"): SessionCapabilities {
        val o = obj(value, path)
        return SessionCapabilities(images = bool(o["images"], "$path.images"))
    }

    fun writeAnswer(value: JsonElement, path: String = "writeAnswer"): WriteAnswer {
        val o = obj(value, path)
        return WriteAnswer(
            status = lit(o["status"], "$path.status", WriteAnswerStatus.entries) { it.wire },
            at = opt(o["at"], "$path.at", ::long),
        )
    }

    fun writeStatus(value: JsonElement, path: String = "writeStatus"): WriteStatus {
        val o = obj(value, path)
        return WriteStatus(
            status = lit(o["status"], "$path.status", WriteStatusKind.entries) { it.wire },
            at = opt(o["at"], "$path.at", ::long),
            reason = opt(o["reason"], "$path.reason", ::str),
        )
    }

    /** `GET /sessions/models`: what the session may switch to; empty when its provider offers none. */
    fun modelOptions(value: JsonElement, path: String = "models"): List<ModelOption> = arr(value, path) { item, p ->
        val o = obj(item, p)
        ModelOption(
            id = str(o["id"], "$p.id"),
            label = str(o["label"], "$p.label"),
            hint = opt(o["hint"], "$p.hint", ::str),
            resolved = opt(o["resolved"], "$p.resolved", ::str),
            efforts = opt(o["efforts"], "$p.efforts") { v, ep ->
                arr(v, ep) { e, eap ->
                    val effort = obj(e, eap)
                    EffortOption(
                        id = str(effort["id"], "$eap.id"),
                        label = str(effort["label"], "$eap.label"),
                        hint = opt(effort["hint"], "$eap.hint", ::str),
                    )
                }
            },
            defaultEffort = opt(o["defaultEffort"], "$p.defaultEffort", ::str),
        )
    }

    /** `GET /sessions/commands`: what the composer offers under "/". */
    fun commandOptions(value: JsonElement, path: String = "commands"): List<CommandOption> = arr(value, path) { item, p ->
        val o = obj(item, p)
        CommandOption(
            name = str(o["name"], "$p.name"),
            description = opt(o["description"], "$p.description", ::str),
            insert = str(o["insert"], "$p.insert"),
        )
    }

    // ── launch profiles ──

    fun launchProfile(value: JsonElement, path: String = "profile"): LaunchProfileView = launchProfileOf(value, path)

    private fun launchProfileOf(value: JsonElement?, path: String): LaunchProfileView {
        val o = obj(value, path)
        val pi = o["pi"]?.let { obj(it, "$path.pi") }
        return LaunchProfileView(
            id = str(o["id"], "$path.id"),
            name = str(o["name"], "$path.name"),
            family = lit(o["family"], "$path.family", LauncherFamily.entries) { it.wire },
            command = arr(o["command"], "$path.command", ::str),
            additionalArgs = arr(o["additionalArgs"], "$path.additionalArgs", ::str),
            builtIn = opt(o["builtIn"], "$path.builtIn", ::bool),
            sourceProfileId = opt(o["sourceProfileId"], "$path.sourceProfileId", ::str),
            pi = pi?.let {
                PiOptions(
                    provider = opt(it["provider"], "$path.pi.provider", ::str),
                    model = opt(it["model"], "$path.pi.model", ::str),
                    thinking = opt(it["thinking"], "$path.pi.thinking") { v, p ->
                        lit(v, p, PiThinkingLevel.entries) { level -> level.wire }
                    },
                )
            },
        )
    }

    /** Only the four families are read; any other key is an excess property and dropped. */
    private fun familyDefaults(value: JsonElement?, path: String): FamilyDefaultsView {
        val o = obj(value, path)
        val defaults = LinkedHashMap<LauncherFamily, String>()
        for (family in LauncherFamily.entries) {
            opt(o[family.wire], "$path.${family.wire}", ::str)?.let { defaults[family] = it }
        }
        return defaults
    }

    private fun versionOne(value: JsonElement?, path: String) {
        if (finite(value) != 1.0) fail(path, "1")
    }

    fun launchProfiles(value: JsonElement, path: String = "launchProfiles"): LaunchProfilePreferencesView {
        val o = obj(value, path)
        versionOne(o["version"], "$path.version")
        val overrides = obj(o["workspaceOverrides"], "$path.workspaceOverrides")
        val workspaceOverrides = LinkedHashMap<String, FamilyDefaultsView>()
        for ((key, item) in overrides) {
            workspaceOverrides[key] = familyDefaults(item, "$path.workspaceOverrides.$key")
        }
        return LaunchProfilePreferencesView(
            customProfiles = arr(o["customProfiles"], "$path.customProfiles", ::launchProfileOf),
            globalDefaults = familyDefaults(o["globalDefaults"], "$path.globalDefaults"),
            workspaceOverrides = workspaceOverrides,
        )
    }

    // ── workspaces ──

    fun workspace(value: JsonElement, path: String = "workspace"): WorkspaceView = workspaceOf(value, path)

    private fun workspaceOf(value: JsonElement?, path: String): WorkspaceView {
        val o = obj(value, path)
        return WorkspaceView(
            id = str(o["id"], "$path.id"),
            name = str(o["name"], "$path.name"),
            rootDir = str(o["rootDir"], "$path.rootDir"),
            profileFile = nullable(o["profileFile"], "$path.profileFile", ::str),
            createdAt = long(o["createdAt"], "$path.createdAt"),
        )
    }

    fun workspaceState(value: JsonElement, path: String = "workspaces"): WorkspaceStateView {
        val o = obj(value, path)
        versionOne(o["version"], "$path.version")
        return WorkspaceStateView(
            workspaces = arr(o["workspaces"], "$path.workspaces", ::workspaceOf),
            lastActiveWorkspaceId = nullable(o["lastActiveWorkspaceId"], "$path.lastActiveWorkspaceId", ::str),
            activeWorkspaceId = nullable(o["activeWorkspaceId"], "$path.activeWorkspaceId", ::str),
            pins = o["pins"] as? JsonArray ?: fail("$path.pins", "an array"),
            pinsMigrated = bool(o["pinsMigrated"], "$path.pinsMigrated"),
            revision = long(o["revision"], "$path.revision"),
            instance = str(o["instance"], "$path.instance"),
        )
    }

    // ── requests ──

    private fun secretAction(value: JsonElement?, path: String): SecretAction {
        val o = obj(value, path)
        return when (str(o["type"], "$path.type")) {
            "run" -> SecretAction.Run(
                command = nonEmpty(o["command"], "$path.command"),
                cwd = nonEmpty(o["cwd"], "$path.cwd"),
                envVar = nonEmpty(o["envVar"], "$path.envVar"),
            )
            "env-file" -> SecretAction.EnvFile(file = nonEmpty(o["file"], "$path.file"), key = nonEmpty(o["key"], "$path.key"))
            else -> fail("$path.type", "run or env-file")
        }
    }

    fun pendingRequest(value: JsonElement, path: String = "request"): PendingRequest = pendingRequestOf(value, path)

    private fun pendingRequestOf(value: JsonElement?, path: String): PendingRequest {
        val o = obj(value, path)
        return PendingRequest(
            id = nonEmpty(o["id"], "$path.id"),
            sessionId = nonEmpty(o["sessionId"], "$path.sessionId"),
            kind = lit(o["kind"], "$path.kind", RequestKind.entries) { it.wire },
            description = nonEmpty(o["description"], "$path.description"),
            createdAt = long(o["createdAt"], "$path.createdAt"),
            providerRequestId = opt(o["providerRequestId"], "$path.providerRequestId", ::nonEmpty),
            options = opt(o["options"], "$path.options") { v, p -> arr(v, p, ::idLabel) },
            questions = opt(o["questions"], "$path.questions") { v, p -> arr(v, p, ::agentQuestionOf) },
            secretQuestions = opt(o["secretQuestions"], "$path.secretQuestions") { v, p -> arr(v, p, ::nonEmpty) },
            toolName = opt(o["toolName"], "$path.toolName", ::nonEmpty),
            detail = opt(o["detail"], "$path.detail", ::nonEmpty),
            input = o["input"],
            action = opt(o["action"], "$path.action", ::secretAction),
        )
    }

    fun requestSnapshot(value: JsonElement, path: String = "requests"): RequestSnapshot {
        val o = obj(value, path)
        return RequestSnapshot(
            revision = long(o["revision"], "$path.revision"),
            pending = arr(o["pending"], "$path.pending", ::pendingRequestOf),
        )
    }

    fun resolveOutcome(value: JsonElement, path: String = "resolve"): ResolveOutcome {
        val o = obj(value, path)
        return ResolveOutcome(accepted = bool(o["accepted"], "$path.accepted"))
    }

    // ── files ──

    fun fileText(value: JsonElement, path: String = "file"): FileText {
        val o = obj(value, path)
        return FileText(
            content = str(o["content"], "$path.content"),
            truncated = bool(o["truncated"], "$path.truncated"),
            size = long(o["size"], "$path.size"),
            binary = bool(o["binary"], "$path.binary"),
        )
    }

    // ── failures ──

    /** A 422 body as the server writes a declared failure. A missing message is not a
     *  protocol failure: the tag alone is enough to say the server refused. */
    fun serverFailure(value: JsonElement, path: String = "failure"): ServerFailure {
        val o = obj(value, path)
        val tag = nonEmpty(o["_tag"], "$path._tag")
        val message = (o["message"] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
        return ServerFailure(
            tag = tag,
            message = message ?: "The server refused ($tag).",
            capability = opt(o["capability"], "$path.capability", ::str),
            code = opt(o["code"], "$path.code", ::str),
            id = opt(o["id"], "$path.id", ::str),
            check = opt(o["check"], "$path.check", ::str),
        )
    }

    // ── events and push frames ──

    fun serverEvent(value: JsonElement, path: String = "event"): ServerEvent = serverEventOf(value, path)

    /** The server's event union grows with every domain; the phone reads five and carries
     *  the rest by tag so a newer server never breaks an older phone. */
    private fun serverEventOf(value: JsonElement?, path: String): ServerEvent {
        val o = obj(value, path)
        return when (val tag = nonEmpty(o["_tag"], "$path._tag")) {
            "requests.changed" -> ServerEvent.RequestsChanged(revision = long(o["revision"], "$path.revision"))
            "session.state_changed" -> ServerEvent.SessionStateChanged(
                id = str(o["id"], "$path.id"),
                state = agentStateOf(o["state"], "$path.state"),
            )
            "session.title_changed" -> ServerEvent.SessionTitleChanged(
                id = str(o["id"], "$path.id"),
                title = str(o["title"], "$path.title"),
            )
            "session.renamed" -> ServerEvent.SessionRenamed(id = str(o["id"], "$path.id"), name = str(o["name"], "$path.name"))
            "workspaces.state_changed" -> ServerEvent.WorkspacesStateChanged(
                workspaces = arr(o["workspaces"], "$path.workspaces", ::workspaceOf),
                revision = long(o["revision"], "$path.revision"),
                instance = str(o["instance"], "$path.instance"),
            )
            else -> ServerEvent.Unknown(tag)
        }
    }

    fun serverEventEnvelope(value: JsonElement, path: String = "envelope"): ServerEventEnvelope =
        envelopeOf(obj(value, path), path)

    private fun envelopeOf(o: JsonObject, path: String): ServerEventEnvelope = ServerEventEnvelope(
        id = str(o["id"], "$path.id"),
        seq = long(o["seq"], "$path.seq"),
        at = long(o["at"], "$path.at"),
        event = serverEventOf(o["event"], "$path.event"),
    )

    fun serverFrame(value: JsonElement, path: String = "frame"): ServerFrame {
        val o = obj(value, path)
        return when (val tag = nonEmpty(o["_tag"], "$path._tag")) {
            "welcome" -> ServerFrame.Welcome(
                serverId = str(o["serverId"], "$path.serverId"),
                protocol = if (finite(o["protocol"]) == 1.0) 1 else fail("$path.protocol", "1"),
                version = opt(o["version"], "$path.version", ::str),
            )
            "subscribed" -> ServerFrame.Subscribed(
                sessionId = str(o["sessionId"], "$path.sessionId"),
                session = sessionOf(o["session"], "$path.session"),
            )
            "unsubscribed" -> ServerFrame.Unsubscribed(sessionId = str(o["sessionId"], "$path.sessionId"))
            "stream" -> ServerFrame.Stream(
                sessionId = str(o["sessionId"], "$path.sessionId"),
                stream = sessionStreamOf(o["stream"], "$path.stream"),
            )
            "exit" -> ServerFrame.Exit(sessionId = str(o["sessionId"], "$path.sessionId"), code = int(o["code"], "$path.code"))
            // The event frame is the envelope spread flat beside the tag.
            "event" -> ServerFrame.Event(envelope = envelopeOf(o, path))
            "error" -> ServerFrame.Error(
                sessionId = opt(o["sessionId"], "$path.sessionId", ::str),
                message = str(o["message"], "$path.message"),
            )
            "pong" -> ServerFrame.Pong
            else -> ServerFrame.Unknown(tag)
        }
    }

    // ── devices ──

    fun pairingTicket(value: JsonElement, path: String = "pairing"): PairingTicket {
        val o = obj(value, path)
        return PairingTicket(
            pairingId = nonEmpty(o["pairingId"], "$path.pairingId"),
            expiresAt = long(o["expiresAt"], "$path.expiresAt"),
        )
    }

    fun deviceSession(value: JsonElement, path: String = "deviceSession"): DeviceSession = deviceSessionOf(value, path)

    private fun deviceSessionOf(value: JsonElement?, path: String): DeviceSession {
        val o = obj(value, path)
        return DeviceSession(
            token = str(o["token"], "$path.token"),
            deviceId = nonEmpty(o["deviceId"], "$path.deviceId"),
            serverId = str(o["serverId"], "$path.serverId"),
            serverName = str(o["serverName"], "$path.serverName"),
        )
    }

    /** An approved read without a session is the normal second read: the credential is
     *  handed out once and the pairing forgets it. */
    fun pairingRead(value: JsonElement, path: String = "pairingRead"): PairingRead {
        val o = obj(value, path)
        return PairingRead(
            status = lit(o["status"], "$path.status", PairingStatus.entries) { it.wire },
            deviceSession = opt(o["deviceSession"], "$path.deviceSession", ::deviceSessionOf),
        )
    }

    fun deviceView(value: JsonElement, path: String = "device"): DeviceView {
        val o = obj(value, path)
        return DeviceView(
            id = nonEmpty(o["id"], "$path.id"),
            name = nonEmpty(o["name"], "$path.name"),
            platform = lit(o["platform"], "$path.platform", DevicePlatform.entries) { it.wire },
            appVersion = nonEmpty(o["appVersion"], "$path.appVersion"),
            createdAt = long(o["createdAt"], "$path.createdAt"),
            lastSeenAt = nullable(o["lastSeenAt"], "$path.lastSeenAt", ::long),
        )
    }

    // ── relay ──

    /** `GET <relay>/machines`, read leniently as the phone's TypeScript source reads it:
     *  the relay is a separate deployment that may run ahead of or behind the phone, so
     *  only a row without an id (which cannot be reached) is a refusal. */
    fun relayMachines(value: JsonElement, path: String = "relay"): List<RelayMachine> {
        val o = obj(value, path)
        return arr(o["machines"], "$path.machines") { item, p ->
            val m = item as? JsonObject ?: fail("$p.id", "a non-empty string")
            val id = textOf(m["id"]).ifEmpty { fail("$p.id", "a non-empty string") }
            RelayMachine(
                id = id,
                name = textOf(m["name"]).ifEmpty { id },
                platform = MachinePlatform.of(textOf(m["platform"])),
                version = textOf(m["version"]),
                online = (m["online"] as? JsonPrimitive)?.let { it !is JsonNull && !it.isString && it.content == "true" } == true,
                lastSeen = lastSeenOf(m["lastSeen"]),
                direct = (m["direct"] as? JsonArray).orEmpty().mapNotNull { textOf((it as? JsonObject)?.get("url")).ifEmpty { null } },
            )
        }
    }

    private fun lastSeenOf(value: JsonElement?): Long? {
        if (finite(value) != null) return long(value, "lastSeen")
        val p = value as? JsonPrimitive ?: return null
        if (p is JsonNull || !p.isString) return null
        // Date.parse reads a full timestamp with its offset and a bare date as UTC midnight.
        return try {
            OffsetDateTime.parse(p.content).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                LocalDate.parse(p.content).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }

    // ── notify ──

    /** The key the APNs body carries the payload under, beside `aps`. */
    private const val APNS_KEY = "clave"

    /** The payload in a push's data, whichever platform delivered it, or null when nothing
     *  readable is there: a push that is not Clave's is ignored, never an error. FCM
     *  carries every field as a string (the actions comma-joined); APNs nests the payload
     *  under `clave`; a JSON string in either place is read too, up to a small depth so a
     *  self-nesting value cannot loop. */
    fun notificationPayload(data: JsonElement): NotificationPayload? = notificationPayloadOf(data, 0)

    /** FCM's `RemoteMessage.data`, as the Android SDK hands it over. */
    fun notificationPayload(data: Map<String, String>): NotificationPayload? =
        notificationPayloadOf(JsonObject(data.mapValues { JsonPrimitive(it.value) }), 0)

    private fun notificationPayloadOf(data: JsonElement?, depth: Int): NotificationPayload? {
        if (depth > 3 || data == null) return null
        if (data is JsonPrimitive && data !is JsonNull && data.isString) {
            val parsed = try {
                Json.parseToJsonElement(data.content)
            } catch (_: IllegalArgumentException) {
                return null
            }
            return notificationPayloadOf(parsed, depth + 1)
        }
        val o = data as? JsonObject ?: return null
        if (o.containsKey(APNS_KEY)) return notificationPayloadOf(o[APNS_KEY], depth + 1)
        val category = NotificationCategory.of(textOf(o["category"]).ifEmpty { null }) ?: return null
        val serverId = textOf(o["serverId"]).ifEmpty { return null }
        return NotificationPayload(
            category = category,
            serverId = serverId,
            serverName = textOf(o["serverName"]),
            sessionId = textOf(o["sessionId"]),
            sessionTitle = textOf(o["sessionTitle"]),
            workspaceName = textOf(o["workspaceName"]).ifEmpty { null },
            requestId = textOf(o["requestId"]).ifEmpty { null },
            text = textOf(o["text"]),
            actions = actionsOf(o["actions"]),
        )
    }

    /** Open is always offered: a notification with no button left would be a dead end. */
    private fun actionsOf(value: JsonElement?): List<NotificationAction> {
        val raw: List<String> = when (value) {
            is JsonArray -> value.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p !is JsonNull && p.isString }?.content }
            is JsonPrimitive -> if (value !is JsonNull && value.isString) value.content.split(',').map { it.trim() } else emptyList()
            else -> emptyList()
        }
        val actions = raw.mapNotNull { NotificationAction.of(it) }.distinct()
        return actions.ifEmpty { listOf(NotificationAction.Open) }
    }

    private fun textOf(value: JsonElement?): String =
        (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content ?: ""
}

/** JSON text to a frame; a text that is not JSON or not a frame is null, and the socket
 *  stays open: an unreadable frame is a later server's business, not the phone's crash. */
fun parseServerFrame(text: String): ServerFrame? = try {
    Decode.serverFrame(Json.parseToJsonElement(text))
} catch (_: DecodeError) {
    null
} catch (_: IllegalArgumentException) {
    null
}
