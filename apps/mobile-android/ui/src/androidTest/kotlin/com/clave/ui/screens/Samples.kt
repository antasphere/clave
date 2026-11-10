package com.clave.ui.screens

import com.clave.core.chat.Entry
import com.clave.core.chat.groupEntries
import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AgentQuestionOption
import com.clave.core.contract.AgentState
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.IdLabel
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.MachinePlatform
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.SecretAction
import com.clave.core.contract.Session
import com.clave.core.contract.SessionEvent
import com.clave.core.contract.Transport
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.Machine
import com.clave.core.devices.PairingState
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus

/**
 * The sample states the evidence tests paint every screen with: synthetic names only
 * ("Ada Lovelace", "Studio", "Fix the parser"), nothing shaped like a token or an address.
 */
object Samples {
    const val now = 1_800_000_000_000L

    private fun machine(id: String, name: String, platform: MachinePlatform, online: Boolean) =
        Machine(id, name, platform, "1.2.3", online = online, lastSeen = now - 300_000, baseUrl = "https://$id.example", pushUrl = "wss://$id.example")

    val studio = machine("studio", "Studio", MachinePlatform.Macos, online = true)
    private val buildBox = machine("build", "Build box", MachinePlatform.Linux, online = false)

    fun machines() = MachinesScreenState(
        account = AccountState(
            signedIn = true, name = "Ada Lovelace", email = "ada@example.com", signingIn = false, signingOut = false,
            relayUrl = "", lastFailure = null,
        ),
        machines = listOf(
            MachineRow(studio, paired = true, main = true, reachability = Reachability.Reachable),
            MachineRow(buildBox, paired = false, main = false, reachability = null),
        ),
        loading = false,
        error = null,
        now = now,
    )

    /** Four minutes and five seconds left on the approval. */
    fun pairing(): PairingState = PairingState.Waiting("p1", expiresAt = now + 245_000, polls = 1)

    val workspaceList = listOf(
        WorkspaceView("w1", "clave", "/Users/ada/code/clave", profileFile = null, createdAt = now),
        WorkspaceView("w2", "notes", "/Users/ada/notes", profileFile = null, createdAt = now),
    )

    fun workspaces() = WorkspacesScreenState(
        machine = studio, machinesLoading = false, workspaces = workspaceList, error = null,
        reachability = Reachability.Reachable, pendingRequests = 2,
    )

    private fun session(id: String, title: String, transport: Transport = Transport.Events) = Session(
        id = id, provider = "claude", transport = transport, cwd = "/Users/ada/code/clave", windowKey = "main",
        state = AgentState.Idle, createdAt = now, adapterId = "claude", title = title,
    )

    fun sessions() = SessionsScreenState(
        workspaceName = "clave",
        machineName = "Studio",
        sessions = listOf(
            SessionRow(session("s1", "Fix the parser"), SessionStatus.Working),
            SessionRow(session("s2", "Review the release"), SessionStatus.Waiting),
            SessionRow(session("s3", "Notes"), SessionStatus.Idle),
            SessionRow(session("s4", "Release 411"), SessionStatus.Finished),
            SessionRow(session("s5", "Migrate the store"), SessionStatus.Error),
            SessionRow(session("s6", "Dev server", Transport.Pty), SessionStatus.Idle),
        ),
        error = null,
        reachability = Reachability.Reachable,
    )

    val profiles = listOf(
        LaunchProfileView("claude-chat", "Claude chat", LauncherFamily.Claude, listOf("claude"), emptyList()),
        LaunchProfileView("codex-chat", "Codex chat", LauncherFamily.Codex, listOf("codex"), emptyList()),
        LaunchProfileView("claude-terminal", "Claude in a terminal", LauncherFamily.Claude, listOf("claude"), emptyList()),
    )

    fun launch() = LaunchScreenState(
        workspaceName = "clave", targetName = "Studio", sourceName = "Studio", profiles = profiles, error = null,
        starting = null, refusal = "No launcher named pi is installed on Studio.",
    )

    fun requests() = RequestsScreenState(
        machineName = "Studio",
        loading = false,
        unavailable = false,
        error = null,
        pending = listOf(
            PendingRequest(
                id = "r1", sessionId = "s1", kind = RequestKind.Permission, description = "Run ./gradlew test", createdAt = now,
                options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")), toolName = "Bash",
            ),
            PendingRequest(
                id = "r2", sessionId = "s1", kind = RequestKind.Clarification, description = "Claude asks", createdAt = now,
                questions = listOf(
                    AgentQuestion(
                        id = "branch",
                        question = "Which branch should the fix land on?",
                        header = "Branch",
                        options = listOf(AgentQuestionOption("main", "The release branch"), AgentQuestionOption("next")),
                    ),
                ),
            ),
            PendingRequest(
                id = "r3", sessionId = "s1", kind = RequestKind.Secret, description = "The package registry key", createdAt = now,
                action = SecretAction.Run(command = "npm publish", cwd = "/Users/ada/code/clave", envVar = "NPM_KEY"),
            ),
        ),
        busy = emptySet(),
        notices = emptyMap(),
    )

    const val userText = "Can you summarise the release and show the numbers?"

    /** Every GFM shape the chat must draw: heading, link, fenced code, table, image, list. */
    val reply = """
        ## Release 412

        Build 412 shipped this morning; read [the changelog](https://clave.app/changelog) for every change.

        ```kotlin
        val build = 412
        ```

        | Build | State |
        |---|---|
        | 412 | green |
        | 411 | red |

        ![the dashboard](https://example.invalid/dashboard.png)

        - The parser handles nested fences
        - The composer keeps its draft

        The next build is planned for Thursday.
    """.trimIndent()

    fun chat(reply: String = this.reply) = ChatScreenState(
        title = "Fix the parser",
        machineName = "Studio",
        provider = "claude",
        blocks = groupEntries(
            listOf(
                Entry.User(
                    userText, final = true, at = now,
                    attachments = listOf(
                        FileAttachment(
                            id = "a1", path = "/Users/ada/code/clave/release-notes.md", name = "release-notes.md",
                            mimeType = "text/markdown", size = 2048, delivery = FileDelivery.Reference,
                        ),
                    ),
                ),
                Entry.Assistant(reply, final = true, at = now + 1),
                Entry.Tool(id = "t1", name = "Read", complete = true, at = now + 2),
                Entry.Permission(
                    request = SessionEvent.PermissionRequest(
                        id = "p1",
                        description = "Edit parser.kt",
                        options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")),
                        toolName = "Edit",
                    ),
                    at = now + 3,
                ),
            ),
        ),
        status = SessionStatus.Working,
        reachability = Reachability.Reachable,
        loaded = true,
        hasOlder = false,
        loadingOlder = false,
        error = null,
        ended = false,
        exitCode = null,
        working = false,
        composer = ChatComposerState(text = "", attachments = emptyList(), sending = false, deliveryMark = null),
        unknownSend = null,
        pendingRequests = 1,
        pendingLabel = null,
        expanded = emptySet(),
        now = now,
    )

}
