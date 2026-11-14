package com.clave.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.core.chat.Block
import com.clave.core.chat.Entry
import com.clave.core.chat.groupEntries
import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.SessionEvent
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.clave.ui.chat.ChatChoice
import com.clave.ui.chat.ChatControlsView
import com.clave.ui.chat.PromptView
import com.clave.core.contract.RiskLevel
import androidx.compose.ui.test.onNodeWithTag
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The chat's newer pieces: the status row and its pickers, and what follows in this file. */
@RunWith(AndroidJUnit4::class)
class ChatUxTest {
    @get:Rule
    val rule = createComposeRule()

    private val now = 1_800_000_000_000L

    private fun state(blocks: List<Block> = emptyList(), controls: ChatControlsView = ChatControlsView()) = ChatScreenState(
        title = "Fix the parser",
        machineName = "Studio",
        provider = "claude",
        blocks = blocks,
        status = SessionStatus.Idle,
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
        pendingRequests = 0,
        pendingLabel = null,
        expanded = emptySet(),
        now = now,
        controls = controls,
    )

    private fun show(
        state: ChatScreenState,
        actions: ChatActions = ChatActions(),
        onAnswer: (String, String, Map<String, String>) -> Unit = { _, _, _ -> },
    ) = rule.setContent {
        ClaveTheme(Appearance.Dark) {
            ChatScreen(
                state = state,
                onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = {},
                onSend = {}, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
                onRemoveAttachment = {}, onAnswer = onAnswer, onToggle = {},
                onResend = {}, onDiscard = {}, onLink = {},
                actions = actions,
            )
        }
    }

    private val controls = ChatControlsView(
        provider = "claude",
        model = "Opus 5.5",
        models = listOf(ChatChoice("claude-opus-5-5", "Opus 5.5", selected = true), ChatChoice("claude-haiku-4-5", "Haiku 4.5", "Fastest")),
        effort = "High",
        efforts = listOf(ChatChoice("low", "Low"), ChatChoice("high", "High", selected = true)),
        mode = "Ask",
        modes = listOf(ChatChoice("default", "Ask", selected = true), ChatChoice("plan", "Plan")),
        contextLabel = "250k/1M",
        contextRatio = 0.25f,
    )

    @Test
    fun theStatusRowShowsTheModelEffortModeAndContext() {
        show(state(controls = controls))
        rule.onNodeWithContentDescription("Model: Opus 5.5").assertIsDisplayed()
        rule.onNodeWithContentDescription("Effort: High").assertIsDisplayed()
        rule.onNodeWithContentDescription("Permission mode: Ask").assertIsDisplayed()
        rule.onNodeWithContentDescription("Context used: 250k/1M (25 %)").assertIsDisplayed()
        rule.onNodeWithContentDescription("claude").assertIsDisplayed()
    }

    @Test
    fun tappingTheModelOpensThePickerAndAPickIsSent() {
        val picked = mutableListOf<String>()
        var opened = 0
        show(state(controls = controls), ChatActions(onOpenControls = { opened++ }, onPickModel = { picked += it }))
        rule.onNodeWithContentDescription("Model: Opus 5.5").performClick()
        rule.onNodeWithText("Fastest").assertIsDisplayed()
        rule.onNodeWithText("Haiku 4.5").performClick()
        rule.runOnIdle {
            assertEquals(1, opened)
            assertEquals(listOf("claude-haiku-4-5"), picked)
        }
    }

    @Test
    fun aRefusedSwitchIsSaidAndCanBeDismissed() {
        var dismissed = 0
        show(state(controls = controls.copy(refusal = "A phone may not do this.")), ChatActions(onDismissRefusal = { dismissed++ }))
        rule.onNodeWithText("A phone may not do this.").assertIsDisplayed()
        rule.onNodeWithText("Dismiss").performClick()
        rule.runOnIdle { assertEquals(1, dismissed) }
    }

    @Test
    fun theWaitingPermissionIsAnsweredOnTheDockedCard() {
        val answers = mutableListOf<Pair<String, String>>()
        val prompt = PromptView(
            id = "p1",
            title = "Allow Claude to edit a.kt?",
            target = "/repo/a.kt",
            code = "- val x = 1\n+ val x = 2",
            language = "diff",
            level = RiskLevel.Project,
            levelLabel = "Changes files of the project",
            sentence = "Changes one constant.",
            options = listOf("deny" to "Deny", "allow" to "Allow"),
            count = 3,
        )
        show(state().copy(prompt = prompt), onAnswer = { id, option, _ -> answers += id to option })
        rule.onNodeWithTag("permission-prompt").assertIsDisplayed()
        rule.onNodeWithText("1 of 3 waiting").assertIsDisplayed()
        rule.onNodeWithText("Changes files of the project").assertIsDisplayed()
        rule.onNodeWithText("Changes one constant.").assertIsDisplayed()
        rule.onNodeWithText("+ val x = 2").assertIsDisplayed()
        rule.onNodeWithText("Allow").performClick()
        rule.runOnIdle { assertEquals(listOf("p1" to "allow"), answers) }
    }

