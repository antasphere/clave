package com.clave.ui.preview

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import com.clave.ui.chat.ApprovalCard
import com.clave.ui.chat.AssistantProse
import com.clave.ui.chat.Composer
import com.clave.ui.chat.PromptDock
import com.clave.ui.chat.ProviderMark
import com.clave.ui.chat.ToolRow
import com.clave.ui.chat.ToolStatus
import com.clave.ui.chat.UserTurn
import com.clave.core.chat.Entry
import com.clave.core.chat.groupEntries
import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AgentQuestionOption
import com.clave.core.contract.AgentState
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
import com.clave.ui.screens.AccountState
import com.clave.ui.screens.AppearanceScreen
import com.clave.ui.screens.ChatComposerState
import com.clave.ui.screens.ChatScreen
import com.clave.ui.screens.ChatScreenState
import com.clave.ui.screens.LaunchScreen
import com.clave.ui.screens.LaunchScreenState
import com.clave.ui.screens.MachineRow
import com.clave.ui.screens.MachinesScreen
import com.clave.ui.screens.MachinesScreenState
import com.clave.ui.screens.PairingScreen
import com.clave.ui.screens.RequestsScreen
import com.clave.ui.screens.RequestsScreenState
import com.clave.ui.screens.SessionRow
import com.clave.ui.screens.SessionsScreen
import com.clave.ui.screens.SessionSectionView
import com.clave.ui.screens.SessionsScreenState
import com.clave.ui.screens.WorkspaceChoice
import com.clave.ui.screens.UnknownSendView
import com.clave.ui.screens.WorkspacesScreen
import com.clave.ui.screens.WorkspacesScreenState
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.ThemeName

/** The phone-sized canvas every design-system preview draws on; the theme comes from the parameter. */
@Preview(name = "Clave", showBackground = true, widthDp = Metrics.PREVIEW_WIDTH_DP, heightDp = Metrics.PREVIEW_HEIGHT_DP)
annotation class ThemePreviews

/** The four themes, so each preview renders once per theme. */
class ThemeNameProvider : PreviewParameterProvider<ThemeName> {
    override val values: Sequence<ThemeName> = ThemeName.entries.asSequence()
}

private fun appearanceOf(theme: ThemeName): Appearance = Appearance.of(theme.id)

@ThemePreviews
@Composable
private fun AppearanceScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        AppearanceScreen(appearance = appearanceOf(theme), onAppearance = {}, onBack = {})
    }
}

@ThemePreviews
@Composable
private fun ChatPrimitivesPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Clave.colors.theme.surface0)
                .padding(Metrics.gutter),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
        ) {
            UserTurn("Run the tests and fix what fails.", attachmentLabels = listOf("failing-test.log"))
            ProviderMark("claude")
            AssistantProse(
                "Two failures, both in `parser.kt`:\n\n- the empty table\n- a trailing link\n\n| Test | Result |\n|:--|--:|\n| tables | failed |\n| links | failed |",
                streaming = true,
            )
            ToolRow("Ran", "./gradlew test", ToolStatus.Running, expanded = false, onToggle = {}, kind = "command")
            ToolRow(
                "Read",
                "parser.kt",
                ToolStatus.Failed,
                expanded = true,
                onToggle = {},
                failures = 1,
                kind = "read",
                sections = listOf("Output" to "File not found: parser.kt"),
            )
            ApprovalCard(
                title = "Allow Claude to run a command?",
                target = "./gradlew test",
                options = listOf("deny" to "Deny", "allow" to "Allow", "allow_always" to "Always allow"),
                onAnswer = { _, _ -> },
            )
            PromptDock(count = 2, label = "Claude is waiting for your approval", onOpen = {})
            Composer(
                text = "",
                onTextChange = {},
                onSend = {},
                onStop = {},
                onAttach = {},
                working = true,
                attachments = listOf("screenshot.png"),
                deliveryMark = "Delivered to the desktop",
            )
        }
    }
}

/** The preview's clock, fixed so the "seen" lines and the countdown never move. */
private const val PREVIEW_NOW = 1_800_000_000_000L

private val studio = Machine(
    id = "relay:studio",
    name = "Studio",
    platform = MachinePlatform.Macos,
    version = "1.2.3",
    online = true,
    lastSeen = PREVIEW_NOW,
    baseUrl = "https://studio.relay.example",
    pushUrl = "wss://studio.relay.example/push",
)

private val buildBox = studio.copy(
    id = "dev:build",
    name = "Build box",
    platform = MachinePlatform.Linux,
    online = false,
    lastSeen = PREVIEW_NOW - 3 * 60 * 60_000L,
)

@ThemePreviews
@Composable
private fun MachinesScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        MachinesScreen(
            state = MachinesScreenState(
                account = AccountState(
                    signedIn = true,
                    name = "Ada Lovelace",
                    email = "ada@example.com",
                    signingIn = false,
                    signingOut = false,
                    relayUrl = "https://relay.example",
                    lastFailure = null,
                ),
                machines = listOf(
                    MachineRow(studio, paired = true, main = true, reachability = Reachability.Reachable),
                    MachineRow(buildBox, paired = false, main = false, reachability = null),
                ),
                loading = false,
                error = null,
                now = PREVIEW_NOW,
            ),
            onSignIn = {}, onSignOut = {}, onRelayUrlChange = {}, onConnectRelay = {}, onRefresh = {},
            onOpen = {}, onPair = {}, onMakeMain = {}, onForget = {}, onAppearance = {},
        )
    }
}

@ThemePreviews
@Composable
private fun PairingScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        PairingScreen(
            machineName = "Studio",
            state = PairingState.Waiting(pairingId = "p1", expiresAt = PREVIEW_NOW + 245_000, polls = 3),
            now = PREVIEW_NOW,
            onCancel = {}, onRetry = {}, onDone = {}, onBack = {},
        )
    }
}

