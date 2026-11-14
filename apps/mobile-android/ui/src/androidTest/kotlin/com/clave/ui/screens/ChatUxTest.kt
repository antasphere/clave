package com.clave.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.core.chat.Block
import com.clave.ui.chat.ChatChoice
import com.clave.ui.chat.ChatControlsView
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

    private fun show(state: ChatScreenState, actions: ChatActions = ChatActions()) = rule.setContent {
        ClaveTheme(Appearance.Dark) {
            ChatScreen(
                state = state,
                onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = {},
                onSend = {}, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
                onRemoveAttachment = {}, onAnswer = { _, _, _ -> }, onToggle = {},
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
}
