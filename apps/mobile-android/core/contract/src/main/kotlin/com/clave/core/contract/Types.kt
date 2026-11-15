/**
 * The shapes of the wire the phone speaks, mirrored from `@clave/contract` (the Effect
 * schemas under packages/contract/src/) as plain Kotlin, in the contract's order. The
 * contract itself runs on the server's TypeScript; the phone keeps this mirror, and the
 * decoders beside it (Decode.kt) are pinned to the contract by the samples the contract's
 * own schemas decode (src/test/resources/samples.json, lane C's vectors once announced).
 *
 * Two rules, the contract's own: a field the shape does not name is kept out of the typed
 * value (Effect's structs ignore excess properties, so does this), and a session event, a
 * server event or a push frame of a kind this file does not know is carried through by its
 * tag, since the reducer and the store ignore what they do not read. A session event is a
 * closed union on the server, but a newer server adds members to it before the phone learns
 * them; the phone carries those as [SessionEvent.Unknown] rather than refusing a whole page.
 *
 * Untyped payloads (a tool's input, a provider event) stay JsonElement; null means absent.
 */
package com.clave.core.contract

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

// ── sessions.ts ──

enum class AgentState(val wire: String) {
    Idle("idle"), Working("working"), Blocked("blocked"), Done("done"), Ended("ended");
    companion object { fun of(wire: String): AgentState? = entries.firstOrNull { it.wire == wire } }
}

enum class Transport(val wire: String) {
    Pty("pty"), Events("events");
    companion object { fun of(wire: String): Transport? = entries.firstOrNull { it.wire == wire } }
}

data class Session(
    val id: String,
    val provider: String,
    val transport: Transport,
    val cwd: String,
    val windowKey: String,
    /** The host record's workspace stamp, absent on an unstamped or older session. */
    val workspaceId: String? = null,
    val groupId: String? = null,
    val state: AgentState,
    val createdAt: Long,
    val adapterId: String,
    val title: String,
    val viewId: String? = null,
)

enum class FileDelivery(val wire: String) {
    Reference("reference"), Image("image"), Folder("folder");
    companion object { fun of(wire: String): FileDelivery? = entries.firstOrNull { it.wire == wire } }
}

sealed interface Attachment {
    val id: String
    val label: String?
}

data class FileAttachment(
    override val id: String,
    override val label: String? = null,
    val path: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val delivery: FileDelivery,
    /** A folder's top-level item count; folders only. */
    val entries: Long? = null,
) : Attachment

data class SessionAttachment(
    override val id: String,
    override val label: String? = null,
    val sessionId: String,
    val name: String,
    val agent: String,
    val cwd: String,
) : Attachment

/** An option named by id and label: a permission's choices, the permission modes. */
data class IdLabel(val id: String, val label: String)

data class AgentQuestionOption(val label: String, val description: String? = null)

/** The kinds of value a hosted form may ask for (`input-kinds.ts`); absent on a provider's
 *  own question, which is a choice among its options. */
enum class InputKind(val wire: String) {
    Text("text"), LongText("long-text"), Email("email"), Url("url"), GithubLogin("github-login"),
    Number("number"), Date("date"), Choice("choice"), File("file"), Folder("folder"), Link("link");
    companion object { fun of(wire: String): InputKind? = entries.firstOrNull { it.wire == wire } }
}

data class AgentQuestion(
    val id: String? = null,
    val question: String,
    val header: String? = null,
    val options: List<AgentQuestionOption>,
    val multiSelect: Boolean? = null,
    /** A hosted choice closed to its options: no own words. */
    val optionsOnly: Boolean? = null,
    /** A hosted form's field: the kind of value asked for, and the field's own words. */
    val kind: InputKind? = null,
    val hint: String? = null,
    val placeholder: String? = null,
    val default: String? = null,
    val optional: Boolean? = null,
    /** A `link` question: the address to open, and the words on the button that says the reader is back. */
    val url: String? = null,
    val confirm: String? = null,
    /** A `number` question's bounds. */
    val min: Double? = null,
    val max: Double? = null,
)

/** One answer of a form: a string, or the labels of a multi-select. */
sealed interface FormAnswer {
    data class Text(val value: String) : FormAnswer
    data class Choices(val values: List<String>) : FormAnswer
}

