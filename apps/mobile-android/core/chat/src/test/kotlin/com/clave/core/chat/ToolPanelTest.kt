package com.clave.core.chat

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolPanelTest {
    private fun tool(name: String, input: String, output: String? = null) = Entry.Tool(
        id = "t",
        name = name,
        input = Json.parseToJsonElement(input),
        output = output?.let(Json::parseToJsonElement),
        complete = output != null,
        at = 0,
    )

    @Test
    fun `a command opens to its command as shell code, then its output`() {
        val panel = toolPanel(tool("Bash", """{"command":"npm test"}""", """{"stdout":"ok","exit_code":0}"""))
        assertEquals("bash", panel.sections.first().language)
        assertEquals("npm test", panel.sections.first().text)
        assertEquals("Exit 0", panel.detail)
        assertTrue(panel.sections.drop(1).all { it.language == null })
    }

    @Test
    fun `an edit's change reads as a diff and a read as its file's language`() {
        val edit = toolPanel(tool("Edit", """{"file_path":"a.kt","old_string":"a","new_string":"b"}"""))
        assertEquals(PanelSection("a.kt", "- a\n+ b", "diff"), edit.sections.single())
        val read = toolPanel(tool("Read", """{"file_path":"/x/a.kt"}""", "\"fun main() {}\""))
        assertEquals("kt", read.sections.single { it.label == "Content" }.language)
    }

    @Test
    fun `a row reads as its verb then its target`() {
        assertEquals("Ran npm test", toolLine(tool("Bash", """{"command":"npm test\necho done"}""")))
        assertEquals("Read /x/a.kt", toolLine(tool("Read", """{"file_path":"/x/a.kt"}""")))
    }

    @Test
    fun `a long output previews eight lines with the rest one tap away`() {
        val long = (1..20).joinToString("\n") { "line $it" }
        val preview = toolPreview(long)
        assertEquals(8, preview.text.lines().size)
        assertTrue(preview.truncated)
        assertEquals(2000, toolPreview("x".repeat(5000)).text.length)
    }
}
