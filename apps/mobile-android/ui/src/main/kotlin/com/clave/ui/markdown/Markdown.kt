package com.clave.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import coil3.compose.SubcomposeAsyncImage
import com.clave.ui.components.Rule
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveColors
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import kotlin.math.max
import kotlin.math.min

private const val CODE_TAG = "clave.code"

/** The tag of a link's range in a prose text; the annotation's item is the URL it opens. */
internal const val URL_TAG = "url"
private const val CODE_PAD = " "

/**
 * The assistant's Markdown as `.chat-prose` draws it: paragraphs at 14 with a 1.5 line,
 * headings in the semibold at three sizes, inline code in the mono face on surface-100,
 * fences and tables scrolling sideways rather than wrapping code, links in the accent.
 * A link opens through [onLink]; without one the links are styled but inert.
 */
@Composable
fun Markdown(
    text: String,
    modifier: Modifier = Modifier,
    onLink: ((String) -> Unit)? = null,
) {
    val blocks = remember(text) { parseMarkdown(text) }
    SelectionContainer(modifier) {
        Blocks(blocks, Clave.colors.theme.textPrimary, onLink)
    }
}

@Composable
private fun Blocks(blocks: List<MdBlock>, ink: Color, onLink: ((String) -> Unit)?, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Metrics.space(3))) {
        blocks.forEach { Block(it, ink, onLink) }
    }
}

private val bodyStyle: TextStyle
    get() = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.proseLineHeight)

@Composable
private fun Block(block: MdBlock, ink: Color, onLink: ((String) -> Unit)?) {
    val c = Clave.colors
    when (block) {
        is MdBlock.Paragraph -> Paragraph(block.inlines, ink, onLink)
        is MdBlock.Heading -> {
            val size = when (block.level) {
                1 -> Metrics.textLg
                2 -> Metrics.textBase
                else -> Metrics.textSm
            }
            ProseText(
                block.inlines,
                ClaveTypography.type(size, FontWeight.SemiBold, Metrics.headingLineHeight).copy(color = ink),
                onLink,
                Modifier.padding(top = Metrics.space(1)),
            )
        }
        is MdBlock.CodeBlock -> CodeBlockView(block.code, block.language)
        is MdBlock.Html -> CodeBlockView(block.raw, null)
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(Metrics.quoteBar).fillMaxHeight().background(c.theme.border))
            Blocks(block.blocks, c.theme.textSecondary, onLink, Modifier.padding(start = Metrics.space(3)))
        }
        is MdBlock.BulletList -> ListView(block.items, ink, onLink) { _ -> "•" }
        is MdBlock.OrderedList -> ListView(block.items, ink, onLink) { i -> "${block.start + i}." }
        is MdBlock.Table -> TableView(block, onLink)
        MdBlock.ThematicBreak -> Rule()
        is MdBlock.Image -> MarkdownImage(block.url, block.alt)
    }
}

/** Inline images break the run: each sits on its own line between the text around it. */
@Composable
private fun Paragraph(inlines: List<MdInline>, ink: Color, onLink: ((String) -> Unit)?) {
    if (inlines.none { it is MdInline.Image }) {
        ProseText(inlines, bodyStyle.copy(color = ink), onLink)
        return
    }
    // Text runs and images alternate; each run is one text, each image its own line.
    val groups = mutableListOf<List<MdInline>>()
    for (inline in inlines) {
        val last = groups.lastOrNull()
        if (inline is MdInline.Image || last == null || last.singleOrNull() is MdInline.Image) groups += listOf(inline)
        else groups[groups.lastIndex] = last + inline
    }
    Column(verticalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
        groups.forEach { group ->
            val image = group.singleOrNull() as? MdInline.Image
            if (image != null) MarkdownImage(image.url, image.alt)
            else ProseText(group, bodyStyle.copy(color = ink), onLink)
        }
    }
}

/**
 * A run of inlines as one text, with the inline code's rounded fill drawn behind it.
 *
 * Its links are spans of this one text, never nodes of their own: a tap is mapped to the
 * character under it and opens the URL annotated there, and each link is offered to TalkBack
 * as a custom action of the text, "Open <the link's words>", so no click target exists
 * without words. Without [onLink] the links are styled only: no tap, no action.
 */