/** How far a permission reaches, as the session's host read it (PRDCT-4331). */
enum class RiskLevel(val wire: String) {
    Reads("reads"), Project("project"), Outside("outside"), Irreversible("irreversible");
    companion object { fun of(wire: String): RiskLevel? = entries.firstOrNull { it.wire == wire } }
}

/** Whether what a permission does matches what the person asked for. */
enum class AskedMatch(val wire: String) {
    Yes("yes"), No("no"), Unclear("unclear");
    companion object { fun of(wire: String): AskedMatch? = entries.firstOrNull { it.wire == wire } }
}

enum class BackgroundTaskKind(val wire: String) {
    Shell("shell"), Agent("agent"), Other("other");
    companion object { fun of(wire: String): BackgroundTaskKind? = entries.firstOrNull { it.wire == wire } }
}

data class BackgroundTask(
    val id: String,
    val kind: BackgroundTaskKind,
    val description: String,
    val command: String? = null,
    val toolUseId: String? = null,
    val startedAt: Long,
    val outputFile: String? = null,
    val model: String? = null,
)

/** What the phone writes to a session: a message (with the id the phone minted), an
 *  answer to a prompt, or an interrupt. */
sealed interface SessionWriteInput

/** The events of a session's stream, one per `type`. */
sealed interface SessionEvent {
    data class UserMessage(
        val clientMessageId: String? = null,
        val text: String,
        val attachments: List<Attachment>? = null,
        val parent: String? = null,
        /** The hosted form this message carries the answers of: its record row says it, no bubble. */
        val form: String? = null,
    ) : SessionEvent, SessionWriteInput

    data class AssistantText(val delta: String, val final: Boolean, val parent: String? = null) : SessionEvent

    data class ToolCall(val id: String, val name: String, val input: JsonElement? = null, val parent: String? = null) : SessionEvent

    data class ToolResult(val id: String, val output: JsonElement? = null, val error: Boolean? = null, val parent: String? = null) : SessionEvent

    data class PermissionRequest(
        val id: String,
        val description: String,
        val options: List<IdLabel>,
        val toolName: String? = null,
        val input: JsonElement? = null,
        val detail: String? = null,
        val questions: List<AgentQuestion>? = null,
    ) : SessionEvent

    data class StateChange(val state: AgentState) : SessionEvent

    data class SessionMeta(val model: String?, val providerSessionId: String?) : SessionEvent

    data class Effort(val effort: String?) : SessionEvent

    data class Error(val message: String, val fatal: Boolean) : SessionEvent

    data object TurnInterrupted : SessionEvent

    data class PermissionWithdrawn(val id: String) : SessionEvent

    /** A hosted form's answers changed under its card: the agent's fill, the approval's
     *  answers ([sent]), or the person's own typing kept by the server ([typed]). */
    data class PermissionUpdated(
        val id: String,
        val answers: Map<String, FormAnswer>,
        val sent: Boolean? = null,
        val typed: Boolean? = null,
        /** The agent's word under a field it could not fill, by the question's key. */
        val notes: Map<String, String>? = null,
    ) : SessionEvent

    /** What a permission request does, read where the session runs: the level, the plain
     *  sentence, whether it matches the person's ask, or why no sentence came. */
    data class PermissionExplained(
        val id: String,
        val level: RiskLevel? = null,
        val sentence: String? = null,
        val asked: AskedMatch? = null,
        val failed: String? = null,
    ) : SessionEvent

    data class ContextUsage(val used: Long, val window: Long?, val parent: String? = null) : SessionEvent

    data class SubagentModel(val parent: String, val model: String) : SessionEvent

    data class PermissionMode(val mode: String, val modes: List<IdLabel>) : SessionEvent

    data class BackgroundTasks(val tasks: List<BackgroundTask>) : SessionEvent

    data class ProviderEvent(val provider: String, val payload: JsonElement? = null) : SessionEvent

    /** A member this phone does not know yet (a newer server's), or a known one this phone
     *  could not read: carried by its type so a page and the live stream keep going, and so
     *  its position still counts. Nothing reads it. */
    data class Unknown(val type: String) : SessionEvent
}

