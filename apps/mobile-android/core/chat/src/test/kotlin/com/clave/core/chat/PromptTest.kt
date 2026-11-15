package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AskedMatch
import com.clave.core.contract.IdLabel
import com.clave.core.contract.RiskLevel
import com.clave.core.contract.SessionEvent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PromptTest {
    private fun request(tool: String?, input: String? = null) = SessionEvent.PermissionRequest(
        id = "p1",
        description = "Claude wants to do something",
        options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")),
        toolName = tool,
        input = input?.let(Json::parseToJsonElement),
    )

    @Test
    fun `a command is asked in words with the command as shell code`() {
        val d = describeRequest(request("Bash", """{"command":"rm -rf build"}"""), "Claude")
        assertEquals("Allow Claude to run a command?", d.title)
        assertEquals("", d.target)
        assertEquals("rm -rf build", d.code)
        assertEquals("bash", d.language)
    }

    @Test
    fun `an edit names the file and shows its change as a diff`() {
        val d = describeRequest(
            request("Edit", """{"file_path":"/repo/src/a.kt","old_string":"val x = 1","new_string":"val x = 2"}"""),
            "Claude",
        )
        assertEquals("Allow Claude to edit a.kt?", d.title)
        assertEquals("/repo/src/a.kt", d.target)
        assertEquals("- val x = 1\n+ val x = 2", d.code)
        assertEquals("diff", d.language)
        val write = describeRequest(request("Write", """{"file_path":"/repo/notes.txt","content":"hello"}"""), "Claude")
        assertEquals("Allow Claude to write notes.txt?", write.title)
        assertEquals("hello", write.code)
        assertNull(write.language)
    }

    @Test
    fun `a tool the chat does not know keeps the provider's sentence`() {
        assertEquals("Claude wants to do something", describeRequest(request("Mystery"), "Claude").title)
        assertEquals("Claude wants to do something", describeRequest(request(null), "Claude").title)
        assertEquals("Allow Claude to use search_docs?", describeRequest(request("mcp__docs__search_docs"), "Claude").title)
    }

    @Test
    fun `a Codex command approval shows its command`() {
        val d = describeRequest(request("item/commandExecution/requestApproval", """{"command":"npm test"}"""), "Codex")
        assertEquals("Run a command", d.title)
        assertEquals("npm test", d.code)
        assertEquals("bash", d.language)
    }

    @Test
    fun `the open requests are the unanswered ones in order`() {
        val entries = listOf(
            Entry.Permission(request("Bash").copy(id = "a"), answer = "allow", at = 1),
            Entry.Permission(request("Bash").copy(id = "b"), at = 2),
            Entry.Permission(request("Bash").copy(id = "c"), answeredElsewhere = true, at = 3),
            Entry.Permission(request("Bash").copy(id = "d"), at = 4),
        )
        assertEquals(listOf("b", "d"), openRequests(entries).map { it.id })
    }

    @Test
    fun `the reading says the level, the sentence and a mismatch`() {
        val bash = request("Bash", """{"command":"git push --force"}""")
        val read = readingOf(bash, SessionEvent.PermissionExplained("p1", RiskLevel.Irreversible, "Overwrites the remote branch.", AskedMatch.No), open = true)!!
        assertEquals("Hard to undo", read.levelLabel)
        assertEquals("Overwrites the remote branch.", read.sentence)
        assertTrue(read.mismatch)
        val unverified = readingOf(bash, SessionEvent.PermissionExplained("p1", sentence = "Pushes."), open = true)!!
        assertNull(unverified.levelLabel)
        assertEquals("Not verified. Clave could not check this; a model reads it as: Pushes.", unverified.sentence)
        assertEquals("Reading what this does…", readingOf(bash, null, open = true)?.note)
        assertNull(readingOf(bash, null, open = false))
        assertEquals("Could not read what this does", readingOf(bash, SessionEvent.PermissionExplained("p1", failed = "timeout"), open = true)?.note)
        val question = bash.copy(questions = listOf(AgentQuestion(question = "Which?", options = emptyList())))
        assertNull(readingOf(question, null, open = true))
    }
}