@Composable
private fun ProseText(
    inlines: List<MdInline>,
    style: TextStyle,
    onLink: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val colors = Clave.colors
    val annotated = remember(inlines, colors, style) { annotate(inlines, colors, style) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val codeFill = colors.theme.surface100
    val links = remember(annotated) { annotated.getStringAnnotations(URL_TAG, 0, annotated.length) }
    val linking = if (onLink != null && links.isNotEmpty()) {
        Modifier
            .pointerInput(annotated, onLink) {
                detectTapGestures { offset ->
                    val l = layout ?: return@detectTapGestures
                    if (l.layoutInput.text != annotated) return@detectTapGestures
                    val at = l.getOffsetForPosition(offset)
                    annotated.getStringAnnotations(URL_TAG, at, at + 1).firstOrNull()?.let { onLink(it.item) }
                }
            }
            .semantics {
                customActions = links.map { link ->
                    CustomAccessibilityAction("Open ${annotated.text.substring(link.start, link.end)}") {
                        onLink(link.item)
                        true
                    }
                }
            }
    } else {
        Modifier
    }
    BasicText(
        text = annotated,
        style = style,
        onTextLayout = { layout = it },
        modifier = modifier.then(linking).drawBehind {
            val l = layout ?: return@drawBehind
            if (l.layoutInput.text != annotated) return@drawBehind
            val radius = CornerRadius(Metrics.radiusSm.toPx())
            annotated.getStringAnnotations(CODE_TAG, 0, annotated.length).forEach { span ->
                if (span.end <= span.start) return@forEach
                val firstLine = l.getLineForOffset(span.start)
                val lastLine = l.getLineForOffset(span.end - 1)
                for (line in firstLine..lastLine) {
                    val start = max(span.start, l.getLineStart(line))
                    val end = min(span.end, l.getLineEnd(line, visibleEnd = true))
                    if (end <= start) continue
                    val left = l.getBoundingBox(start).left
                    val right = l.getBoundingBox(end - 1).right
                    val top = l.getLineTop(line)
                    val bottom = l.getLineBottom(line)
                    drawRoundRect(
                        color = codeFill,
                        topLeft = Offset(min(left, right), top),
                        size = Size(kotlin.math.abs(right - left), bottom - top),
                        cornerRadius = radius,
                    )
                }
            }
        },
    )
}

/** The inlines as one styled string: code ranges tagged [CODE_TAG], link ranges tagged [URL_TAG] with their URL. */
private fun annotate(
    inlines: List<MdInline>,
    colors: ClaveColors,
    base: TextStyle,
): AnnotatedString = buildAnnotatedString {
    val linkStyle = SpanStyle(color = colors.theme.accent, textDecoration = TextDecoration.Underline)
    fun append(items: List<MdInline>) {
        items.forEach { inline ->
            when (inline) {
                is MdInline.Text -> append(inline.text)
                is MdInline.Strong -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inline.children) }
                is MdInline.Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inline.children) }
                is MdInline.Strikethrough ->
                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(inline.children) }
                is MdInline.Code -> {
                    val start = length
                    withStyle(SpanStyle(fontFamily = ClaveTypography.mono, fontSize = Metrics.codeSize)) {
                        append(CODE_PAD + inline.code + CODE_PAD)
                    }
                    addStringAnnotation(CODE_TAG, "", start, length)
                }
                is MdInline.Link -> {
                    val url = inline.url
                    val start = length
                    withStyle(linkStyle) {
                        if (inline.children.isEmpty()) append(url) else append(inline.children)
                    }
                    addStringAnnotation(URL_TAG, url, start, length)
                }
                MdInline.SoftBreak -> append(' ')
                MdInline.HardBreak -> append('\n')
                is MdInline.Image -> withStyle(SpanStyle(color = colors.theme.textSecondary)) {
                    append(inline.alt.ifEmpty { inline.url })
                }
            }
        }
    }
    append(inlines)
    if (base.color == Color.Unspecified) addStyle(SpanStyle(color = colors.theme.textPrimary), 0, length)
}

/** Lists with a hanging indent: the marker in its own column, the item's blocks beside it. */
@Composable
private fun ListView(items: List<List<MdBlock>>, ink: Color, onLink: ((String) -> Unit)?, marker: (Int) -> String) {
    val t = Clave.colors.theme
    Column(Modifier.padding(start = Metrics.space(1)), verticalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
        items.forEachIndexed { index, item ->
            Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                BasicText(
                    text = marker(index),
                    modifier = Modifier.width(Metrics.listMarkerWidth),
                    style = bodyStyle.copy(color = t.textSecondary, textAlign = TextAlign.End),
                )
                Blocks(item, ink, onLink, Modifier.weight(1f))
            }
        }
    }
}

/** `.chat-prose pre`: mono on surface-100, the language above it, scrolling sideways. */
@Composable
fun CodeBlockView(code: String, language: String?, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    val clipboard = LocalClipboardManager.current
    Box(modifier.fillMaxWidth().clip(RoundedCornerShape(Metrics.radiusLg)).background(t.surface100)) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(Metrics.codePadding),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(1)),
        ) {
            // The language's line leaves room for the copy button; without one the code does.
            BasicText(language.orEmpty(), style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary))
            Box(Modifier.horizontalScroll(rememberScrollState())) {
                BasicText(code, style = ClaveTypography.mono(Metrics.codeSize).copy(color = t.textPrimary), softWrap = false)
            }
        }
        ClaveIconButton(
            icon = ClaveIcon.ClipboardDocument,
            onClick = { clipboard.setText(AnnotatedString(code)) },
            contentDescription = "Copy code",
            size = Metrics.controlXsHeight,
            modifier = Modifier.align(Alignment.TopEnd).padding(Metrics.space(1)),
        )
    }
}