/** [lists]: a hosted multi-select's labels by the question's key, sent as an array beside [answers]. */
data class PermissionResponse(
    val id: String,
    val optionId: String,
    val answers: Map<String, String>? = null,
    val lists: Map<String, List<String>>? = null,
) : SessionWriteInput

data object Interrupt : SessionWriteInput

/** Puts the session on another model; null hands it back to the provider's default.
 *  [remember]: whether the pick becomes the next chat's default (absent means yes). */
data class SetModel(val model: String?, val remember: Boolean? = null) : SessionWriteInput

/** A reasoning level as the provider spells it: a short lowercase word. */
data class SetEffort(val effort: String) : SessionWriteInput

data class SetPermissionMode(val mode: String) : SessionWriteInput

/** Stops one background task (a subagent, a background shell) by its id. */
data class StopTask(val taskId: String) : SessionWriteInput

// ── what a provider offers (GET /sessions/models, /sessions/commands) ──

data class EffortOption(val id: String, val label: String, val hint: String? = null)

data class ModelOption(
    val id: String,
    val label: String,
    val hint: String? = null,
    val resolved: String? = null,
    val efforts: List<EffortOption>? = null,
    val defaultEffort: String? = null,
)

/** A command the composer offers under "/": what it inserts. */
data class CommandOption(val name: String, val description: String? = null, val insert: String)

/** One frame of a session's stream as the wire carries it: terminal bytes stay base64 on
 *  the phone, which shows no terminal. */
sealed interface SessionStream {
    data class Pty(val data: String) : SessionStream
    data class Event(val event: SessionEvent, val position: SessionPosition? = null) : SessionStream
}

data class HistoryItem(val event: SessionEvent, val at: Long? = null)

data class HistoryPage(val items: List<HistoryItem>, val before: Long?)

/** Ordered session history, mirrored from @clave/contract/timeline. */
data class SessionPosition(val generation: String, val sequence: Long)

data class TimelineItem(val event: SessionEvent, val at: Long? = null, val position: SessionPosition)

data class TimelinePage(
    val items: List<TimelineItem>,
    val before: Long?,
    val cursor: SessionPosition,
    val truncated: Boolean,
)

enum class LauncherFamily(val wire: String) {
    Claude("claude"), Antigravity("antigravity"), Codex("codex"), Pi("pi");
    companion object { fun of(wire: String): LauncherFamily? = entries.firstOrNull { it.wire == wire } }
}

enum class PiThinkingLevel(val wire: String) {
    Off("off"), Minimal("minimal"), Low("low"), Medium("medium"), High("high"), Xhigh("xhigh"), Max("max");
    companion object { fun of(wire: String): PiThinkingLevel? = entries.firstOrNull { it.wire == wire } }
}

/** The status of a write by the id the phone minted (`GET /sessions/writes`): what the
 *  server knows of a send whose outcome the phone did not see. */
enum class WriteStatusKind(val wire: String) {
    Accepted("accepted"), Pending("pending"), Rejected("rejected"), Absent("absent"), Unknown("unknown");
    companion object { fun of(wire: String): WriteStatusKind? = entries.firstOrNull { it.wire == wire } }
}

data class WriteStatus(val status: WriteStatusKind, val at: Long? = null, val reason: String? = null)

/** POST /sessions/write acknowledgement. A pending duplicate has not landed yet. */
enum class WriteAnswerStatus(val wire: String) {
    Accepted("accepted"), Pending("pending");
    companion object { fun of(wire: String): WriteAnswerStatus? = entries.firstOrNull { it.wire == wire } }
}

data class WriteAnswer(val status: WriteAnswerStatus, val at: Long? = null)

// ── settings/launch-profiles.ts ──

data class PiOptions(val provider: String? = null, val model: String? = null, val thinking: PiThinkingLevel? = null)

data class LaunchProfileView(
    val id: String,
    val name: String,
    val family: LauncherFamily,
    val command: List<String>,
    val additionalArgs: List<String>,
    val builtIn: Boolean? = null,
    val sourceProfileId: String? = null,
    val pi: PiOptions? = null,
)

typealias FamilyDefaultsView = Map<LauncherFamily, String>

data class LaunchProfilePreferencesView(
    val customProfiles: List<LaunchProfileView>,
    val globalDefaults: FamilyDefaultsView,
    val workspaceOverrides: Map<String, FamilyDefaultsView>,
) { val version: Int get() = 1 }

