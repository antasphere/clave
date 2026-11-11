package com.clave.core.chat

import com.clave.core.contract.SessionEvent
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* The grouping, the summary and the preview decided without a view. The rule these tests
   exist to hold is that a run of tools is one step of the agent's work: a MESSAGE ends it,
   a permission card does not. */
class ToolsTest {
    private fun tool(
        id: String,
        name: String? = "Read",
        input: JsonElement? = j("{}"),
        output: JsonElement? = null,
        complete: Boolean = true,
        failed: Boolean = false,
    ) = Entry.Tool(id = id, name = name, input = input, output = output, complete = complete, failed = failed, at = 0)

    private fun user(text: String): Entry = Entry.User(text, true, 0)
    private fun assistant(text: String): Entry = Entry.Assistant(text, true, 0)
    private fun permission(id: String): Entry =
        Entry.Permission(SessionEvent.PermissionRequest(id, "Allow?", emptyList()), at = 0)

    private fun kindOf(b: Block): String = when (b) {
        is Block.ToolGroup -> "tool-group"
        is Block.ApprovalGroup -> "approval-group"
        is Block.DeliveryGroup -> "delivery-group"
        is Entry.User -> "user"
        is Entry.Assistant -> "assistant"
        is Entry.Permission -> "permission"
        is Entry.Error -> "error"
        is Entry.Tool -> "tool"
    }

    // groupEntries

    @Test
    fun `folds a run of consecutive tools into one group keyed by its first tool`() {
        val blocks = groupEntries(listOf(user("go"), tool("a"), tool("b"), tool("c"), assistant("done")))
        assertEquals(listOf("user", "tool-group", "assistant"), blocks.map(::kindOf))
        val group = blocks[1] as Block.ToolGroup
        assertEquals("a", group.id)
        assertEquals(listOf("a", "b", "c"), group.tools.map { it.id })
    }

    @Test
    fun `does NOT break a run on a permission card - the approval is part of the step`() {
        val blocks = groupEntries(listOf(tool("a"), permission("p1"), tool("b")))
        assertEquals(listOf("tool-group", "permission"), blocks.map(::kindOf))
        assertEquals(listOf("a", "b"), (blocks[0] as Block.ToolGroup).tools.map { it.id })
    }

    @Test
    fun `does not break a run on an error entry either`() {
        val blocks = groupEntries(listOf(tool("a"), Entry.Error("transient", 0), tool("b")))
        val group = blocks.first { it is Block.ToolGroup } as Block.ToolGroup
        assertEquals(2, group.tools.size)
    }

    @Test
    fun `DOES break a run on a user message and on an assistant message`() {
        for (message in listOf(user("next"), assistant("thinking"))) {
            val blocks = groupEntries(listOf(tool("a"), message, tool("b")))
            assertEquals(2, blocks.count { it is Block.ToolGroup })
            assertEquals(listOf("tool-group", kindOf(message), "tool-group"), blocks.map(::kindOf))
        }
    }

    @Test
    fun `keeps entries that are not tools untouched and in order`() {
        val entries = listOf(user("a"), assistant("b"), permission("p"))
        assertEquals(entries, groupEntries(entries))
    }

    @Test
    fun `returns nothing for no entries`() {
        assertEquals(emptyList<Block>(), groupEntries(emptyList()))
    }

    // groupStatus and failureCount

    @Test
    fun `is running while any tool is incomplete, even beside a failure`() {
        val tools = listOf(tool("a", complete = true, failed = true), tool("b", complete = false))
        assertEquals(GroupStatus.Running, groupStatus(tools))
        assertEquals(1, failureCount(tools))
    }

    @Test
    fun `is failed once everything finished and one failed`() {
        assertEquals(GroupStatus.Failed, groupStatus(listOf(tool("a"), tool("b", failed = true))))
    }

    @Test
    fun `is complete when no adapter flagged a failure`() {
        assertEquals(GroupStatus.Complete, groupStatus(listOf(tool("a"), tool("b"))))
        assertEquals(0, failureCount(listOf(tool("a"), tool("b"))))
    }

