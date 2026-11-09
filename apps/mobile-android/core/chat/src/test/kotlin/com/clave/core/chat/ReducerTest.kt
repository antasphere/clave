package com.clave.core.chat

import com.clave.core.contract.AgentState
import com.clave.core.contract.HistoryItem
import com.clave.core.contract.IdLabel
import com.clave.core.contract.SessionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ReducerTest {
    private fun run(events: List<SessionEvent>, from: Conversation = emptyConversation): Conversation =
        events.fold(from) { state, event -> reduceConversation(state, Action.Event(event, at = 1)) }

    private fun kinds(c: Conversation) = c.entries.map { it::class.simpleName }

    @Test
    fun `never reopens a withdrawn request when a different request blocks`() {
        val request = SessionEvent.PermissionRequest(id = "old", description = "Old", options = emptyList())
        val c = run(
            listOf(
                request,
                SessionEvent.PermissionWithdrawn("old"),
                SessionEvent.StateChange(AgentState.Working),
                request.copy(id = "new"),
                SessionEvent.StateChange(AgentState.Blocked),
            ),
        )
        val first = c.entries[0] as Entry.Permission
        assertTrue(first.answeredElsewhere)
        assertTrue(first.abandoned)
        assertEquals("new", (c.entries[1] as Entry.Permission).request.id)
        assertEquals(1, c.entries.count { it is Entry.Permission && it.answer == null && !it.answeredElsewhere })
        assertEquals(AgentState.Blocked, c.state)
    }

    @Test
    fun `keeps subagent messages, text and results out of the main conversation`() {
        val c = run(
            listOf(
                SessionEvent.UserMessage(text = "main"),
                SessionEvent.UserMessage(text = "brief", parent = "p"),
                SessionEvent.AssistantText("nested", true, parent = "p"),
                SessionEvent.ToolResult("nested", j("\"private\""), parent = "p"),
                SessionEvent.AssistantText("answer", true),
            ),
        )
        assertEquals(2, c.entries.size)
        assertEquals(listOf("User", "Assistant"), kinds(c))
        assertEquals("answer", (c.entries[1] as Entry.Assistant).text)
    }

    @Test
    fun `joins assistant deltas until final and the closing frame closes the open answer`() {
        val c = run(
            listOf(
                SessionEvent.AssistantText("Hel", false),
                SessionEvent.AssistantText("lo", false),
                SessionEvent.ToolCall("t", "Read", j("{}")),
                SessionEvent.AssistantText("", true),
            ),
        )
        assertEquals(listOf("Assistant", "Tool"), kinds(c))
        assertEquals(Entry.Assistant("Hello", true, 1), c.entries[0])
    }

    @Test
    fun `pairs a tool call with its result by id, the adapter's failure flag carried`() {
        val c = run(
            listOf(
                SessionEvent.ToolCall("t1", "Bash", j("""{"command":"ls"}""")),
                SessionEvent.ToolCall("t2", "Read", j("""{"path":"/x"}""")),
                SessionEvent.ToolResult("t1", j("\"a b\""), error = true),
                SessionEvent.ToolResult("t2", j("\"text\"")),
            ),
        )
        assertEquals(2, c.entries.size)
        val t1 = c.entries[0] as Entry.Tool
        assertEquals("t1", t1.id)
        assertTrue(t1.complete)
        assertTrue(t1.failed)
        assertEquals(j("\"a b\""), t1.output)
        val t2 = c.entries[1] as Entry.Tool
        assertEquals("t2", t2.id)
        assertTrue(t2.complete)
        assertFalse(t2.failed)
    }

    @Test
    fun `a permission request blocks, the view's answer unblocks, the kernel's word closes a card`() {
        val request = SessionEvent.PermissionRequest("r1", "Run?", listOf(IdLabel("allow-once", "Allow")))
        var c = run(listOf(request))
        assertEquals(AgentState.Blocked, c.state)
        val answered = reduceConversation(c, Action.Answer("r1", "allow-once"))
        assertEquals(AgentState.Working, answered.state)
        assertEquals("allow-once", (answered.entries[0] as Entry.Permission).answer)
        c = run(listOf(SessionEvent.StateChange(AgentState.Working)), c)
        assertTrue((c.entries[0] as Entry.Permission).answeredElsewhere)
        c = run(listOf(SessionEvent.StateChange(AgentState.Blocked)), c)
        assertFalse((c.entries[0] as Entry.Permission).answeredElsewhere)
    }

    @Test
    fun `a fatal error ends the conversation and is kept for the error state`() {
        val c = run(listOf(SessionEvent.Error("account limit reached", true)))
        assertEquals(AgentState.Ended, c.state)
        assertEquals("account limit reached", c.fatal)
        val soft = run(listOf(SessionEvent.Error("retrying", false)))
        assertEquals(AgentState.Idle, soft.state)
        assertNull(soft.fatal)
    }

    @Test
    fun `sync rebuilds from the page and prepend puts the past in front, the keys stable`() {
        val page = listOf(
            HistoryItem(SessionEvent.UserMessage(text = "second"), 2),
            HistoryItem(SessionEvent.AssistantText("two", true), 2),
        )
        val synced = reduceConversation(emptyConversation, Action.Sync(page))
        assertEquals(listOf("User", "Assistant"), kinds(synced))
        assertEquals(0, synced.first)
        val older = listOf(
            HistoryItem(SessionEvent.UserMessage(text = "first"), 1),
            HistoryItem(SessionEvent.ToolCall("t", "Read", j("{}")), 1),
            HistoryItem(SessionEvent.ToolResult("t", j("\"x\"")), 1),
        )
        val whole = reduceConversation(synced, Action.Prepend(older))
        assertEquals(listOf("User", "Tool", "User", "Assistant"), kinds(whole))
        assertEquals(-2, whole.first)
        assertSame(whole, reduceConversation(whole, Action.Prepend(emptyList())))
    }

    @Test
    fun `an interrupted turn mutes the message and closes the open answer`() {
        val c = run(
            listOf(
                SessionEvent.UserMessage(text = "go"),
                SessionEvent.AssistantText("half", false),
                SessionEvent.TurnInterrupted,
            ),
        )
        assertTrue((c.entries[0] as Entry.User).interrupted)
        assertTrue((c.entries[1] as Entry.Assistant).final)
    }

    @Test
    fun `session_meta, effort and permission_mode land on the conversation, provider events nowhere`() {
        val c = run(
            listOf(
                SessionEvent.SessionMeta("echo-1", null),
                SessionEvent.Effort("low"),
                SessionEvent.PermissionMode("default", listOf(IdLabel("default", "Default"))),
                SessionEvent.ProviderEvent("codex", j("{}")),
                SessionEvent.ContextUsage(1, 2),
            ),
        )
        assertEquals("echo-1", c.model)
        assertEquals("low", c.effort)
        assertEquals("default", c.permissionMode?.mode)
        assertEquals(0, c.entries.size)
    }

    @Test
    fun `exit ends the conversation with its code`() {
        val c = reduceConversation(emptyConversation, Action.Exit(1))
        assertEquals(AgentState.Ended, c.state)
        assertEquals(1, c.exitCode)
    }

    // Beyond the TypeScript suite: the withdraw action and its undo, which the port must keep.
    @Test
    fun `a withdrawn message is undone when an answer arrives, and cannot be withdrawn once answered`() {
        val sent = run(listOf(SessionEvent.UserMessage(text = "oops")))
        val withdrawn = reduceConversation(sent, Action.Withdraw)
        assertTrue((withdrawn.entries[0] as Entry.User).withdrawn)
        val answered = run(listOf(SessionEvent.AssistantText("on it", true)), withdrawn)
        assertFalse((answered.entries[0] as Entry.User).withdrawn)
        assertSame(answered, reduceConversation(answered, Action.Withdraw))
    }
}