/** What the phone sends to start a session: the family boolean, the profile by id and its
 *  full definition, the workspace the record is stamped with. */
data class SpawnOptions(
    val claudeMode: Boolean? = null,
    val antigravityMode: Boolean? = null,
    val codexMode: Boolean? = null,
    val piMode: Boolean? = null,
    val launchProfileId: String? = null,
    val launchProfile: LaunchProfileView? = null,
    val workspaceId: String? = null,
)

data class StartSessionInput(val cwd: String, val windowKey: String? = null, val options: SpawnOptions? = null)

data class SessionInfo(
    val id: String,
    val cwd: String,
    val folderName: String,
    val alive: Boolean,
    val claudeSessionId: String?,
    val piSessionId: String?,
    val launchProfileId: String? = null,
    val model: String? = null,
    val piProvider: String? = null,
    val piThinking: String? = null,
)

data class SessionCapabilities(val images: Boolean)

// ── settings/workspaces.ts ──

data class WorkspaceView(
    val id: String,
    val name: String,
    val rootDir: String,
    val profileFile: String?,
    val createdAt: Long,
)

data class WorkspaceStateView(
    val workspaces: List<WorkspaceView>,
    val lastActiveWorkspaceId: String?,
    val activeWorkspaceId: String?,
    /** Opaque to the phone, carried as it came. */
    val pins: JsonArray,
    val pinsMigrated: Boolean,
    val revision: Long,
    val instance: String,
) { val version: Int get() = 1 }

// ── requests.ts ──

sealed interface SecretAction {
    data class Run(val command: String, val cwd: String, val envVar: String) : SecretAction
    data class EnvFile(val file: String, val key: String) : SecretAction
}

enum class RequestKind(val wire: String) {
    Permission("permission"), Clarification("clarification"), Secret("secret");
    companion object { fun of(wire: String): RequestKind? = entries.firstOrNull { it.wire == wire } }
}

data class PendingRequest(
    val id: String,
    val sessionId: String,
    val kind: RequestKind,
    val description: String,
    val createdAt: Long,
    val providerRequestId: String? = null,
    val options: List<IdLabel>? = null,
    val questions: List<AgentQuestion>? = null,
    val secretQuestions: List<String>? = null,
    val toolName: String? = null,
    val detail: String? = null,
    val input: JsonElement? = null,
    val action: SecretAction? = null,
)

data class RequestSnapshot(val revision: Long, val pending: List<PendingRequest>)

sealed interface RequestResponse {
    data class Permission(val optionId: String, val answers: Map<String, String>? = null) : RequestResponse
    data class Clarification(val answers: Map<String, String>) : RequestResponse
    /** The value travels in the resolve body and nowhere else. */
    data class Secret(val value: String) : RequestResponse
    data object Dismiss : RequestResponse
}

data class ResolveRequestInput(val requestId: String, val response: RequestResponse)

data class ResolveOutcome(val accepted: Boolean)

// ── files.ts ──

data class FileLocation(val root: String, val path: String)

data class FileText(val content: String, val truncated: Boolean, val size: Long, val binary: Boolean)

// ── errors.ts and the domains' failures, as a 422 carries them ──

/** A refusal the server declared: the tag names the failure, the message is the sentence
 *  to show. `capability` is set on `CapabilityUnavailable`, `check` on `DevicePairingRefused`. */
data class ServerFailure(
    val tag: String,
    val message: String,
    val capability: String? = null,
    val code: String? = null,
    val id: String? = null,
    val check: String? = null,
)

// ── events.ts ──

sealed interface ServerEvent {
    data class RequestsChanged(val revision: Long) : ServerEvent
    data class SessionStateChanged(val id: String, val state: AgentState) : ServerEvent
    data class SessionTitleChanged(val id: String, val title: String) : ServerEvent
    data class SessionRenamed(val id: String, val name: String) : ServerEvent
    data class WorkspacesStateChanged(val workspaces: List<WorkspaceView>, val revision: Long, val instance: String) : ServerEvent
    /** Every other member of the server's union: carried by its tag, read by nobody here. */
    data class Unknown(val tag: String) : ServerEvent
}

