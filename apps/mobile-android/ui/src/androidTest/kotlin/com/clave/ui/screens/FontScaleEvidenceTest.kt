package com.clave.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.theme.ThemeName
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** The screens at the largest system font scale: the title and the screen's main action survive. */
@RunWith(AndroidJUnit4::class)
class FontScaleEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    /** What a person comes to each screen to do. */
    private fun Screen.primaryAction(): SemanticsMatcher = when (this) {
        Screen.Machines -> hasText("Sign out")
        Screen.Pairing -> hasText("Cancel")
        Screen.Workspaces -> hasText(Samples.workspaceList.first().name)
        Screen.Sessions -> hasContentDescription("New session")
        Screen.Launch -> hasText(Samples.profiles.first().name)
        Screen.Requests -> hasText("Allow")
        Screen.Chat -> hasContentDescription("Send message")
        Screen.Appearance -> hasContentDescription("Dark", substring = true)
    }

    @Test
    fun everyScreenAtTwiceTheFontSize() {
        var screen by mutableStateOf(Screen.Machines)
        rule.setContent { EvidenceScreen(screen, ThemeName.Dark, 2f) }
        val notes = StringBuilder()
        Screen.entries.forEach { which ->
            screen = which
            rule.waitForIdle()
            rule.assertTitleShown(which.title())
            val action = rule.onNode(which.primaryAction(), useUnmergedTree = true)
            action.assertExists()
            val shown = runCatching { action.assertIsDisplayed() }.isSuccess
            notes.appendLine("$which: title shown, primary action present, on screen without scrolling = $shown")
            writeEvidence("fontscale2-${which.name.lowercase()}", rule.onRoot().captureToImage().asAndroidBitmap())
        }
        File(writeEvidenceDir(), "fontscale2.txt").writeText(notes.toString())
    }

    @Test
    fun theChatAtOnePointThree() {
        rule.setContent { EvidenceScreen(Screen.Chat, ThemeName.Dark, 1.3f) }
        rule.assertTitleShown(Screen.Chat.title())
        rule.onNode(hasContentDescription("Send message"), useUnmergedTree = true).assertIsDisplayed()
        writeEvidence("fontscale13-chat", rule.onRoot().captureToImage().asAndroidBitmap())
    }
}