    @Test
    fun `treats an absent flag as not-failed, never guessing from the output`() {
        val looksBad = tool("a", output = j("\"Error: no such file\\nError: again\""))
        assertEquals(GroupStatus.Complete, groupStatus(listOf(looksBad)))
        assertEquals(0, failureCount(listOf(looksBad)))
    }

    // describeTool

    @Test
    fun `names the kind from the tool name, however it is spelled`() {
        assertEquals(ToolKind.Read, describeTool(tool("a", name = "Read")).kind)
        assertEquals(ToolKind.Edit, describeTool(tool("a", name = "file_change")).kind)
        assertEquals(ToolKind.Command, describeTool(tool("a", name = "commandExecution")).kind)
        assertEquals(ToolKind.Search, describeTool(tool("a", name = "Grep")).kind)
        assertEquals(ToolKind.Other, describeTool(tool("a", name = "Sparkle")).kind)
    }

    @Test
    fun `labels an unknown tool with its own name rather than other`() {
        assertEquals("Sparkle", describeTool(tool("a", name = "Sparkle")).label)
    }

    @Test
    fun `takes the target a human recognises the call by, per kind`() {
        assertEquals("/x.ts", describeTool(tool("a", name = "Read", input = j("""{"file_path":"/x.ts"}"""))).target)
        assertEquals("npm test", describeTool(tool("a", name = "Bash", input = j("""{"command":"npm test"}"""))).target)
        assertEquals("TODO", describeTool(tool("a", name = "Grep", input = j("""{"pattern":"TODO","path":"src"}"""))).target)
    }

    @Test
    fun `reads the line range of a Read as its detail`() {
        assertEquals("Lines 10–14", describeTool(tool("a", input = j("""{"file_path":"/x","offset":10,"limit":5}"""))).detail)
    }

    @Test
    fun `reads a shell exit code out of the output as its detail`() {
        val shell = tool("a", name = "Bash", input = j("""{"command":"ls"}"""), output = j("""{"exitCode":2}"""))
        assertEquals("Exit 2", describeTool(shell).detail)
    }

    @Test
    fun `shows the output as a section once the call completed, and not before`() {
        val pending = tool("a", complete = false, input = j("""{"file_path":"/x"}"""), output = j("\"early\""))
        assertEquals(0, describeTool(pending).sections.size)
        val done = tool("a", complete = true, input = j("""{"file_path":"/x"}"""), output = j("\"body\""))
        assertEquals(listOf(Section("Content", "body")), describeTool(done).sections)
    }

    @Test
    fun `renders content blocks as text and anything else as readable JSON`() {
        val blocks = tool("a", input = j("""{"file_path":"/x"}"""), output = j("""[{"text":"one"},{"text":"two"}]"""))
        assertEquals("one\ntwo", describeTool(blocks).sections[0].text)
        val odd = tool("a", input = j("""{"file_path":"/x"}"""), output = j("""{"shape":[1,2]}"""))
        assertTrue(describeTool(odd).sections[0].text.contains("\"shape\""))
    }

    // toolGroupSummary

    @Test
    fun `names a lone tool by its target rather than counting it`() {
        assertEquals("Read · /x.ts", toolGroupSummary(listOf(tool("a", name = "Read", input = j("""{"file_path":"/x.ts"}""")))))
    }

    @Test
    fun `counts DISTINCT files for reads and edits`() {
        val tools = listOf(
            tool("a", name = "Read", input = j("""{"file_path":"/x"}""")),
            tool("b", name = "Read", input = j("""{"file_path":"/y"}""")),
            tool("c", name = "Read", input = j("""{"file_path":"/x"}""")),
        )
        assertEquals("Read 2 files", toolGroupSummary(tools))
    }

