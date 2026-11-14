package com.clave.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.core.chat.Block
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
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.Session
import com.clave.core.contract.SessionEvent
import com.clave.core.contract.Transport
import com.clave.core.devices.EnrollmentFailure
import com.clave.core.devices.Machine
import com.clave.core.devices.PairingState
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreensTest {
    @get:Rule
    val rule = createComposeRule()

    private val now = 1_800_000_000_000L

    private fun machine(id: String, name: String, platform: MachinePlatform = MachinePlatform.Macos) =
        Machine(id, name, platform, "1.2.3", online = true, lastSeen = now, baseUrl = "https://$id.example", pushUrl = "wss://$id.example")

    private val signedOut = AccountState(
        signedIn = false, name = null, email = null, signingIn = false, signingOut = false, relayUrl = "", lastFailure = null,
    )

    private fun machinesScreen(
        state: MachinesScreenState,
        onSignIn: () -> Unit = {},
        onOpen: (Machine) -> Unit = {},
        onPair: (Machine) -> Unit = {},
        onMakeMain: (Machine) -> Unit = {},
    ) = rule.setContent {
        ClaveTheme(Appearance.Dark) {
            MachinesScreen(
                state = state,
                onSignIn = onSignIn, onSignOut = {}, onRelayUrlChange = {}, onConnectRelay = {}, onRefresh = {},
                onOpen = onOpen, onPair = onPair, onMakeMain = onMakeMain, onForget = null, onAppearance = {},
            )
        }
    }

    @Test
    fun signedOutMachinesOfferTheSignIn() {
        var signIns = 0
        machinesScreen(MachinesScreenState(signedOut, emptyList(), loading = false, error = null, now = now), onSignIn = { signIns++ })
        rule.onNodeWithText("Not signed in").assertIsDisplayed()
        rule.onNodeWithText("No machine yet").assertIsDisplayed()
        rule.onNodeWithText("Sign in with Antasphere").performClick()
        rule.runOnIdle { assertEquals(1, signIns) }
    }

    @Test
    fun signedInMachinesShowTheAccountTheRelayAndTheRows() {
        val studio = machine("relay:studio", "Studio")
        val build = machine("dev:build", "Build box", MachinePlatform.Linux)
        val opened = mutableListOf<Machine>()
        val paired = mutableListOf<Machine>()
        machinesScreen(
            MachinesScreenState(
                account = signedOut.copy(signedIn = true, name = "Ada Lovelace", email = "ada@example.com"),
                machines = listOf(
                    MachineRow(studio, paired = true, main = true, reachability = Reachability.Reachable),
                    MachineRow(build, paired = false, main = false, reachability = null),
                ),
                loading = false,
                error = null,
                now = now,
            ),
            onOpen = { opened += it },
            onPair = { paired += it },
        )
        rule.onNodeWithText("Ada Lovelace").assertIsDisplayed()
        rule.onNodeWithText("Signed in with Antasphere").assertIsDisplayed()
        rule.onNodeWithText("Sign out").assertIsDisplayed()
        rule.onNodeWithText("Team relay address").assertIsDisplayed()
        rule.onNodeWithText("https://your-team-relay.example", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Connect to team relay").assertIsDisplayed()
        rule.onNodeWithText("Reachable", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Main", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Online", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("macOS · Clave 1.2.3 · online", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Studio").performClick()
        rule.onNodeWithText("Build box").performClick()
        rule.runOnIdle {
            assertEquals(listOf(studio), opened)
            assertEquals(listOf(build), paired)
        }
    }

    @Test
    fun theMoreSheetMakesAMachineTheMainOne() {
        val build = machine("dev:build", "Build box", MachinePlatform.Linux)
        val made = mutableListOf<Machine>()
        machinesScreen(
            MachinesScreenState(signedOut, listOf(MachineRow(build, true, false, null)), loading = false, error = null, now = now),
            onMakeMain = { made += it },
        )
        rule.onNodeWithContentDescription("More about Build box").performClick()
        rule.onNodeWithText("Make it the main machine").performClick()
        rule.runOnIdle { assertEquals(listOf(build), made) }
    }

    @Test
    fun pairingWaitsInWordsAndCancels() {
        var cancels = 0
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                PairingScreen(
                    machineName = "Studio",
                    state = PairingState.Waiting("p1", expiresAt = now + 245_000, polls = 1),
                    now = now,
                    onCancel = { cancels++ }, onRetry = {}, onDone = {}, onBack = {},
                )
            }
        }
        rule.onNodeWithText("Pair with Studio").assertIsDisplayed()
        rule.onNodeWithText("Waiting for your approval. On Studio, open Settings → Mobile and approve this phone.").assertIsDisplayed()
        rule.onNodeWithText("Expires in 4:05").assertIsDisplayed()
        rule.onNodeWithText("Cancel").performClick()
        rule.runOnIdle { assertEquals(1, cancels) }
    }

    @Test
    fun aFailedPairingSaysTheMessageVerbatimAndRetries() {
        var retries = 0
        val message = "The server refused the ID token: its audience is not this server's."
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                PairingScreen(
                    machineName = "Studio",
                    state = PairingState.Failed(EnrollmentFailure.Refused, message, check = "audience"),
                    now = now,
                    onCancel = {}, onRetry = { retries++ }, onDone = {}, onBack = {},
                )
            }
        }
        rule.onNodeWithText(message, useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Check: audience").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.runOnIdle { assertEquals(1, retries) }
    }

    private fun session(id: String, title: String, transport: Transport = Transport.Events) = Session(
        id = id, provider = "claude", transport = transport, cwd = "/Users/ada/code/clave", windowKey = "main",
        state = AgentState.Idle, createdAt = now, adapterId = "claude", title = title,
    )

    @Test
    fun sessionsSayTheirStatesAndOnlyChatsOpen() {
        val opened = mutableListOf<Session>()
        val chats = listOf(
            SessionRow(session("s1", "Fix the parser"), SessionStatus.Working),
            SessionRow(session("s2", "Review"), SessionStatus.Waiting),
            SessionRow(session("s3", "Notes"), SessionStatus.Idle),
            SessionRow(session("s4", "Release"), SessionStatus.Finished),
        )
        val terminal = SessionRow(session("s5", "Dev server", Transport.Pty), SessionStatus.Error)
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                SessionsScreen(
                    state = SessionsScreenState(
                        machineName = "Studio",
                        workspaces = listOf(WorkspaceChoice("w1", "clave")),
                        workspaceId = "w1",
                        sections = listOf(SessionSectionView(null, "Other sessions", null, false, chats + terminal)),
                        error = null,
                        reachability = Reachability.Reachable,
                    ),
                    onOpen = { opened += it }, onPickWorkspace = {}, onToggleGroup = { _, _ -> }, onRefresh = {}, onBack = {},
                )
            }
        }
        rule.onNodeWithText("Fix the parser").assertIsDisplayed()
        listOf("Working", "Waiting for you", "Idle", "Finished", "Error").forEach {
            rule.onNodeWithText(it, useUnmergedTree = true).assertIsDisplayed()
        }
        rule.onNodeWithText("Terminal · clave · read-only on the phone", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Dev server", useUnmergedTree = true).performClick()
        rule.runOnIdle { assertTrue(opened.isEmpty()) }
        rule.onNodeWithText("Fix the parser").performClick()
        rule.runOnIdle { assertEquals(listOf(chats[0].session), opened) }
        rule.onAllNodesWithText("claude · clave", useUnmergedTree = true).assertCountEquals(4)
    }

    @Test
    fun sessionsShowTheDesktopGroupsAndFoldOne() {
        val toggled = mutableListOf<Pair<String, Boolean>>()
        val picked = mutableListOf<String?>()
        var collapsed by mutableStateOf(false)
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                SessionsScreen(
                    state = SessionsScreenState(
                        machineName = "Studio",
                        workspaces = listOf(WorkspaceChoice("w1", "clave"), WorkspaceChoice("w2", "notes")),
                        workspaceId = "w1",
                        sections = listOf(
                            SessionSectionView("g1", "Parser", "blue", collapsed, listOf(SessionRow(session("s1", "Fix the parser"), SessionStatus.Working))),
                            SessionSectionView(null, "Other sessions", null, false, listOf(SessionRow(session("s2", "Loose"), SessionStatus.Idle))),
                        ),
                        error = null,
                        reachability = Reachability.Reachable,
                    ),
                    onOpen = {},
                    onPickWorkspace = { picked += it },
                    onToggleGroup = { g, c -> toggled += g to c; collapsed = c },
                    onRefresh = {},
                    onBack = {},
                )
            }
        }
        rule.onNodeWithContentDescription("Parser, 1").assertIsDisplayed()
        rule.onNodeWithText("Fix the parser").assertIsDisplayed()
        rule.onNodeWithContentDescription("Parser, 1").performClick()
        rule.runOnIdle { assertEquals(listOf("g1" to true), toggled) }
        rule.onAllNodesWithText("Fix the parser").assertCountEquals(0)
        rule.onNodeWithText("Loose").assertIsDisplayed()
        rule.onNodeWithText("All").performClick()
        rule.onNodeWithText("notes").performClick()
        rule.runOnIdle { assertEquals(listOf(null, "w2"), picked) }
    }

    @Test
    fun homeSendsInOneTapAndOpensWhatItLists() {
        val sent = mutableListOf<String>()
        var text by mutableStateOf("")
        val opened = mutableListOf<String>()
        val went = mutableListOf<String>()
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                HomeScreen(
                    state = Samples.home().copy(composer = Samples.composer(text)),
                    onTextChange = { text = it },
                    onSend = { sent += text },
                    onPickWorkspace = {}, onPickProfile = {}, onMoreOptions = { went += "more" },
                    onOpenSession = { opened += it.id },
                    onAllSessions = { went += "all" },
                    onRequests = { went += "requests" },
                    onLimits = { went += "limits" },
                    onSettings = { went += "settings" },
                    onSwitchMachine = { went += "switch:$it" },
                    onRefresh = {},
                )
            }
        }
        // Send waits for words.
        rule.onNodeWithContentDescription("Send").performClick()
        rule.runOnIdle { assertTrue(sent.isEmpty()) }
        rule.onNodeWithTag(QUICK_COMPOSER_FIELD).performTextInput("Fix the flaky test")
        rule.onNodeWithContentDescription("Send").performClick()
        rule.runOnIdle { assertEquals(listOf("Fix the flaky test"), sent) }
        rule.onNodeWithText("2 requests waiting").performClick()
        rule.onNodeWithContentDescription("Personal: Exhausted · resets in 12 min").assertIsDisplayed()
        rule.onNodeWithContentDescription("Work: 58% left · resets in 2 h 10").performClick()
        rule.onNodeWithText("Fix the parser").performClick()
        rule.onNodeWithText("All sessions").performClick()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.onNodeWithContentDescription("Switch machine").performClick()
        rule.onNodeWithText("Build box").performClick()
        rule.runOnIdle {
            assertEquals(listOf("s1"), opened)
            assertEquals(listOf("requests", "limits", "all", "settings", "switch:build"), went)
        }
    }

    @Test
    fun homeHidesTheLimitsBehindALineOnAnOlderMac() {
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                HomeScreen(
                    state = Samples.home().copy(limits = null, limitsNote = "Update Clave on your Mac to see its limits here.", machines = emptyList(), pendingRequests = 0),
                    onTextChange = {}, onSend = {}, onPickWorkspace = {}, onPickProfile = {}, onMoreOptions = {},
                    onOpenSession = {}, onAllSessions = {}, onRequests = {}, onLimits = {}, onSettings = {}, onSwitchMachine = {}, onRefresh = {},
                )
            }
        }
        rule.onNodeWithText("Update Clave on your Mac to see its limits here.").assertIsDisplayed()
        rule.onAllNodesWithText("requests waiting", substring = true).assertCountEquals(0)
        rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Switch machine"))).assertCountEquals(0)
    }

    @Test
    fun settingsPicksADefaultAndSignsOut() {
        val workspaces = mutableListOf<String?>()
        var signedOut = false
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                SettingsScreen(
                    Samples.settings(),
                    onMachines = {}, onAccounts = {}, onDefaultWorkspace = { workspaces += it }, onDefaultProfile = {},
                    onAppearance = {}, onNotificationSettings = {}, onSignOut = { signedOut = true }, onBack = {},
                )
            }
        }
        rule.onNodeWithText("Default workspace").performClick()
        rule.onNodeWithText("notes").performClick()
        rule.runOnIdle { assertEquals(listOf<String?>("w2"), workspaces) }
        rule.onNodeWithText("1.42.0").assertExists()
        rule.onNodeWithText("Sign out").performScrollTo().performClick()
        rule.runOnIdle { assertTrue(signedOut) }
    }

    @Test
    fun accountsShowTheBarsAndTheExhaustedBadge() {
        rule.setContent {
            ClaveTheme(Appearance.Dark) { AccountsScreen(Samples.accounts(), onRefresh = {}, onBack = {}) }
        }
        rule.onNodeWithContentDescription("5-hour: 42% used · resets in 2 h 10").assertIsDisplayed()
        rule.onNodeWithText("Exhausted").assertIsDisplayed()
        rule.onNodeWithText("Fable: weekly cap reached, other models still run").assertIsDisplayed()
        rule.onNodeWithText("updated 4 min ago").assertIsDisplayed()
        rule.onNodeWithText("Not signed in").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun launchShowsTheRefusalVerbatimAndStartsAProfile() {
        val started = mutableListOf<LaunchProfileView>()
        val chat = LaunchProfileView("claude-chat", "Claude chat", LauncherFamily.Claude, listOf("claude"), emptyList())
        val refusal = "No launcher named claude is installed on Studio."
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                LaunchScreen(
                    state = LaunchScreenState("clave", "Studio", "Studio", listOf(chat), error = null, starting = null, refusal = refusal),
                    onStart = { started += it },
                    onBack = {},
                )
            }
        }
        rule.onNodeWithText(refusal, useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("in clave").assertIsDisplayed()
        rule.onNodeWithText("Runs on Studio · its own saved profiles").assertIsDisplayed()
        rule.onNodeWithText("Claude chat").performClick()
        rule.runOnIdle { assertEquals(listOf(chat), started) }
    }

    private fun requests(request: PendingRequest, resolved: MutableList<Pair<String, RequestResponse>>) = rule.setContent {
        ClaveTheme(Appearance.Dark) {
            RequestsScreen(
                state = RequestsScreenState(
                    "Studio", loading = false, unavailable = false, error = null,
                    pending = listOf(request), busy = emptySet(), notices = emptyMap(),
                ),
                onResolve = { id, response -> resolved += id to response },
                onRefresh = {},
                onBack = {},
            )
        }
    }

    @Test
    fun aPermissionIsAllowedWithItsOption() {
        val resolved = mutableListOf<Pair<String, RequestResponse>>()
        requests(
            PendingRequest(
                id = "r1", sessionId = "s1", kind = RequestKind.Permission, description = "Run ./gradlew test", createdAt = now,
                options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")), toolName = "Bash",
            ),
            resolved,
        )
        rule.onNodeWithText("Permission", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Allow").performClick()
        rule.runOnIdle { assertEquals(listOf("r1" to RequestResponse.Permission("allow", null)), resolved) }
    }

    @Test
    fun aClarificationIsNotSentUntilItIsAnswered() {
        val resolved = mutableListOf<Pair<String, RequestResponse>>()
        requests(
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
            resolved,
        )
        rule.onNodeWithText("Answer").performClick()
        rule.onNodeWithText("Answer \"Branch\" first.").assertIsDisplayed()
        rule.runOnIdle { assertTrue(resolved.isEmpty()) }
        rule.onNodeWithText("main").performClick()
        rule.onNodeWithText("Answer").performClick()
        rule.runOnIdle { assertEquals(listOf("r2" to RequestResponse.Clarification(mapOf("branch" to "main"))), resolved) }
    }

    @Test
    fun aSecretIsMaskedUntilShownAndSentAsTyped() {
        val resolved = mutableListOf<Pair<String, RequestResponse>>()
        requests(
            PendingRequest(id = "r3", sessionId = "s1", kind = RequestKind.Secret, description = "The npm token", createdAt = now),
            resolved,
        )
        val field = rule.onNodeWithContentDescription("The secret")
        field.performTextInput("s3cret")
        // What is drawn (the editable text) is masked; only the input keeps the value.
        field.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
        field.assert(shows("••••••"))
        rule.onNodeWithContentDescription("Show the secret").performClick()
        field.assert(shows("s3cret"))
        rule.onNodeWithContentDescription("Hide the secret").assertExists()
        rule.onNodeWithText("Send the secret").performClick()
        rule.runOnIdle { assertEquals(listOf("r3" to RequestResponse.Secret("s3cret")), resolved) }
    }

    /** The text a field draws, after its visual transformation. */
    private fun shows(text: String) = SemanticsMatcher("draws \"$text\"") {
        it.config.getOrNull(SemanticsProperties.EditableText)?.text == text
    }

    private fun chatState(blocks: List<Block>, text: String = "") = ChatScreenState(
        title = "Fix the parser",
        machineName = "Studio",
        provider = "claude",
        blocks = blocks,
        status = SessionStatus.Working,
        reachability = Reachability.Reachable,
        loaded = true,
        hasOlder = false,
        loadingOlder = false,
        error = null,
        ended = false,
        exitCode = null,
        working = false,
        composer = ChatComposerState(text = text, attachments = emptyList(), sending = false, deliveryMark = null),
        unknownSend = null,
        pendingRequests = 0,
        pendingLabel = null,
        expanded = emptySet(),
        now = now,
    )

    private class ChatEvents {
        var sends = 0
        var resends = 0
        var discards = 0
        var olders = 0
        val toggled = mutableListOf<String>()
        val answers = mutableListOf<Triple<String, String, Map<String, String>>>()
    }

    private fun chat(state: () -> ChatScreenState, events: ChatEvents, onText: (String) -> Unit = {}) = rule.setContent {
        ClaveTheme(Appearance.Dark) {
            ChatScreen(
                state = state(),
                onBack = {}, onRequests = {}, onLoadOlder = { events.olders++ }, onTextChange = onText,
                onSend = { events.sends++ }, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
                onRemoveAttachment = {},
                onAnswer = { id, option, answers -> events.answers += Triple(id, option, answers) },
                onToggle = { events.toggled += it },
                onResend = { events.resends++ }, onDiscard = { events.discards++ }, onLink = {},
            )
        }
    }

    @Test
    fun theChatRendersATurnAnAnswerAndTheStatus() {
        val blocks = groupEntries(
            listOf(
                Entry.User("Hello there", final = true, at = now),
                Entry.Assistant("Sure, **done**.", final = true, at = now),
            ),
        )
        chat({ chatState(blocks) }, ChatEvents())
        rule.onNodeWithText("Hello there", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Sure, done.", substring = true, useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Studio · Working", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun aToolRowTogglesByItsKeyAndAnApprovalAnswersWithItsIds() {
        val events = ChatEvents()
        val blocks = groupEntries(
            listOf(
                Entry.User("Read the parser", final = true, at = now),
                Entry.Tool(id = "t1", name = "Read", complete = true, at = now),
                Entry.Permission(
                    request = SessionEvent.PermissionRequest(
                        id = "p1",
                        description = "Edit parser.kt",
                        options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")),
                        toolName = "Edit",
                    ),
                    at = now,
                ),
            ),
        )
        chat({ chatState(blocks) }, events)
        rule.onNodeWithText("Read  File read", substring = true).performClick()
        rule.onNodeWithText("Allow").performClick()
        rule.runOnIdle {
            assertEquals(listOf("tools-t1"), events.toggled)
            assertEquals(listOf(Triple("p1", "allow", emptyMap<String, String>())), events.answers)
        }
    }

    @Test
    fun anUnknownDeliveryOffersBothWaysAndAnEndedSessionSaysSo() {
        val events = ChatEvents()
        val blocks = groupEntries(listOf(Entry.User("Hi", final = true, at = now)))
        chat({ chatState(blocks).copy(unknownSend = UnknownSendView("Also bump the version."), ended = true, exitCode = 0) }, events)
        rule.onNodeWithText("Delivery unknown").assertIsDisplayed()
        rule.onNodeWithText("Also bump the version.").assertIsDisplayed()
        rule.onNodeWithText("This session has ended (exit 0)", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("Send again (may duplicate)").performClick()
        rule.onNodeWithText("Discard").performClick()
        rule.runOnIdle {
            assertEquals(1, events.resends)
            assertEquals(1, events.discards)
        }
    }

    @Test
    fun typingAndTappingSendSends() {
        val events = ChatEvents()
        var text by mutableStateOf("")
        chat({ chatState(emptyList(), text) }, events, onText = { text = it })
        rule.onNodeWithText("Start a conversation").assertIsDisplayed()
        rule.onNodeWithContentDescription("Message").performTextInput("hello")
        rule.onNodeWithContentDescription("Send message").performClick()
        rule.runOnIdle { assertEquals(1, events.sends) }
    }

    @Test
    fun reachingTheOldestMessageLoadsTheOlderPageOnce() {
        val events = ChatEvents()
        val blocks = groupEntries((0 until 40).map { Entry.User("Message $it", final = true, at = now + it) })
        chat({ chatState(blocks).copy(hasOlder = true) }, events)
        rule.onNodeWithText("Message 39", useUnmergedTree = true).assertIsDisplayed()
        rule.runOnIdle { assertEquals(0, events.olders) }
        rule.onNodeWithTag("chat-transcript").performScrollToIndex(blocks.size - 1)
        rule.onNodeWithText("Message 0", useUnmergedTree = true).assertIsDisplayed()
        rule.runOnIdle { assertEquals(1, events.olders) }
    }
}
