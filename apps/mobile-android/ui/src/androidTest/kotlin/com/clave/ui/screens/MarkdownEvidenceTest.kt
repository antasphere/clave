package com.clave.ui.screens

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.ThemeName
import java.io.File
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

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

    private fun descriptions(node: SemanticsNode) =
        node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().joinToString(" ")

    private fun theReplyIn(theme: ThemeName) {
        val opened = mutableListOf<String>()
        rule.setContent { EvidenceScreen(Screen.Chat, theme, 1f, onLink = { opened += it }) }
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

        // The link: one text run carrying a "url" string annotation over "the changelog".
        val paragraph = rule.onNodeWithText("the changelog", substring = true, useUnmergedTree = true).fetchSemanticsNode()
        val annotated = paragraph.config[SemanticsProperties.Text].first { it.text.contains("the changelog") }
        val links = annotated.getStringAnnotations("url", 0, annotated.length)
        assertEquals("one link in the paragraph", 1, links.size)
        val link = links.single()
        assertEquals("https://clave.app/changelog", link.item)
        assertEquals("the changelog", annotated.text.substring(link.start, link.end))
        assertTrue("the link span keeps no LinkAnnotation", annotated.getLinkAnnotations(0, annotated.length).isEmpty())

        // TalkBack reaches it from the paragraph: exactly one custom action, named by the link's words.
        val actions = paragraph.config.getOrNull(SemanticsActions.CustomActions).orEmpty()
        assertEquals("one custom action on the paragraph", 1, actions.size)
        val action = actions.single()
        assertEquals("Open the changelog", action.label)
        val handled = rule.runOnIdle { action.action() }
        assertTrue("the action reports it handled the link", handled)
        assertEquals("the action opens the link's URL", listOf("https://clave.app/changelog"), opened)

        // And no click target of its own: nothing in the paragraph carries a click action, and no
        // node of the whole chat carries one without words.
        val clickableInParagraph = all(paragraph).filter { SemanticsActions.OnClick in it.config }
        assertTrue("no click action inside the paragraph: ${clickableInParagraph.map { it.config }}", clickableInParagraph.isEmpty())
        val unlabelled = all(rule.onRoot().fetchSemanticsNode()).filter {
            SemanticsActions.OnClick in it.config && text(it).isBlank() && descriptions(it).isBlank()
        }
        assertTrue("no unlabelled click target in the chat: ${unlabelled.map { it.config }}", unlabelled.isEmpty())

        // The image: its alt is the node's description; unreachable, the placeholder holds its place and shows the alt.
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
                appendLine("link: string annotation \"url\" ${link.item} over [${link.start},${link.end}) \"${annotated.text.substring(link.start, link.end)}\"")
                appendLine("link: paragraph custom actions = ${actions.map { it.label }}, invoked -> $opened")
                appendLine("link: click actions inside the paragraph = ${clickableInParagraph.size}, unlabelled click targets in the chat = ${unlabelled.size}")
                appendLine("link: paragraph node keys = ${paragraph.config.map { it.key.name }}")
                appendLine("image: contentDescription = ${imageNode.config.getOrNull(SemanticsProperties.ContentDescription)}")
                appendLine("image: role = ${imageNode.config.getOrNull(SemanticsProperties.Role)}, height px = ${imageNode.boundsInRoot.height}")
            },
        )
    }

    @Test
    fun theReplyInDark() = theReplyIn(ThemeName.Dark)

    @Test
    fun theReplyInLight() = theReplyIn(ThemeName.Light)

    /**
     * An image decoded and drawn, not its fallback: a chart this test draws itself, written to the
     * test app's cache and read by Coil from that file, no network. Loaded, the image takes its own
     * height instead of the placeholder's, and its bars' colour is on the screen; the unreachable
     * image beside it keeps its placeholder.
     */
    private fun theDecodedImageIn(theme: ThemeName) {
        val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "evidence-build-times.png")
        val chart = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        Canvas(chart).apply {
            drawColor(android.graphics.Color.WHITE)
            val bar = Paint().apply { color = BAR }
            listOf(120f, 200f, 90f, 260f, 170f).forEachIndexed { i, h -> drawRect(60f + i * 110f, 320f - h, 140f + i * 110f, 320f, bar) }
        }
        file.outputStream().use { chart.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val reply = listOf(
            "The build times of the week, as a chart:",
            "![build times](${Uri.fromFile(file)})",
            "And the dashboard, out of reach here:",
            "![the dashboard](https://example.invalid/dashboard.png)",
        ).joinToString("\n\n")
        rule.setContent { EvidenceScreen(Screen.Chat, theme, 1f, chatReply = reply) }
        val placeholderPx = with(rule.density) { Metrics.imagePlaceholderHeight.toPx() }
        rule.onNodeWithTag("chat-transcript").performScrollToNode(hasContentDescription("build times"))
        rule.waitUntil("the local chart decoded and drawn at its own height", 10_000) {
            val nodes = rule.onAllNodesWithContentDescription("build times", useUnmergedTree = true).fetchSemanticsNodes()
            nodes.isNotEmpty() && nodes.all { abs(it.boundsInRoot.height - placeholderPx) > 1f }
        }
        rule.waitForIdle()
        val shot = rule.onRoot().captureToImage().asAndroidBitmap()
        val pixels = IntArray(shot.width * shot.height)
        shot.getPixels(pixels, 0, shot.width, 0, 0, shot.width, shot.height)
        val barPixels = pixels.count { it == BAR }
        assertTrue("the chart's bars are on the screen: $barPixels pixels of their colour", barPixels > 2_000)
        rule.onNodeWithContentDescription("the dashboard", useUnmergedTree = true).assertExists()
        writeEvidence("gfm-image-${theme.id}", shot)
        File(writeEvidenceDir(), "gfm-image-${theme.id}.txt").writeText("chart: file ${file.name}, bar colour pixels on screen = $barPixels, placeholder height px = $placeholderPx\n")
    }

    @Test
    fun aDecodedImageInDark() = theDecodedImageIn(ThemeName.Dark)

    @Test
    fun aDecodedImageInLight() = theDecodedImageIn(ThemeName.Light)

    private companion object {
        /** The chart's bars: a teal none of the four themes uses. */
        const val BAR = 0xFF00897B.toInt()
    }
}