    @Test
    fun `counts CALLS for commands and searches, and joins kinds in order`() {
        val tools = listOf(
            tool("a", name = "Read", input = j("""{"file_path":"/x"}""")),
            tool("b", name = "Read", input = j("""{"file_path":"/y"}""")),
            tool("c", name = "Read", input = j("""{"file_path":"/z"}""")),
            tool("d", name = "Bash", input = j("""{"command":"npm test"}""")),
        )
        assertEquals("Read 3 files · Ran 1 command", toolGroupSummary(tools))
        assertEquals(
            "Searched twice",
            toolGroupSummary(
                listOf(
                    tool("a", name = "Grep", input = j("""{"pattern":"x"}""")),
                    tool("b", name = "Grep", input = j("""{"pattern":"y"}""")),
                ),
            ),
        )
    }

    @Test
    fun `will not claim N files unless EVERY read named one`() {
        val tools = listOf(tool("a", name = "Read", input = j("""{"file_path":"/x"}"""))) +
            listOf("b", "c", "d", "e").map { tool(it, name = "Read", input = j("{}")) }
        assertEquals("Read 5 times", toolGroupSummary(tools))
    }

    @Test
    fun `falls back to a count when a read carries no recognisable target`() {
        assertEquals("Read twice", toolGroupSummary(listOf(tool("a", name = "Read"), tool("b", name = "Read"))))
    }

    @Test
    fun `keeps two different unknown tools apart instead of merging them`() {
        assertEquals(
            "Sparkle × 2 · Twinkle × 1",
            toolGroupSummary(listOf(tool("a", name = "Sparkle"), tool("b", name = "Sparkle"), tool("c", name = "Twinkle"))),
        )
    }

    @Test
    fun `says nothing for an empty run`() {
        assertEquals("", toolGroupSummary(emptyList()))
    }

    // a target for every tool, not only the file-shaped ones

    @Test
    fun `names a WebFetch by its url and a Task by its description`() {
        assertEquals(
            "https://example.com/docs",
            describeTool(tool("a", name = "WebFetch", input = j("""{"url":"https://example.com/docs"}"""))).target,
        )
        assertEquals("find the seam", describeTool(tool("a", name = "Task", input = j("""{"description":"find the seam"}"""))).target)
    }

    @Test
    fun `falls back to the first string an unknown input carries`() {
        assertEquals("TEAM-7", describeTool(tool("a", name = "mcp__linear__list", input = j("""{"teamId":"TEAM-7"}"""))).target)
    }

    @Test
    fun `reads argv sent as an array as one command line`() {
        val argv = tool("a", name = "commandExecution", input = j("""{"command":["npm","test"]}"""))
        assertEquals("npm test", describeTool(argv).target)
    }

    @Test
    fun `still prefers the kind's own key over the generic fallback`() {
        val read = tool("a", name = "Read", input = j("""{"file_path":"/x.ts","url":"http://n"}"""))
        assertEquals("/x.ts", describeTool(read).target)
    }

    // visibleEntries

    @Test
    fun `drops an assistant turn that said nothing, so a run does not break on it`() {
        val entries = listOf(tool("a"), assistant("   \n "), tool("b"))
        assertEquals(2, visibleEntries(entries).size)
        val blocks = groupEntries(visibleEntries(entries))
        assertEquals(1, blocks.size)
        assertEquals(2, (blocks[0] as Block.ToolGroup).tools.size)
    }

    @Test
    fun `keeps an assistant turn that said something`() {
        assertEquals(1, visibleEntries(listOf(assistant("a word"))).size)
    }

    // safeJson and content. A JsonElement cannot point back at itself, so the two circular
    // cases become: a deep payload renders without throwing, and pretty JSON is JavaScript's.

    @Test
    fun `returns a string rather than throwing on a deeply nested payload`() {
        val deep = j("[".repeat(200) + "]".repeat(200))
        assertTrue(safeJson(deep).isNotEmpty())
        assertEquals("", content(deep))
    }

