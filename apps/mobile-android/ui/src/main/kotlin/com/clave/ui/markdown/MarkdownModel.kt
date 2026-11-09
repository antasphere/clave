package com.clave.ui.markdown

import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableBody
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/** Inline content: what a paragraph, a heading or a table cell is made of. */
sealed interface MdInline {
    data class Text(val text: String) : MdInline
    data class Strong(val children: List<MdInline>) : MdInline
    data class Emphasis(val children: List<MdInline>) : MdInline
    data class Code(val code: String) : MdInline
    data class Link(val url: String, val children: List<MdInline>) : MdInline
    data class Strikethrough(val children: List<MdInline>) : MdInline
    data object SoftBreak : MdInline
    data object HardBreak : MdInline
    data class Image(val url: String, val alt: String) : MdInline
}

enum class MdAlignment { None, Left, Center, Right }

/** The blocks an answer is made of, free of the parser's types so the view and tests share one shape. */
sealed interface MdBlock {
    data class Paragraph(val inlines: List<MdInline>) : MdBlock
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock
    data class CodeBlock(val language: String?, val code: String) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class BulletList(val items: List<List<MdBlock>>) : MdBlock
    data class OrderedList(val start: Int, val items: List<List<MdBlock>>) : MdBlock
    data class Table(
        val header: List<List<MdInline>>,
        val rows: List<List<List<MdInline>>>,
        val alignments: List<MdAlignment>,
    ) : MdBlock
    data object ThematicBreak : MdBlock
    /** A paragraph that holds nothing but one image: drawn as the image itself. */
    data class Image(val url: String, val alt: String) : MdBlock
    /** Raw HTML is never rendered as HTML; it is shown as the code it is. */
    data class Html(val raw: String) : MdBlock
}

/**
 * GitHub-flavoured Markdown, the desktop chat's dialect: tables, strikethrough, and bare
 * URLs as links. The parser is thread-safe and built once.
 */
private val parser: Parser = Parser.builder()
    .extensions(listOf(TablesExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()))
    .build()

/** Parses an answer into the pure model; an answer is re-parsed whole on each change. */
fun parseMarkdown(text: String): List<MdBlock> = blocks(parser.parse(text))

private fun Node.children(): Sequence<Node> = generateSequence(firstChild) { it.next }

private fun blocks(parent: Node): List<MdBlock> = parent.children().mapNotNull(::block).toList()

private fun block(node: Node): MdBlock? = when (node) {
    is Paragraph -> {
        val inlines = inlines(node)
        val lone = inlines.singleOrNull() as? MdInline.Image
        if (lone != null) MdBlock.Image(lone.url, lone.alt) else MdBlock.Paragraph(inlines)
    }
    is Heading -> MdBlock.Heading(node.level, inlines(node))
    is FencedCodeBlock -> MdBlock.CodeBlock(
        language = node.info?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.takeIf { it.isNotEmpty() },
        code = node.literal.orEmpty().removeSuffix("\n"),
    )
    is IndentedCodeBlock -> MdBlock.CodeBlock(null, node.literal.orEmpty().removeSuffix("\n"))
    is BlockQuote -> MdBlock.Quote(blocks(node))
    is BulletList -> MdBlock.BulletList(listItems(node))
    is OrderedList -> MdBlock.OrderedList(node.markerStartNumber ?: 1, listItems(node))
    is TableBlock -> table(node)
    is ThematicBreak -> MdBlock.ThematicBreak
    is HtmlBlock -> MdBlock.Html(node.literal.orEmpty().removeSuffix("\n"))
    else -> null // link reference definitions and anything unknown draw nothing
}

private fun listItems(list: Node): List<List<MdBlock>> =
    list.children().filterIsInstance<ListItem>().map(::blocks).toList()

private fun table(node: TableBlock): MdBlock.Table {
    val header = mutableListOf<List<MdInline>>()
    val alignments = mutableListOf<MdAlignment>()
    val rows = mutableListOf<List<List<MdInline>>>()
    for (section in node.children()) {
        val sectionRows = section.children().filterIsInstance<TableRow>().toList()
        when (section) {
            is TableHead -> sectionRows.firstOrNull()?.children()?.filterIsInstance<TableCell>()?.forEach { cell ->
                header += inlines(cell)
                alignments += when (cell.alignment) {
                    TableCell.Alignment.LEFT -> MdAlignment.Left
                    TableCell.Alignment.CENTER -> MdAlignment.Center
                    TableCell.Alignment.RIGHT -> MdAlignment.Right
                    null -> MdAlignment.None
                }
            }
            is TableBody -> sectionRows.forEach { row ->
                rows += row.children().filterIsInstance<TableCell>().map(::inlines).toList()
            }
        }
    }
    return MdBlock.Table(header, rows, alignments)
}

private fun inlines(parent: Node): List<MdInline> {
    val out = mutableListOf<MdInline>()
    for (node in parent.children()) {
        val inline = inline(node) ?: continue
        val last = out.lastOrNull()
        // The parser splits text at delimiters it then rejects; one run reads as one run.
        if (inline is MdInline.Text && last is MdInline.Text) out[out.lastIndex] = MdInline.Text(last.text + inline.text)
        else out += inline
    }
    return out
}

private fun plainText(node: Node): String = buildString {
    fun walk(n: Node) {
        when (n) {
            is Text -> append(n.literal)
            is Code -> append(n.literal)
            else -> n.children().forEach(::walk)
        }
    }
    node.children().forEach(::walk)
}

private fun inline(node: Node): MdInline? = when (node) {
    is Text -> MdInline.Text(node.literal)
    is StrongEmphasis -> MdInline.Strong(inlines(node))
    is Emphasis -> MdInline.Emphasis(inlines(node))
    is Code -> MdInline.Code(node.literal)
    is Link -> MdInline.Link(node.destination.orEmpty(), inlines(node))
    is Strikethrough -> MdInline.Strikethrough(inlines(node))
    is SoftLineBreak -> MdInline.SoftBreak
    is HardLineBreak -> MdInline.HardBreak
    is Image -> MdInline.Image(node.destination.orEmpty(), plainText(node))
    is HtmlInline -> MdInline.Code(node.literal)
    else -> if (node.firstChild != null) MdInline.Text(plainText(node)) else null
}

/** The text a run of inlines reads as, for accessibility and for tests. */
fun List<MdInline>.plainText(): String = buildString {
    fun walk(items: List<MdInline>) {
        items.forEach {
            when (it) {
                is MdInline.Text -> append(it.text)
                is MdInline.Code -> append(it.code)
                is MdInline.Strong -> walk(it.children)
                is MdInline.Emphasis -> walk(it.children)
                is MdInline.Link -> walk(it.children)
                is MdInline.Strikethrough -> walk(it.children)
                MdInline.SoftBreak -> append(' ')
                MdInline.HardBreak -> append('\n')
                is MdInline.Image -> append(it.alt)
            }
        }
    }
    walk(this@plainText)
}