    @Test
    fun anOpenedToolPreviewsItsOutputAndShowsAllOnATap() {
        val output = (1..20).joinToString("\n") { "line $it" }
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                com.clave.ui.chat.ToolRow(
                    summary = "Ran npm test",
                    hint = "Command run",
                    status = com.clave.ui.chat.ToolStatus.Complete,
                    expanded = true,
                    onToggle = {},
                    kind = "command",
                    detailedSections = listOf(
                        com.clave.ui.chat.ToolSectionView("Command", "npm test", "bash"),
                        com.clave.ui.chat.ToolSectionView("Output", output),
                        com.clave.ui.chat.ToolSectionView("a.kt", "- val x = 1\n+ val x = 2", "diff"),
                    ),
                    detail = "Exit 0",
                )
            }
        }
        rule.onNodeWithText("Exit 0").assertIsDisplayed()
        rule.onNodeWithText("$ npm test").assertIsDisplayed()
        rule.onNodeWithText("line 8").assertIsDisplayed()
        rule.onNodeWithText("line 9").assertDoesNotExist()
        rule.onNodeWithText("+ val x = 2").assertIsDisplayed()
        rule.onNodeWithText("Show all").performClick()
        rule.onNodeWithText("line 20").assertExists()
        rule.onNodeWithText("Show less").assertExists()
    }

    @Test
    fun eachTurnIsStampedAndAnAnswerCanBeCopied() {
        val blocks = groupEntries(
            listOf(
                Entry.User("Hello there", final = true, at = now - 5 * 60_000),
                Entry.Assistant("Done.", final = true, at = now - 60 * 60_000 * 3),
            ),
        )
        show(state(blocks))
        rule.onNodeWithText("5 min ago").assertIsDisplayed()
        rule.onNodeWithText("3 h ago", substring = true).assertExists()
        rule.onNodeWithContentDescription("Copy answer").assertIsDisplayed()
    }

    @Test
    fun scrolledUpTheChatOffersTheWayBackToTheLatest() {
        val blocks = groupEntries((0 until 40).map { Entry.User("Message $it", final = true, at = now) })
        show(state(blocks))
        rule.onNodeWithContentDescription("Jump to latest").assertDoesNotExist()
        rule.onNodeWithTag("chat-transcript").performScrollToIndex(30)
        rule.onNodeWithContentDescription("Jump to latest").performClick()
        rule.onNodeWithText("Message 39", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun aQuestionOffScreenIsPointedAtAndOneTapBringsIt() {
        val question = Entry.Permission(
            request = SessionEvent.PermissionRequest(
                id = "q1",
                description = "Which branch?",
                options = emptyList(),
                questions = listOf(AgentQuestion(id = "b", question = "Which branch should I use?", options = emptyList())),
            ),
            at = now,
        )
        val blocks = groupEntries(listOf(question) + (0 until 40).map { Entry.User("Message $it", final = true, at = now) })
        show(state(blocks))
        rule.onNodeWithTag("question-pill").performClick()
        rule.onNodeWithText("Which branch should I use?", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun backgroundWorkShowsAsCardsThatOpenToAStop() {
        val stopped = mutableListOf<String>()
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                com.clave.ui.chat.WorkCards(
                    listOf(
                        com.clave.ui.chat.WorkCardView("b1", "Dev server", shell = true, startedAt = now - 185_000, detail = "npm run dev"),
                        com.clave.ui.chat.WorkCardView("a1", "Review the parser", shell = false, startedAt = now - 5_000),
                    ),
                    onStop = { stopped += it },
                    clockStart = now,
                )
            }
        }
        rule.onNodeWithText("3m 5s").assertIsDisplayed()
        rule.onNodeWithText("5s").assertIsDisplayed()
        rule.onNodeWithContentDescription("Command: Dev server").performClick()
        rule.onNodeWithText("$ npm run dev").assertIsDisplayed()
        rule.onNodeWithText("Stop").performClick()
        rule.runOnIdle { assertEquals(listOf("b1"), stopped) }
    }

    @Test
    fun aSlashListsTheCommandsAndATapPutsOneInTheComposer() {
        var text by androidx.compose.runtime.mutableStateOf("/co")
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                ChatScreen(
                    state = state().copy(
                        composer = ChatComposerState(text = text, attachments = emptyList(), sending = false, deliveryMark = null),
                        slashCommands = if (text == "/co") listOf(com.clave.ui.chat.SlashCommandView("compact", "Compact the context", "/compact ")) else emptyList(),
                    ),
                    onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = { text = it },
                    onSend = {}, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
                    onRemoveAttachment = {}, onAnswer = { _, _, _ -> }, onToggle = {},
                    onResend = {}, onDiscard = {}, onLink = {},
                )
            }
        }
        rule.onNodeWithText("Compact the context").assertIsDisplayed()
        rule.onNodeWithText("/compact").performClick()
        rule.runOnIdle { assertEquals("/compact ", text) }
        rule.onNodeWithTag("slash-menu").assertDoesNotExist()
        rule.onNodeWithContentDescription("Message").performTextInput("now")
        rule.runOnIdle { assertEquals("/compact now", text) }
    }
}
