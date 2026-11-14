package com.clave.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.core.chat.Entry
import com.clave.core.chat.blockKey
import com.clave.core.chat.groupEntries
import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AgentQuestionOption
import com.clave.core.contract.IdLabel
import com.clave.core.contract.InputKind
import com.clave.core.contract.RiskLevel
import com.clave.core.contract.SessionEvent
import com.clave.ui.chat.ChatChoice
import com.clave.ui.chat.ChatControlsView
import com.clave.ui.chat.PromptView
import com.clave.ui.chat.SlashCommandView
import com.clave.ui.chat.WorkCardView
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.ThemeName
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The chat's newer pieces in each desktop theme, one screenshot per scene for the reviewer. */
@RunWith(AndroidJUnit4::class)
class ChatUxEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private val controls = ChatControlsView(
        provider = "claude",
        model = "Opus 5.5",
        models = listOf(ChatChoice("claude-opus-5-5", "Opus 5.5", selected = true)),
        effort = "High",
        efforts = listOf(ChatChoice("high", "High", selected = true), ChatChoice("max", "Max")),
        mode = "Ask",
        modes = listOf(ChatChoice("default", "Ask", selected = true), ChatChoice("plan", "Plan")),
        contextLabel = "312k/1M",
        contextRatio = 0.31f,
    )

    private fun base() = ChatScreenState(
        title = "Fix the parser",
        machineName = "Studio",
        provider = "claude",
        blocks = emptyList(),
        status = SessionStatus.Working,
        reachability = Reachability.Reachable,
        loaded = true,
        hasOlder = false,
        loadingOlder = false,
        error = null,
        ended = false,
        exitCode = null,
        working = true,
        composer = ChatComposerState(text = "", attachments = emptyList(), sending = false, deliveryMark = null),
        unknownSend = null,
        pendingRequests = 1,
        pendingLabel = null,
        expanded = emptySet(),
        now = now,
        controls = controls,
    )

    private fun permissionScene(): ChatScreenState {
        val blocks = groupEntries(
            listOf(
                Entry.User("The parser drops the last token. Fix it and run the tests.", final = true, at = now - 6 * minute),
                Entry.Assistant("I found it: the loop stops one short. Fixing the bound now.\n\n```kotlin\nfor (i in 0 until tokens.size) {\n```", final = true, at = now - 5 * minute),
                Entry.Tool(id = "t1", name = "Read", complete = true, at = now - 5 * minute),
                Entry.Tool(id = "t2", name = "Grep", complete = true, at = now - 5 * minute),
                Entry.Permission(
                    request = SessionEvent.PermissionRequest(
                        id = "p1", description = "Edit", options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")), toolName = "Edit",
                    ),
                    at = now - minute,
                ),
            ),
        )
        return base().copy(
            blocks = blocks,
            prompt = PromptView(
                id = "p1",
                title = "Allow Claude to edit Parser.kt?",
                target = "/Users/valentin/clave/core/Parser.kt",
                code = "- for (i in 0 until tokens.size - 1) {\n+ for (i in 0 until tokens.size) {",
                language = "diff",
                level = RiskLevel.Project,
                levelLabel = "Changes files of the project",
                sentence = "Changes the loop bound in Parser.kt so the last token is read.",
                options = listOf("deny" to "Deny", "allow" to "Allow"),
                count = 2,
            ),
            work = listOf(
                WorkCardView("b1", "Dev server", shell = true, startedAt = now - 185_000, detail = "npm run dev"),
                WorkCardView("a1", "Review the parser tests", shell = false, startedAt = now - 42_000),
            ),
        )
    }

    private fun toolsScene(): ChatScreenState {
        val entries = listOf(
            Entry.User("Run the tests", final = true, at = now - 3 * minute),
            Entry.Tool(id = "t3", name = "Bash", complete = true, at = now - 2 * minute),
            Entry.Assistant("All 42 tests pass.", final = true, at = now - minute),
        )
        val blocks = groupEntries(entries)
        return base().copy(blocks = blocks, working = false, status = SessionStatus.Idle, pendingRequests = 0,
            composer = ChatComposerState(text = "/co", attachments = listOf("[Image #1] screen.png"), sending = false, deliveryMark = null),
            attachmentThumbnails = listOf(null),
            slashCommands = listOf(SlashCommandView("compact", "Compact the conversation's context", "/compact "), SlashCommandView("cost", "Show what this chat cost", "/cost ")),
            expanded = setOf(blockKey(blocks[1]) { 1 }),
        )
    }

    private fun formScene(): ChatScreenState {
        val question = Entry.Permission(
            request = SessionEvent.PermissionRequest(
                id = "f1",
                description = "Set up the review",
                options = listOf(IdLabel("answer", "Approve"), IdLabel("deny", "Skip")),
                toolName = "clave_request_input",
                questions = listOf(
                    AgentQuestion(id = "teams", question = "Which teams review it?", options = listOf(AgentQuestionOption("core"), AgentQuestionOption("web"), AgentQuestionOption("mobile")), kind = InputKind.Choice, multiSelect = true, hint = "Pick every team that owns a file in the change"),
                    AgentQuestion(id = "n", question = "How many reviewers?", options = emptyList(), kind = InputKind.Number, min = 1.0, max = 5.0),
                ),
            ),
            notes = mapOf("teams" to "You did not say; core owns Parser.kt"),
            at = now - minute,
        )
        return base().copy(blocks = groupEntries(listOf(Entry.User("Open the review", final = true, at = now - 2 * minute), question)), working = false)
    }

    @Test
    fun theChatInEveryTheme() {
        var theme by mutableStateOf(ThemeName.Dark)
        var scene by mutableStateOf(permissionScene())
        rule.setContent {
            ClaveTheme(theme) {
                ChatScreen(
                    state = scene,
                    onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = {},
                    onSend = {}, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
                    onRemoveAttachment = {}, onAnswer = { _, _, _ -> }, onToggle = {},
                    onResend = {}, onDiscard = {}, onLink = {},
                )
            }
        }
        val scenes = listOf("permission" to ::permissionScene, "tools" to ::toolsScene, "form" to ::formScene)
        for (each in ThemeName.entries) {
            theme = each
            for ((name, make) in scenes) {
                scene = make()
                rule.waitForIdle()
                writeEvidence("chatux-${each.id}-$name", rule.onRoot().captureToImage().asAndroidBitmap())
            }
        }
    }
}
