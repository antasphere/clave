package com.clave.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.chat.Composer
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.markdown.Markdown
import com.clave.ui.screens.AppearanceScreen
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.ClaveTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComponentsTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun aButtonClickFires() {
        var clicks = 0
        rule.setContent { ClaveTheme(Appearance.Dark) { ClaveButton("Pair", onClick = { clicks++ }) } }
        rule.onNodeWithText("Pair").performClick()
        rule.runOnIdle { assertEquals(1, clicks) }
    }

    @Test
    fun theComposerSendsOnlyWithText() {
        var text by mutableStateOf("")
        rule.setContent {
            ClaveTheme(Appearance.Light) {
                Composer(text = text, onTextChange = { text = it }, onSend = {}, onStop = {}, onAttach = {})
            }
        }
        rule.onNodeWithContentDescription("Send message").assertIsNotEnabled()
        rule.onNodeWithContentDescription("Message").performTextInput("hello")
        rule.onNodeWithContentDescription("Send message").assertIsEnabled()
    }

    @Test
    fun theAppearanceScreenListsTheFiveChoices() {
        rule.setContent {
            ClaveTheme(Appearance.Coffee) { AppearanceScreen(Appearance.Coffee, onAppearance = {}, onBack = {}) }
        }
        listOf("Match the system", "Dark", "Light", "Coffee", "Charcoal").forEach {
            rule.onNodeWithText(it, useUnmergedTree = true).assertExists()
        }
    }

    @Test
    fun markdownRendersAHeadingAndATableCell() {
        rule.setContent {
            ClaveTheme(Appearance.Charcoal) {
                Markdown("# Release notes\n\n| Build | State |\n|---|---|\n| 412 | green |")
            }
        }
        rule.onNodeWithText("Release notes", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithText("green", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun theBottomSlotRisesAboveAnImeInset() {
        // A fake inset stands in for the keyboard: the composer's bottom edge must rise by it.
        var insets by mutableStateOf(WindowInsets(0, 0, 0, 0))
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                Box(Modifier.size(360.dp, 640.dp)) {
                    ScreenScaffold(
                        header = { PaneHeader("Chat") },
                        insets = insets,
                        bottom = { Box(Modifier.fillMaxWidth().height(56.dp).testTag("composer")) },
                    ) {}
                }
            }
        }
        val before = rule.onNodeWithTag("composer").getBoundsInRoot()
        insets = WindowInsets(left = 0.dp, top = 0.dp, right = 0.dp, bottom = 300.dp)
        rule.waitForIdle()
        val after = rule.onNodeWithTag("composer").getBoundsInRoot()
        assertEquals(300f, (before.bottom - after.bottom).value, 1f)
        assertTrue(after.top < before.top)
    }

    @Test
    fun typingIntoTheComposerKeepsItOnScreen() {
        var text by mutableStateOf("")
        rule.setContent {
            ClaveTheme(Appearance.Dark) {
                ScreenScaffold(
                    header = { PaneHeader("Chat") },
                    bottom = {
                        Composer(
                            text = text,
                            onTextChange = { text = it },
                            onSend = {},
                            onStop = {},
                            onAttach = {},
                            modifier = Modifier.testTag("composer"),
                        )
                    },
                ) {}
            }
        }
        rule.onNodeWithContentDescription("Message").performClick()
        rule.onNodeWithContentDescription("Message").performTextInput("a long message")
        rule.onNodeWithTag("composer").assertIsDisplayed()
        rule.onNodeWithContentDescription("Send message").assertIsDisplayed()
    }
}
