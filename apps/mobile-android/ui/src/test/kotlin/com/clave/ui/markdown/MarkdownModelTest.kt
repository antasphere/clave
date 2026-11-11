package com.clave.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownModelTest {
    private fun single(text: String): MdBlock = parseMarkdown(text).single()

    private fun inlines(text: String): List<MdInline> = (single(text) as MdBlock.Paragraph).inlines

    @Test
    fun headingsKeepTheirLevel() {
        val blocks = parseMarkdown("# One\n\n## Two\n\n### Three")
        assertEquals(
            listOf(
                MdBlock.Heading(1, listOf(MdInline.Text("One"))),
                MdBlock.Heading(2, listOf(MdInline.Text("Two"))),
                MdBlock.Heading(3, listOf(MdInline.Text("Three"))),
            ),
            blocks,
        )
    }

    @Test
    fun emphasisAndStrong() {
        assertEquals(
            listOf(
                MdInline.Text("a "),
                MdInline.Strong(listOf(MdInline.Text("bold"))),
                MdInline.Text(" and "),
                MdInline.Emphasis(listOf(MdInline.Text("soft"))),
            ),
            inlines("a **bold** and *soft*"),
        )
    }

    @Test
    fun inlineCode() {
        assertEquals(listOf(MdInline.Text("run "), MdInline.Code("npm test")), inlines("run `npm test`"))
    }

    @Test
    fun fencedCodeKeepsItsLanguage() {
        assertEquals(MdBlock.CodeBlock("kotlin", "val a = 1\nval b = 2"), single("```kotlin\nval a = 1\nval b = 2\n```"))
        assertEquals(MdBlock.CodeBlock(null, "plain"), single("```\nplain\n```"))
    }

    @Test
    fun aTableKeepsItsAlignments() {
        val table = single("| Name | Count | Note |\n|:-----|------:|:----:|\n| a | 1 | x |\n| b | 2 | y |") as MdBlock.Table
        assertEquals(listOf("Name", "Count", "Note"), table.header.map { it.plainText() })
        assertEquals(listOf(MdAlignment.Left, MdAlignment.Right, MdAlignment.Center), table.alignments)
        assertEquals(listOf(listOf("a", "1", "x"), listOf("b", "2", "y")), table.rows.map { row -> row.map { it.plainText() } })
    }

    @Test
    fun aNestedListNestsItsItems() {
        val list = single("- one\n  - inner\n- two") as MdBlock.BulletList
        assertEquals(2, list.items.size)
        assertEquals(MdBlock.Paragraph(listOf(MdInline.Text("one"))), list.items[0][0])
        val inner = list.items[0][1] as MdBlock.BulletList
        assertEquals(listOf(listOf(MdBlock.Paragraph(listOf(MdInline.Text("inner"))))), inner.items)
        assertEquals(listOf(MdBlock.Paragraph(listOf(MdInline.Text("two")))), list.items[1])
    }

    @Test
    fun anOrderedListKeepsItsStart() {
        val list = single("3. three\n4. four") as MdBlock.OrderedList
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)
    }

    @Test
    fun aLink() {
        assertEquals(
            listOf(MdInline.Text("see "), MdInline.Link("https://clave.dev", listOf(MdInline.Text("the site")))),
            inlines("see [the site](https://clave.dev)"),
        )
    }

    @Test
    fun aBareUrlBecomesALink() {
        val parts = inlines("go to https://example.com now")
        assertEquals(MdInline.Text("go to "), parts[0])
        assertEquals(MdInline.Link("https://example.com", listOf(MdInline.Text("https://example.com"))), parts[1])
        assertEquals(MdInline.Text(" now"), parts[2])
    }

    @Test
    fun strikethrough() {
        assertEquals(
            listOf(MdInline.Strikethrough(listOf(MdInline.Text("gone"))), MdInline.Text(" kept")),
            inlines("~~gone~~ kept"),
        )
    }

    @Test
    fun anImageAloneIsAnImageBlockAndInlineOtherwise() {
        assertEquals(MdBlock.Image("https://x.dev/a.png", "a chart"), single("![a chart](https://x.dev/a.png)"))
        val parts = inlines("before ![icon](i.png) after")
        assertTrue(parts.contains(MdInline.Image("i.png", "icon")))
    }

    @Test
    fun aHardBreak() {
        assertEquals(
            listOf(MdInline.Text("line one"), MdInline.HardBreak, MdInline.Text("line two")),
            inlines("line one  \nline two"),
        )
        assertEquals(
            listOf(MdInline.Text("soft"), MdInline.SoftBreak, MdInline.Text("wrap")),
            inlines("soft\nwrap"),
        )
    }

    @Test
    fun quotesRulesAndHtml() {
        val blocks = parseMarkdown("> quoted\n\n---\n\n<div>raw</div>")
        assertEquals(MdBlock.Quote(listOf(MdBlock.Paragraph(listOf(MdInline.Text("quoted"))))), blocks[0])
        assertEquals(MdBlock.ThematicBreak, blocks[1])
        assertEquals(MdBlock.Html("<div>raw</div>"), blocks[2])
    }
}