@ThemePreviews
@Composable
private fun WorkspacesScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        WorkspacesScreen(
            state = WorkspacesScreenState(
                machine = studio,
                machinesLoading = false,
                workspaces = listOf(
                    WorkspaceView("w1", "clave", "/Users/ada/code/clave", null, PREVIEW_NOW),
                    WorkspaceView("w2", "website", "/Users/ada/code/website", null, PREVIEW_NOW),
                ),
                error = null,
                reachability = Reachability.Reachable,
                pendingRequests = 2,
            ),
            onOpen = {}, onRequests = {}, onRefresh = {}, onBack = {},
        )
    }
}

private fun previewSession(id: String, title: String, transport: Transport, provider: String = "claude") = Session(
    id = id,
    provider = provider,
    transport = transport,
    cwd = "/Users/ada/code/clave",
    windowKey = "main",
    state = AgentState.Working,
    createdAt = PREVIEW_NOW,
    adapterId = provider,
    title = title,
)

@ThemePreviews
@Composable
private fun SessionsScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        SessionsScreen(
            state = SessionsScreenState(
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
                            SessionRow(previewSession("s1", "Fix the parser", Transport.Events), SessionStatus.Working),
                            SessionRow(previewSession("s2", "Review the release", Transport.Events, "codex"), SessionStatus.Waiting),
                        ),
                    ),
                    SessionSectionView(null, "Other sessions", null, false, listOf(SessionRow(previewSession("s3", "", Transport.Pty), SessionStatus.Idle))),
                ),
                error = null,
                reachability = Reachability.Reachable,
            ),
            onOpen = {}, onPickWorkspace = {}, onToggleGroup = { _, _ -> }, onRefresh = {}, onBack = {},
        )
    }
}

@ThemePreviews
@Composable
private fun LaunchScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        LaunchScreen(
            state = LaunchScreenState(
                workspaceName = "clave",
                targetName = "Build box",
                sourceName = "Studio",
                profiles = listOf(
                    LaunchProfileView("claude-chat", "Claude chat", LauncherFamily.Claude, listOf("claude"), emptyList()),
                    LaunchProfileView("codex", "Codex", LauncherFamily.Codex, listOf("codex", "--full-auto"), emptyList()),
                ),
                error = null,
                starting = null,
                refusal = null,
            ),
            onStart = {}, onBack = {},
        )
    }
}

@ThemePreviews
@Composable
private fun RequestsScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        RequestsScreen(
            state = RequestsScreenState(
                machineName = "Studio",
                loading = false,
                unavailable = false,
                error = null,
                pending = listOf(
                    PendingRequest(
                        id = "r1",
                        sessionId = "s1",
                        kind = RequestKind.Permission,
                        description = "Run ./gradlew test",
                        createdAt = PREVIEW_NOW,
                        options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow"), IdLabel("allow_always", "Always allow")),
                        toolName = "Bash",
                    ),
                    PendingRequest(
                        id = "r2",
                        sessionId = "s1",
                        kind = RequestKind.Clarification,
                        description = "Claude asks before it goes on",
                        createdAt = PREVIEW_NOW,
                        questions = listOf(
                            AgentQuestion(
                                question = "Which branch should the fix land on?",
                                header = "Branch",
                                options = listOf(AgentQuestionOption("main", "The release branch"), AgentQuestionOption("next")),
                            ),
                        ),
                    ),
                    PendingRequest(
                        id = "r3",
                        sessionId = "s1",
                        kind = RequestKind.Secret,
                        description = "The npm token to publish the package",
                        createdAt = PREVIEW_NOW,
                        action = SecretAction.EnvFile(file = ".env", key = "NPM_TOKEN"),
                    ),
                ),
                busy = emptySet(),
                notices = emptyMap(),
            ),
            onResolve = { _, _ -> }, onRefresh = {}, onBack = {},
        )
    }
}

@ThemePreviews
@Composable
private fun ChatScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    val entries = listOf(
        Entry.User("Run the tests and fix what fails.", final = true, at = PREVIEW_NOW),
        Entry.Tool(
            id = "t1",
            name = "Bash",
            complete = true,
            failed = true,
            at = PREVIEW_NOW,
        ),
        Entry.Assistant("Two failures, both in `parser.kt`. I will fix the **empty table** first.", final = false, at = PREVIEW_NOW),
        Entry.Permission(
            request = SessionEvent.PermissionRequest(
                id = "p1",
                description = "Edit parser.kt",
                options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")),
                toolName = "Edit",
            ),
            at = PREVIEW_NOW,
        ),
    )
    ClaveTheme(theme) {
        ChatScreen(
            state = ChatScreenState(
                title = "Fix the parser",
                machineName = "Studio",
                provider = "claude",
                blocks = groupEntries(entries),
                status = SessionStatus.Waiting,
                reachability = Reachability.Reachable,
                loaded = true,
                hasOlder = false,
                loadingOlder = false,
                error = null,
                ended = false,
                exitCode = null,
                working = true,
                composer = ChatComposerState(text = "", attachments = emptyList(), sending = false, deliveryMark = null),
                unknownSend = UnknownSendView("Also bump the version."),
                pendingRequests = 1,
                pendingLabel = "Claude is waiting for your approval",
                expanded = emptySet(),
                now = PREVIEW_NOW,
            ),
            onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = {}, onSend = {}, onStop = {},
            onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {}, onRemoveAttachment = {},
            onAnswer = { _, _, _ -> }, onToggle = {}, onResend = {}, onDiscard = {}, onLink = {},
        )
    }
}
