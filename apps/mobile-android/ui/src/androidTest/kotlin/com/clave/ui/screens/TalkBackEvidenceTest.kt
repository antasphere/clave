package com.clave.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.theme.ThemeName
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * What TalkBack would say on every screen: no tap target without words, no field without a
 * name, and the pane header's title as the first heading a reader lands on.
 */
@RunWith(AndroidJUnit4::class)
class TalkBackEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    private fun all(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::all)

    private fun texts(node: SemanticsNode) =
        node.config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString(" ") { it.text }.trim()

    private fun descriptions(node: SemanticsNode) =
        node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().joinToString(" ").trim()

    /** The clipped bounds, then the unclipped position and size: an item scrolled off clips to nothing. */
    private fun where(node: SemanticsNode) =
        node.boundsInRoot.let { "[${it.left.toInt()},${it.top.toInt()} ${it.right.toInt()}x${it.bottom.toInt()}]" } +
            " (unclipped at ${node.positionInRoot.x.toInt()},${node.positionInRoot.y.toInt()} size ${node.size.width}x${node.size.height})"

    /** The nearest ancestor's words, to name an offender that has none of its own. */
    private fun within(node: SemanticsNode): String {
        var p = node.parent
        while (p != null) {
            val t = texts(p)
            if (t.isNotEmpty()) return t.take(80)
            p = p.parent
        }
        return ""
    }

    @Test
    fun everyScreenSpeaksItsControlsAndStartsAtItsTitle() {
        var screen by mutableStateOf(Screen.Machines)
        rule.setContent { EvidenceScreen(screen, ThemeName.Dark, 1f) }
        val offenders = mutableListOf<String>()
        val report = StringBuilder()
        Screen.entries.forEach { which ->
            screen = which
            rule.waitForIdle()
            val merged = all(rule.onRoot().fetchSemanticsNode())
            val unmerged = all(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())

            // (a) A tap target with neither text (its own or merged) nor a description.
            merged.filter { SemanticsActions.OnClick in it.config }.forEach { n ->
                if (texts(n).isEmpty() && descriptions(n).isEmpty()) {
                    offenders += "$which: click target without a label at ${where(n)} (role ${n.config.getOrNull(SemanticsProperties.Role)}," +
                        " keys ${n.config.map { it.key.name }}, inside \"${within(n)}\")"
                }
            }

            // (b) A field with no description and no visible words (its placeholder counts) in it.
            unmerged.filter { SemanticsActions.SetText in it.config }.forEach { n ->
                val ownWords = descriptions(n).isNotEmpty() || texts(n).isNotEmpty()
                val inside = all(n).drop(1).any { texts(it).isNotEmpty() || descriptions(it).isNotEmpty() }
                val label = when {
                    descriptions(n).isNotEmpty() -> "description \"${descriptions(n)}\""
                    texts(n).isNotEmpty() -> "text \"${texts(n)}\""
                    inside -> "inner text \"${all(n).drop(1).map(::texts).filter(String::isNotEmpty).joinToString()}\""
                    else -> "none"
                }
                report.appendLine("$which: field at ${where(n)} named by $label")
                if (!ownWords && !inside) offenders += "$which: text field without a label at ${where(n)}"
            }

            // (c) The first heading in reading order is the pane header's title.
            val headings = unmerged
                .filter { SemanticsProperties.Heading in it.config }
                .sortedWith(compareBy({ it.boundsInRoot.top }, { it.boundsInRoot.left }))
            report.appendLine("$which: headings in order ${headings.map { "\"${texts(it)}\"" }}")
            val first = headings.firstOrNull()
            if (first == null || texts(first) != which.title()) {
                offenders += "$which: first heading is ${first?.let { "\"${texts(it)}\" at ${where(it)}" } ?: "missing"}, not \"${which.title()}\""
            }

            merged.filter { SemanticsActions.OnClick in it.config }.forEach { n ->
                report.appendLine("$which: click target ${where(n)} text \"${texts(n)}\" description \"${descriptions(n)}\"")
            }
        }
        // The chat again with the reply's link scrolled into view: an offender clipped to nothing
        // above the fold is named here with real bounds.
        screen = Screen.Chat
        rule.waitForIdle()
        rule.onNodeWithTag("chat-transcript").performScrollToNode(hasText("the changelog", substring = true))
        rule.waitForIdle()
        all(rule.onRoot().fetchSemanticsNode())
            .filter { SemanticsActions.OnClick in it.config && texts(it).isEmpty() && descriptions(it).isEmpty() }
            .forEach { report.appendLine("Chat, unlabelled click target after the scroll: ${where(it)} inside \"${within(it)}\"") }
        File(writeEvidenceDir(), "talkback-dark.txt").writeText(report.toString() + "\noffenders:\n" + offenders.joinToString("\n"))
        assertTrue("TalkBack offenders:\n" + offenders.joinToString("\n"), offenders.isEmpty())
    }
}
