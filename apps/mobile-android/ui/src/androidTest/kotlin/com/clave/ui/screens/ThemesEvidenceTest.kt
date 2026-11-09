package com.clave.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.theme.ThemeName
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** A heading carrying exactly that text. */
fun headerTitle(title: String) = hasText(title) and SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)

/**
 * Asserts the pane header's title is on screen: of the headings with that text (a section
 * label can repeat it, "Machines" under "Machines"), the topmost one.
 */
fun ComposeContentTestRule.assertTitleShown(title: String) {
    val headings = onAllNodes(headerTitle(title), useUnmergedTree = true)
    val tops = headings.fetchSemanticsNodes().map { it.boundsInRoot.top }
    check(tops.isNotEmpty()) { "no heading \"$title\"" }
    headings[tops.indexOf(tops.min())].assertIsDisplayed()
}

/** Every screen in each of the four themes, each one screenshot for the reviewer. */
@RunWith(AndroidJUnit4::class)
class ThemesEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    private fun everyScreenIn(theme: ThemeName) {
        var screen by mutableStateOf(Screen.Machines)
        rule.setContent { EvidenceScreen(screen, theme, 1f) }
        Screen.entries.forEach { which ->
            screen = which
            rule.waitForIdle()
            rule.assertTitleShown(which.title())
            val shot = rule.onRoot().captureToImage().asAndroidBitmap()
            writeEvidence("${theme.id}-${which.name.lowercase()}", shot)
        }
    }

    @Test
    fun everyScreenInDark() = everyScreenIn(ThemeName.Dark)

    @Test
    fun everyScreenInLight() = everyScreenIn(ThemeName.Light)

    @Test
    fun everyScreenInCoffee() = everyScreenIn(ThemeName.Coffee)

    @Test
    fun everyScreenInCharcoal() = everyScreenIn(ThemeName.Charcoal)
}