data class ServerEventEnvelope(val id: String, val seq: Long, val at: Long, val event: ServerEvent)

// ── push.ts ──

object Push {
    const val PATH = "/push"
    const val PROTOCOL = 1
    const val HELLO_TIMEOUT_MS = 5_000L
    const val CLOSE_UNAUTHORIZED = 4001
    const val CLOSE_MALFORMED = 4002
    const val CLOSE_HELLO_TIMEOUT = 4008
    const val CLOSE_SERVER_STOPPING = 4010
    /** devices.ts: the close code a phone's socket gets when its session is revoked. */
    const val CLOSE_DEVICE_REVOKED = 4011
}

sealed interface ClientFrame {
    data class Hello(val token: String, val client: String? = null) : ClientFrame
    data class Subscribe(val sessionId: String) : ClientFrame
    data class Unsubscribe(val sessionId: String) : ClientFrame
    data object Ping : ClientFrame
}

sealed interface ServerFrame {
    data class Welcome(val serverId: String, val protocol: Int, val version: String? = null) : ServerFrame
    data class Subscribed(val sessionId: String, val session: Session) : ServerFrame
    data class Unsubscribed(val sessionId: String) : ServerFrame
    data class Stream(val sessionId: String, val stream: SessionStream) : ServerFrame
    data class Exit(val sessionId: String, val code: Int) : ServerFrame
    data class Event(val envelope: ServerEventEnvelope) : ServerFrame
    data class Error(val sessionId: String? = null, val message: String) : ServerFrame
    data object Pong : ServerFrame
    /** The desktop view requests and any frame a later server adds: ignored, by tag. */
    data class Unknown(val tag: String) : ServerFrame
}

// ── devices.ts ──

enum class DevicePlatform(val wire: String) {
    Ios("ios"), Android("android");
    companion object { fun of(wire: String): DevicePlatform? = entries.firstOrNull { it.wire == wire } }
}

/** How the phone names itself when it asks to pair. */
data class DeviceDescription(val name: String, val platform: DevicePlatform, val appVersion: String)

data class PairingTicket(val pairingId: String, val expiresAt: Long)

enum class PairingStatus(val wire: String) {
    Pending("pending"), Approved("approved"), Refused("refused"), Expired("expired");
    companion object { fun of(wire: String): PairingStatus? = entries.firstOrNull { it.wire == wire } }
}

/** The credential the server issues the phone, shown once. */
data class DeviceSession(val token: String, val deviceId: String, val serverId: String, val serverName: String)

data class PairingRead(val status: PairingStatus, val deviceSession: DeviceSession? = null)

/** The phone's own record on the server: never its tokens. */
data class DeviceView(
    val id: String,
    val name: String,
    val platform: DevicePlatform,
    val appVersion: String,
    val createdAt: Long,
    val lastSeenAt: Long?,
)

// ── relay.ts ──

enum class MachinePlatform(val wire: String) {
    Macos("macos"), Linux("linux"), Unknown("unknown");
    companion object { fun of(wire: String?): MachinePlatform = entries.firstOrNull { it.wire == wire } ?: Unknown }
}

/** One row of `GET /machines` at the relay. */
data class RelayMachine(
    val id: String,
    val name: String,
    val platform: MachinePlatform,
    val version: String,
    val online: Boolean,
    val lastSeen: Long?,
    val direct: List<String>,
)

// ── notify.ts ──

enum class NotificationCategory(val wire: String) {
    Question("question"), Permission("permission"), Secret("secret"), Finished("finished"),
    Failed("failed"), AccountLimit("account_limit"), Test("test");
    companion object { fun of(wire: String?): NotificationCategory? = entries.firstOrNull { it.wire == wire } }
}

enum class NotificationAction(val wire: String) {
    Allow("allow"), Deny("deny"), Reply("reply"), Open("open");
    companion object { fun of(wire: String?): NotificationAction? = entries.firstOrNull { it.wire == wire } }
}

/** What the server sends a paired phone, as the phone reads it off a push's data map. */
data class NotificationPayload(
    val category: NotificationCategory,
    val serverId: String,
    val serverName: String,
    val sessionId: String,
    val sessionTitle: String,
    val workspaceName: String? = null,
    val requestId: String? = null,
    val text: String,
    val actions: List<NotificationAction>,
)
