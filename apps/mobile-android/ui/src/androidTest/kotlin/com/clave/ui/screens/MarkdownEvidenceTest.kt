package com.clave.ui.screens

import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.LinkAnnotation
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.theme.ThemeName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * GitHub-flavoured Markdown in the chat: the agent's reply holds a heading, a link, a fenced
 * block, a table, an unreachable image and a list; the person's turn sits above it.
 */
@RunWith(AndroidJUnit4::class)
class MarkdownEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    private fun all(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::all)

    private fun text(node: SemanticsNode) =
        node.config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString(" ") { it.text }

    private fun theReplyIn(theme: ThemeName) {
        rule.setContent { EvidenceScreen(Screen.Chat, theme, 1f) }
        val transcript = rule.onNodeWithTag("chat-transcript")

        transcript.performScrollToNode(hasText(Samples.userText))
        rule.onNodeWithText(Samples.userText, useUnmergedTree = true).assertIsDisplayed()

        transcript.performScrollToNode(hasText("val build = 412"))
        rule.onNodeWithText("val build = 412", useUnmergedTree = true).assertIsDisplayed()
        listOf("Build", "State", "412", "green", "411", "red").forEach {
            rule.onNodeWithText(it, useUnmergedTree = true).assertExists()
        }
        listOf("The parser handles nested fences", "The composer keeps its draft").forEach {
            rule.onNodeWithText(it, useUnmergedTree = true).assertExists()
        }

        // The link: one text run carrying a URL link annotation over "the changelog".
        val paragraph = rule.onNodeWithText("the changelog", substring = true, useUnmergedTree = true).fetchSemanticsNode()
        val annotated = paragraph.config[SemanticsProperties.Text].first { it.text.contains("the changelog") }
        val links = annotated.getLinkAnnotations(0, annotated.length)
        assertEquals("one link in the paragraph", 1, links.size)
        val link = links.single()
        assertEquals("https://clave.app/changelog", (link.item as LinkAnnotation.Url).url)
        assertEquals("the changelog", annotated.text.substring(link.start, link.end))
        // And whether the link is a node of its own with a click action, or only the span.
        val unmerged = all(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())
        val clickableLinkNodes = unmerged.filter {
            SemanticsActions.OnClick in it.config && text(it).contains("the changelog")
        }
        val paragraphClickable = SemanticsActions.OnClick in paragraph.config

        // The image: its alt is the node's description; unreachable, the surface-100 placeholder holds its place.
        val image = rule.onNodeWithContentDescription("the dashboard", useUnmergedTree = true)
        image.assertExists()
        val imageNode = image.fetchSemanticsNode()
        assertTrue("the placeholder keeps a height", imageNode.boundsInRoot.height > 0f)

        transcript.performScrollToNode(hasText("Release 412"))
        rule.onNodeWithText("Release 412", useUnmergedTree = true).assertIsDisplayed()
        rule.waitForIdle()
        writeEvidence("gfm-${theme.id}", rule.onRoot().captureToImage().asAndroidBitmap())

        val notes = File(writeEvidenceDir(), "gfm-${theme.id}-semantics.txt")
        notes.writeText(
            buildString {
                appendLine("link: LinkAnnotation.Url ${link.item.let { (it as LinkAnnotation.Url).url }} over [${link.start},${link.end}) \"${annotated.text.substring(link.start, link.end)}\"")
                appendLine("link: paragraph node has OnClick = $paragraphClickable")
                appendLine("link: separate clickable nodes carrying the link text = ${clickableLinkNodes.size}")
                appendLine("link: paragraph node actions = ${paragraph.config.map { it.key.name }}")
                appendLine("image: contentDescription = ${imageNode.config.getOrNull(SemanticsProperties.ContentDescription)}")
                appendLine("image: role = ${imageNode.config.getOrNull(SemanticsProperties.Role)}, height px = ${imageNode.boundsInRoot.height}")
            },
        )
    }

    @Test
    fun theReplyInDark() = theReplyIn(ThemeName.Dark)

    @Test
    fun theReplyInLight() = theReplyIn(ThemeName.Light)
}
