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
        machineName = "Studio",
        workspaces = listOf(WorkspaceChoice("w1", "clave"), WorkspaceChoice("w2", "notes")),
        workspaceId = "w1",
        sections = listOf(
            SessionSectionView(
                "g1",
                "Parser",
                "blue",
                collapsed = false,
                rows = listOf(
                    SessionRow(session("s1", "Fix the parser"), SessionStatus.Working),
                    SessionRow(session("s2", "Review the release"), SessionStatus.Waiting),
                ),
            ),
            SessionSectionView("g2", "Release", "green", collapsed = false, rows = listOf(SessionRow(session("s4", "Release 411"), SessionStatus.Finished))),
            SessionSectionView("g3", "Archive", "red", collapsed = true, rows = listOf(SessionRow(session("s7", "Old work"), SessionStatus.Finished))),
            SessionSectionView(
                null,
                "Other sessions",
                null,
                collapsed = false,
                rows = listOf(
                    SessionRow(session("s3", "Notes"), SessionStatus.Idle),
                    SessionRow(session("s5", "Migrate the store"), SessionStatus.Error),
                    SessionRow(session("s6", "Dev server", Transport.Pty), SessionStatus.Idle),
                ),
            ),
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


    // ── the shell ──

    val composerWorkspaces = listOf(WorkspaceChoice("w1", "clave"), WorkspaceChoice("w2", "notes"))
    val chatProfiles = listOf(ProfileChoice("claude-chat", "Claude (chat)", "claude"), ProfileChoice("codex-chat", "Codex (chat)", "codex"))

    fun composer(text: String = "") = QuickComposerState(
        text = text,
        workspace = composerWorkspaces.first(),
        profile = chatProfiles.first(),
        workspaces = composerWorkspaces,
        profiles = chatProfiles,
    )

    fun home() = HomeScreenState(
        machineName = "Studio",
        machines = listOf(MachineChoice("studio", "Studio"), MachineChoice("build", "Build box")),
        currentMachineId = "studio",
        reachability = Reachability.Reachable,
        composer = composer(),
        pendingRequests = 2,
        limits = listOf(
            LimitChip("claude", "Work", usedPercentage = 42.0, resetsAt = now + 2 * 3_600_000 + 600_000, exhausted = false),
            LimitChip("claude", "Personal", usedPercentage = 97.0, resetsAt = now + 720_000, exhausted = true),
            LimitChip("codex", "ChatGPT", usedPercentage = null, resetsAt = null, exhausted = false, note = "No usage read yet"),
        ),
        recent = listOf(
            RecentRow(session("s1", "Fix the parser"), SessionStatus.Working, "clave", "Parser"),
            RecentRow(session("s2", "Review the release"), SessionStatus.Waiting, "clave", null),
            RecentRow(session("s3", "Notes"), SessionStatus.Idle, "notes", null),
        ),
        now = now,
    )

    fun settings() = SettingsScreenState(
        machinesSummary = "Studio · 2 machines",
        defaultWorkspaceId = null,
        defaultProfileId = "claude-chat",
        workspaces = composerWorkspaces,
        profiles = chatProfiles,
        appearance = "System",
        notificationsAllowed = true,
        appVersion = "0.1.0 (1)",
        macVersion = "1.42.0",
        macName = "Studio",
        accountName = "Ada Lovelace",
        accountEmail = "ada@example.com",
        signingOut = false,
    )

    fun accounts() = AccountsScreenState(
        machineName = "Studio",
        providers = listOf(
            ProviderAccounts(
                "claude",
                "Claude",
                listOf(
                    AccountCard(
                        "a1",
                        "Work",
                        AccountStatus.SignedIn,
                        bars = listOf(
                            UsageBar("5-hour", 42.0, now + 2 * 3_600_000 + 600_000, BarInk.Normal),
                            UsageBar("Week, all models", 81.0, now + 3 * 86_400_000L, BarInk.Warning),
                            UsageBar("Week, Fable", 100.0, now + 86_400_000L, BarInk.Critical),
                        ),
                        exhausted = false,
                        familiesOut = listOf("Fable"),
                        fetchedAt = now - 240_000,
                    ),
                    AccountCard(
                        "a2",
                        "Personal",
                        AccountStatus.SignedIn,
                        bars = listOf(UsageBar("5-hour", 97.0, now + 720_000, BarInk.Critical)),
                        exhausted = true,
                        fetchedAt = now - 60_000,
                    ),
                ),
            ),
            ProviderAccounts(
                "codex",
                "Codex",
                listOf(AccountCard("c1", "ChatGPT", AccountStatus.NoCredential, bars = emptyList(), exhausted = false, readNote = "No usage read yet")),
            ),
        ),
        now = now,
    )
}