    @Test
    fun `does not recurse forever on a payload whose content holds itself in shape`() {
        val nested = j("""{"content":{"content":{"content":[[["x"]]]}}}""")
        assertEquals("x", content(nested))
        assertEquals("{\n  \"shape\": [\n    1,\n    2\n  ]\n}", safeJson(j("""{"shape":[1,2]}""")))
        assertEquals("", safeJson(null))
    }

    // describeToolHead

    @Test
    fun `gives the summary what it reads and never turns an output into text`() {
        val t = tool("a", name = "fileChange", input = j("""{"file_path":"/x"}"""), output = j("""{"rows":[1,2,3],"marker":"seen"}"""))
        assertEquals(ToolHead(ToolKind.Edit, "Edit", "/x"), describeToolHead(t))
        // The head never builds sections; the full description still carries the output.
        assertTrue(describeTool(t, withSections = false).sections.isEmpty())
        assertTrue(describeTool(t).sections.isNotEmpty())
    }

    // toolPreview

    @Test
    fun `previews the documented 8 lines and 2000 characters`() {
        assertEquals(8, PREVIEW_LINES)
        assertEquals(2000, PREVIEW_CHARS)
        assertEquals("0\n1\n2\n3\n4\n5\n6\n7", toolPreview((0 until 12).joinToString("\n")).text)
    }