/** Where the grid's rules fall, written by the measure pass and read by the draw pass after it. */
private class GridLines {
    var xs: IntArray = IntArray(0)
    var ys: IntArray = IntArray(0)
}

/** A table as a grid: each column as wide as its widest cell (capped), rules between cells. */
@Composable
private fun TableView(table: MdBlock.Table, onLink: ((String) -> Unit)?) {
    val t = Clave.colors.theme
    val columns = max(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    if (columns == 0) return
    val allRows = listOf(table.header) + table.rows
    val ruleColor = t.rule
    val grid = remember { GridLines() }
    Box(Modifier.horizontalScroll(rememberScrollState())) {
        Layout(
            content = {
                allRows.forEachIndexed { r, row ->
                    for (col in 0 until columns) {
                        val align = when (table.alignments.getOrNull(col)) {
                            MdAlignment.Center -> TextAlign.Center
                            MdAlignment.Right -> TextAlign.End
                            else -> TextAlign.Start
                        }
                        val weight = if (r == 0) FontWeight.Medium else FontWeight.Normal
                        val style = ClaveTypography.type(Metrics.codeSize, weight, Metrics.proseLineHeight)
                            .copy(color = if (r == 0) t.textSecondary else t.textPrimary, textAlign = align)
                        Box(Modifier.padding(Metrics.tableCellPadding)) {
                            ProseText(row.getOrNull(col).orEmpty(), style, onLink, Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            modifier = Modifier.drawBehind {
                val stroke = Metrics.hairline.toPx()
                grid.xs.forEach { x -> drawRect(ruleColor, Offset(x.toFloat(), 0f), Size(stroke, size.height)) }
                grid.ys.forEach { y -> drawRect(ruleColor, Offset(0f, y.toFloat()), Size(size.width, stroke)) }
            },
        ) { measurables, _ ->
            val cap = Metrics.tableCellMaxWidth.roundToPx()
            val rule = Metrics.hairline.roundToPx().coerceAtLeast(1)
            val widths = IntArray(columns)
            measurables.forEachIndexed { i, m ->
                val col = i % columns
                widths[col] = max(widths[col], min(cap, m.maxIntrinsicWidth(Constraints.Infinity)))
            }
            val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints.fixedWidth(widths[i % columns])) }
            val rowHeights = allRows.indices.map { r -> (0 until columns).maxOf { placeables[r * columns + it].height } }
            val width = widths.sum() + rule * (columns + 1)
            val height = rowHeights.sum() + rule * (allRows.size + 1)
            val xs = IntArray(columns + 1)
            for (col in 0 until columns) xs[col + 1] = xs[col] + rule + widths[col]
            val ys = IntArray(allRows.size + 1)
            for (r in allRows.indices) ys[r + 1] = ys[r] + rule + rowHeights[r]
            grid.xs = xs
            grid.ys = ys
            layout(width, height) {
                allRows.indices.forEach { r ->
                    for (col in 0 until columns) placeables[r * columns + col].place(xs[col] + rule, ys[r] + rule)
                }
            }
        }
    }
}

/**
 * An image by URL through Coil: the alt is its description. The loaded image is at most
 * [Metrics.imageMaxHeight] tall; while it loads, and when it cannot, [ImagePlaceholder]
 * holds a short place for it and shows its alt, so an unreachable image still says what it was.
 */
@Composable
private fun MarkdownImage(url: String, alt: String) {
    SubcomposeAsyncImage(
        model = url,
        contentDescription = alt.ifEmpty { null },
        contentScale = ContentScale.Fit,
        loading = { ImagePlaceholder(alt) },
        error = { ImagePlaceholder(alt) },
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Metrics.radiusLg))
            .heightIn(max = Metrics.imageMaxHeight),
    )
}

/**
 * An image's place before it is there: surface-100, [Metrics.imagePlaceholderHeight] tall, the
 * photo glyph above the alt in the tertiary ink. To TalkBack it is the image itself: one node
 * whose description is the alt, the glyph and the visible words cleared under it.
 */
@Composable
private fun ImagePlaceholder(alt: String) {
    val t = Clave.colors.theme
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(Metrics.imagePlaceholderHeight)
            .background(t.surface100)
            .padding(horizontal = Metrics.space(3))
            .clearAndSetSemantics {
                if (alt.isNotEmpty()) contentDescription = alt
                role = Role.Image
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Metrics.space(1), Alignment.CenterVertically),
    ) {
        Icon(ClaveIcon.Photo, contentDescription = null, tint = t.textTertiary)
        if (alt.isNotEmpty()) {
            BasicText(
                text = alt,
                style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary, textAlign = TextAlign.Center),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
