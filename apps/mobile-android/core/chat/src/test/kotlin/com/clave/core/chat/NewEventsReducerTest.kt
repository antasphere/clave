package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.BackgroundTask
import com.clave.core.contract.BackgroundTaskKind
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.HistoryItem
import com.clave.core.contract.RiskLevel
import com.clave.core.contract.SessionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** The events the desktop's reducer reads since the port: readings, form updates, context, work. */
class NewEventsReducerTest {
    private fun run(events: List<SessionEvent>, from: Conversation = emptyConversation): Conversation =
        events.fold(from) { state, event -> reduceConversation(state, Action.Event(event, at = 1)) }

    private val form = SessionEvent.PermissionRequest(
        id = "f1",
        description = "Your GitHub login",
        options = emptyList(),
        questions = listOf(AgentQuestion(id = "login", question = "Login?", options = emptyList())),
    )

    @Test
    fun `an unknown event leaves the conversation as it was`() {
        val c = run(listOf(SessionEvent.UserMessage(text = "hi")))
        assertSame(c, reduceConversation(c, Action.Event(SessionEvent.Unknown("later"), at = 2)))
    }

    @Test
    fun `a reading is kept by request id, before or after its request`() {
        val reading = SessionEvent.PermissionExplained("p1", level = RiskLevel.Project, sentence = "Edits one file.")
        val c = run(listOf(reading, SessionEvent.PermissionRequest(id = "p1", description = "Edit", options = emptyList())))
        assertEquals(reading, c.explained["p1"])
        assertEquals(1, c.entries.size)
    }

    @Test
    fun `a page of the past keeps its readings and a newer one wins`() {
        val old = SessionEvent.PermissionExplained("p1", level = RiskLevel.Reads)
        val newer = SessionEvent.PermissionExplained("p1", level = RiskLevel.Outside)
        val c = run(listOf(newer))
        val prepended = reduceConversation(c, Action.Prepend(listOf(HistoryItem(old, 0), HistoryItem(SessionEvent.PermissionExplained("p0"), 0))))
        assertEquals(newer, prepended.explained["p1"])
        assertEquals(SessionEvent.PermissionExplained("p0"), prepended.explained["p0"])
    }

    @Test
    fun `the agent's fill lands in the open form's draft with its notes`() {
        val c = run(
            listOf(
                form,
                SessionEvent.PermissionUpdated("f1", mapOf("login" to FormAnswer.Text("luca")), notes = mapOf("team" to "Not said")),
            ),
        )
        val card = c.entries.single() as Entry.Permission
        assertEquals(mapOf("login" to FormAnswer.Text("luca")), card.draft)
        assertEquals(mapOf("team" to "Not said"), card.notes)
        assertNull(card.answer)
        val refilled = run(listOf(SessionEvent.PermissionUpdated("f1", mapOf("team" to FormAnswer.Text("core")))), c)
        assertNull((refilled.entries.single() as Entry.Permission).notes)
    }

    @Test
    fun `an approval sent elsewhere settles the card with its answers`() {
        val c = run(
            listOf(
                form,
                SessionEvent.PermissionUpdated(
                    "f1",
                    mapOf("login" to FormAnswer.Text("luca"), "teams" to FormAnswer.Choices(listOf("a", "b"))),
                    sent = true,
                ),
            ),
        )
        val card = c.entries.single() as Entry.Permission
        assertEquals("answer", card.answer)
        assertEquals(mapOf("login" to "luca", "teams" to "a, b"), card.answers)
    }

    @Test
    fun `typing kept by the server only starts an open form`() {
        val typed = SessionEvent.PermissionUpdated("f1", mapOf("login" to FormAnswer.Text("lu")), typed = true)
        val open = run(listOf(form, typed))
        assertEquals(mapOf("login" to FormAnswer.Text("lu")), (open.entries.single() as Entry.Permission).draft)
        val answered = reduceConversation(run(listOf(form)), Action.Answer("f1", "answer", mapOf("login" to "x")))
        assertSame(answered, reduceConversation(answered, Action.Event(typed, at = 2)))
    }

    @Test
    fun `an update for no card is nothing`() {
        val c = run(listOf(SessionEvent.UserMessage(text = "hi")))
        assertSame(c, reduceConversation(c, Action.Event(SessionEvent.PermissionUpdated("nope", emptyMap()), at = 2)))
    }

    @Test
    fun `a form's outcome message draws no bubble, a claim of the flag alone does`() {
        val id = "clave:0f8fad5b-d9cb-469f-a165-70867728950e"
        val text = "[The form \"Your login\" was approved by the person]\nLogin?: luca\n(form $id · request r1: clave_input_result reads it)"
        val hidden = run(listOf(SessionEvent.UserMessage(text = text, form = id)))
        assertEquals(0, hidden.entries.size)
        val shown = run(listOf(SessionEvent.UserMessage(text = "just words", form = id)))
        assertEquals(1, shown.entries.size)
        assertEquals(id, formMessageMarker(text))
        assertEquals(id, formMessageMarker("[The form \"x\" was skipped by the person]\n(form $id)"))
        assertNull(formMessageMarker("hello\n(form $id)"))
    }

    @Test
    fun `context usage is the main agent's, a subagent's is not`() {
        val c = run(listOf(SessionEvent.ContextUsage(50_000, 200_000), SessionEvent.ContextUsage(9, 10, parent = "sub")))
        assertEquals(ContextUsageState(50_000, 200_000), c.contextUsage)
        assertEquals(0.25f, c.contextUsage!!.fraction!!, 0.0001f)
        assertNull(ContextUsageState(5, null).fraction)
    }

    @Test
    fun `background tasks are replaced by each word`() {
        val task = BackgroundTask(id = "b1", kind = BackgroundTaskKind.Shell, description = "npm test", startedAt = 10)
        val c = run(listOf(SessionEvent.BackgroundTasks(listOf(task))))
        assertEquals(listOf(task), c.backgroundTasks)
        assertEquals(emptyList<BackgroundTask>(), run(listOf(SessionEvent.BackgroundTasks(emptyList())), c).backgroundTasks)
    }
}