    @Test
    fun `never ends on half a character`() {
        val text = toolPreview("x" + "😀".repeat(PREVIEW_CHARS)).text
        assertTrue(text.length <= PREVIEW_CHARS)
        assertFalse(text.last().isHighSurrogate())
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            assertTrue(cp == 'x'.code || cp == 0x1F600)
            i += Character.charCount(cp)
        }
    }

    @Test
    fun `keeps the first lines and reports that there is more`() {
        val preview = toolPreview((0 until 20).joinToString("\n") { "line $it" })
        assertEquals(PREVIEW_LINES, preview.text.split("\n").size)
        assertTrue(preview.truncated)
    }

    @Test
    fun `caps on characters as well as lines`() {
        val preview = toolPreview("x".repeat(PREVIEW_CHARS + 500))
        assertEquals(PREVIEW_CHARS, preview.text.length)
        assertTrue(preview.truncated)
    }

    @Test
    fun `reports nothing truncated when the text already fits`() {
        assertEquals(ToolPreview("short", false), toolPreview("short"))
    }

    // every external call says what kind it was

    @Test
    fun `tells a skill, a web call and a subagent apart from a plain tool`() {
        val skill = tool("a", name = "Skill", input = j("""{"skill":"nextjs"}"""))
        assertEquals(ToolKind.Skill, describeTool(skill).kind)
        assertEquals("nextjs", describeTool(skill).target)
        assertEquals("Skill loaded", toolHint(skill))
        assertEquals(ToolKind.Web, describeTool(tool("b", name = "WebSearch", input = j("""{"query":"q"}"""))).kind)
        assertEquals(ToolKind.Agent, describeTool(tool("c", name = "Task")).kind)
        assertEquals("Command run", toolHint(tool("d", name = "Bash", input = j("""{"command":"ls"}"""))))
    }

    @Test
    fun `names an MCP tool by the tool and says which server on hover`() {
        val mcp = tool("a", name = "mcp__linear__list_issues")
        assertEquals("list_issues", describeTool(mcp).label)
        assertEquals("Tool call · linear MCP", toolHint(mcp))
    }

    @Test
    fun `shows a run by its shared kind, or as tool calls when the kinds differ`() {
        val shell = tool("a", name = "Bash", input = j("""{"command":"ls"}"""))
        val read = tool("b", name = "Read", input = j("""{"file_path":"/x"}"""))
        assertEquals(ToolKind.Command, groupKind(listOf(shell, shell.copy(id = "c"))))
        assertEquals("2 commands run", groupHint(listOf(shell, shell.copy(id = "c"))))
        assertEquals(ToolKind.Other, groupKind(listOf(shell, read)))
        assertEquals("2 external calls", groupHint(listOf(shell, read)))
        assertEquals(
            "Loaded the x skill · Read 1 file",
            toolGroupSummary(listOf(tool("a", name = "Skill", input = j("""{"skill":"x"}""")), read)),
        )
    }

    @Test
    fun `opens a row with the verb Codex uses`() {
        assertEquals("Ran", toolVerb(ToolKind.Command, "Shell"))
        assertEquals("Edited", toolVerb(ToolKind.Edit, "Edit"))
        assertEquals("list_issues", toolVerb(ToolKind.Other, "list_issues"))
    }

    @Test
    fun `highlights a change as a diff and a read by its file extension`() {
        assertEquals("diff", sectionLanguage(ToolKind.Edit, Section("a.ts", "- a\n+ b"), ""))
        assertEquals("tsx", sectionLanguage(ToolKind.Read, Section("Content", "x"), "/src/a.tsx"))
        assertNull(sectionLanguage(ToolKind.Read, Section("Content", "x"), "/Makefile"))
    }

    // runTitle

    @Test
    fun `counts a lone call like any other`() {
        assertEquals("Read 1 file", runTitle(listOf(tool("a", name = "Read", input = j("""{"file_path":"/x.ts"}""")))))
        assertEquals("Edited 1 file", runTitle(listOf(tool("a", name = "Edit", input = j("""{"file_path":"/x.ts"}""")))))
        assertEquals("Ran 1 command", runTitle(listOf(tool("a", name = "Bash", input = j("""{"command":"ls"}""")))))
    }

    @Test
    fun `reads as one sentence, parts in the order their kind first appears`() {
        val tools = listOf(
            tool("a", name = "Read", input = j("""{"file_path":"/x.ts"}""")),
            tool("b", name = "Bash", input = j("""{"command":"ls"}""")),
            tool("c", name = "Read", input = j("""{"file_path":"/y.ts"}""")),
            tool("d", name = "Bash", input = j("""{"command":"pwd"}""")),
            tool("e", name = "Grep", input = j("""{"pattern":"x"}""")),
        )
        assertEquals("Read 2 files, ran 2 commands, ran 1 search", runTitle(tools))
    }

    @Test
    fun `counts a file once however often it was touched, and calls when one named none`() {
        assertEquals(
            "Edited 1 file",
            runTitle(
                listOf(
                    tool("a", name = "Edit", input = j("""{"file_path":"/x.ts"}""")),
                    tool("b", name = "Edit", input = j("""{"file_path":"/x.ts"}""")),
                ),
            ),
        )
        assertEquals(
            "Read 2 times",
            runTitle(listOf(tool("a", name = "Read", input = j("""{"file_path":"/x.ts"}""")), tool("b", name = "Read"))),
        )
    }

    @Test
    fun `folds every other tool into one part`() {
        assertEquals("Used 2 tools", runTitle(listOf(tool("a", name = "mcp__clave__clave_notify"), tool("b", name = "TodoWrite"))))
    }

    // Beyond the TypeScript suite: the delivery deck and the approval run the grouping owns.

    @Test
    fun `stacks messages from other tabs in one deck and folds two allowed approvals into a run`() {
        val header = "[Message from Clave tab \"Lane A\" — reply with clave_send_to_session sessionId=\"s-9\"]\nhello"
        val allowed = Entry.Permission(
            SessionEvent.PermissionRequest("p", "Allow?", listOf(com.clave.core.contract.IdLabel("allow", "Allow")), toolName = "Bash"),
            answer = "allow",
            at = 0,
        )
        val blocks = groupEntries(listOf(user(header), user("[Message from a Clave agent]\nhi"), allowed, allowed, user("me")))
        assertEquals(listOf("delivery-group", "approval-group", "user"), blocks.map(::kindOf))
        assertEquals(ParsedDelivery(ProvenanceSender("s-9", "Lane A"), "hello"), parseDelivery(header))
        assertEquals("approvals-3", blockKey(blocks[1]) { 3 })
        assertEquals(listOf("permission"), groupEntries(listOf(allowed)).map(::kindOf))
    }
}
