/**
 * The conversation reducer of the chat: the joining of `assistant_text` deltas until
 * `final`, the pairing of a tool call with its result by id, the permission cards and
 * what the kernel's state does to them, the pages of the past put in front.
 *
 * Ported from the phone's `apps/mobile/src/chat/reducer.ts`, itself the desktop's
 * `apps/plugins/chat-view/src/reducer.ts` (Clave, MIT), semantics unchanged. The
 * desktop's file is the original: a change there is a change here.
 */
package com.clave.core.chat

import com.clave.core.contract.AgentState
import com.clave.core.contract.Attachment
import com.clave.core.contract.BackgroundTask
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.HistoryItem
import com.clave.core.contract.IdLabel
import com.clave.core.contract.SessionEvent
import com.clave.core.ports.Clock
import com.clave.core.ports.SystemClock
import kotlinx.serialization.json.JsonElement

/** One row of the transcript. An entry is a [Block] too: everything but a tool renders alone. */
sealed interface Entry : Block {
    val at: Long

    data class User(
        val text: String,
        val final: Boolean,
        override val at: Long,
        val attachments: List<Attachment>? = null,
        /** The reader stopped the turn this message started (`turn_interrupted`). */
        val interrupted: Boolean = false,
        /** Taken back before the agent answered anything; undone if an answer arrives. */
        val withdrawn: Boolean = false,
    ) : Entry

    data class Assistant(val text: String, val final: Boolean, override val at: Long) : Entry

    data class Tool(
        val id: String,
        val name: String? = null,
        val input: JsonElement? = null,
        val output: JsonElement? = null,
        val complete: Boolean,
        /** The adapter's word that this call failed, never a guess read off the output. */
        val failed: Boolean = false,
        override val at: Long,
    ) : Entry

    data class Permission(
        val request: SessionEvent.PermissionRequest,
        val answer: String? = null,
        val answers: Map<String, String>? = null,
        /** The kernel left blocked while this request was open: the adapter no longer holds
         *  it (abandoned, or answered by another client). */
        val answeredElsewhere: Boolean = false,
        /** Withdrawn for good by the provider; a later blocked state cannot reopen it. */
        val abandoned: Boolean = false,
        /** A hosted form still open: the fields the agent set from what the person said, and
         *  what the person typed into it elsewhere (`permission_updated`), by question key. */
        val draft: Map<String, FormAnswer>? = null,
        /** The agent's word under a field it could not fill, by question key; gone as the field changes. */
        val notes: Map<String, String>? = null,
        override val at: Long,
    ) : Entry

    data class Error(val message: String, override val at: Long) : Entry
}

data class PermissionModeState(val mode: String, val modes: List<IdLabel>)

/** How full the agent's context is, as it last said (`context_usage`); [window] unknown is null. */
data class ContextUsageState(val used: Long, val window: Long?) {
    /** The share of the window used, 0 to 1; null while the window is unknown. */
    val fraction: Float? get() = window?.takeIf { it > 0 }?.let { (used.toDouble() / it).coerceIn(0.0, 1.0).toFloat() }
}

data class Conversation(
    val entries: List<Entry> = emptyList(),
    /** The ordinal of `entries[0]`: `first + index` is an entry's key for good; only a page
     *  of the past moves it, so no entry on screen changes key. */
    val first: Int = 0,
    val state: AgentState = AgentState.Idle,
    val model: String? = null,
    val effort: String? = null,
    val permissionMode: PermissionModeState? = null,
    /** The main agent's context use; a subagent's own use is its transcript's, never this. */
    val contextUsage: ContextUsageState? = null,
    /** What runs in the background right now (subagents, background shells), as last said. */
    val backgroundTasks: List<BackgroundTask> = emptyList(),
    /** What each permission request does, by its id, as the host read it
     *  (`permission_explained`): kept apart from the entries, so a reading that arrives before
     *  its request, or a page of the past without the request, is not lost. */
    val explained: Map<String, SessionEvent.PermissionExplained> = emptyMap(),
    val exitCode: Int? = null,
    /** The last fatal error the stream carried, for the phone's `error` state. */
    val fatal: String? = null,
)

val emptyConversation: Conversation = Conversation()

sealed interface Action {
    data class Event(val event: SessionEvent, val at: Long? = null) : Action
    data class Answer(val answer: String, val optionId: String, val answers: Map<String, String>? = null) : Action
    data class Exit(val code: Int) : Action
    /** A page of the past, oldest first, in front of what is here. */
    data class Prepend(val items: List<HistoryItem>) : Action
    data class Sync(val items: List<HistoryItem>) : Action
    data object Withdraw : Action
}

/** Whether anything but an empty assistant turn followed the reader's last message. */
fun answeredSince(entries: List<Entry>): Boolean {
    val last = entries.indexOfLast { it is Entry.User }
    return entries.drop(last + 1).any { it !is Entry.User && (it !is Entry.Assistant || it.text.trim() != "") }
}

private fun reduceItem(state: Conversation, item: HistoryItem, clock: Clock): Conversation =
    reduceConversation(state, Action.Event(item.event, item.at), clock)

/** The parent a subagent's event carries, when the event kind has one. */
private fun parentOf(event: SessionEvent): String? = when (event) {
    is SessionEvent.UserMessage -> event.parent
    is SessionEvent.AssistantText -> event.parent
    is SessionEvent.ToolCall -> event.parent
    is SessionEvent.ToolResult -> event.parent
    is SessionEvent.ContextUsage -> event.parent
    is SessionEvent.SubagentModel -> event.parent
    else -> null
}

/** Pure: never mutates [state]; a no-op answers the same instance. [clock] stamps an event without `at`. */
fun reduceConversation(state: Conversation, action: Action, clock: Clock = SystemClock): Conversation {
    when (action) {
        is Action.Exit -> return state.copy(state = AgentState.Ended, exitCode = action.code)
        is Action.Withdraw -> {
            if (answeredSince(state.entries)) return state
            val last = state.entries.indexOfLast { it is Entry.User }
            val message = state.entries.getOrNull(last) as? Entry.User ?: return state
            val entries = state.entries.toMutableList()
            entries[last] = message.copy(withdrawn = true)
            return state.copy(entries = entries)
        }
        is Action.Sync -> {
            if (action.items.isEmpty()) return state
            return action.items.fold(state.copy(entries = emptyList(), first = 0)) { s, i -> reduceItem(s, i, clock) }
        }
        is Action.Prepend -> {
            if (action.items.isEmpty()) return state
            val earlier = action.items.fold(emptyConversation) { s, i -> reduceItem(s, i, clock) }
            val past = earlier.entries
            return state.copy(
                entries = past + state.entries,
                first = state.first - past.size,
                // A reading of a request on the earlier page is that page's; a newer one here wins.
                explained = earlier.explained + state.explained,
            )
        }
        is Action.Answer -> {
            val entries = state.entries.map { e ->
                if (e is Entry.Permission && e.request.id == action.answer) {
                    e.copy(answer = action.optionId, answeredElsewhere = false, answers = action.answers ?: e.answers)
                } else e
            }
            val waiting = entries.any { it is Entry.Permission && it.answer == null && !it.answeredElsewhere }
            return state.copy(
                entries = entries,
                state = if (state.state == AgentState.Blocked && !waiting) AgentState.Working else state.state,
            )
        }
        is Action.Event -> return reduceEvent(state, action.event, action.at ?: clock.now())
    }
}

private fun reduceEvent(state: Conversation, event: SessionEvent, at: Long): Conversation {
    // A member a newer server added, or one this phone could not read: nobody reads it.
    if (event is SessionEvent.Unknown) return state
    if (event is SessionEvent.PermissionExplained) return state.copy(explained = state.explained + (event.id to event))
    if (event is SessionEvent.PermissionUpdated) return formUpdated(state, event)
    if (event is SessionEvent.BackgroundTasks) return state.copy(backgroundTasks = event.tasks)
    if (event is SessionEvent.ContextUsage) {
        if (!event.parent.isNullOrEmpty()) return state
        return state.copy(contextUsage = ContextUsageState(event.used, event.window))
    }
    if (event is SessionEvent.StateChange) {
        val marks = event.state == AgentState.Working || event.state == AgentState.Done || event.state == AgentState.Idle
        val clears = event.state == AgentState.Blocked
        val touches = { e: Entry ->
            e is Entry.Permission && e.answer == null && !e.abandoned &&
                (if (marks) !e.answeredElsewhere else clears && e.answeredElsewhere)
        }
        if (state.entries.none(touches)) return state.copy(state = event.state)
        return state.copy(
            entries = state.entries.map { e ->
                if (touches(e)) (e as Entry.Permission).copy(answeredElsewhere = marks) else e
            },
            state = event.state,
        )
    }
    if (event is SessionEvent.PermissionWithdrawn) {
        val touches = { e: Entry ->
            e is Entry.Permission && e.answer == null && !e.abandoned && e.request.id == event.id
        }
        return if (state.entries.any(touches)) {
            state.copy(
                entries = state.entries.map { e ->
                    if (touches(e)) (e as Entry.Permission).copy(answeredElsewhere = true, abandoned = true) else e
                },
            )
        } else state
    }
    // These events belong to the subagent's transcript, as on desktop.
    if (!parentOf(event).isNullOrEmpty()) return state
    val entries = state.entries.toMutableList()
    when (event) {
        is SessionEvent.UserMessage -> {
            // A form's approve or skip, written to the agent as the person's message: the
            // form's card already says it, so no bubble. The text has to say so itself, so
            // nothing hides a bubble by the flag alone.
            if (event.form == null || formMessageMarker(event.text) != event.form) {
                entries.add(
                    Entry.User(
                        text = event.text,
                        final = true,
                        at = at,
                        attachments = event.attachments?.takeIf { it.isNotEmpty() },
                    ),
                )
            }
        }
        is SessionEvent.AssistantText -> {
            val last = entries.lastOrNull()
            if (last is Entry.Assistant && !last.final) {
                entries[entries.size - 1] = last.copy(text = last.text + event.delta, final = event.final)
            } else if (event.delta == "" && event.final) {
                closeOpenAnswer(entries)
            } else {
                entries.add(Entry.Assistant(event.delta, event.final, at))
            }
        }
        is SessionEvent.ToolCall, is SessionEvent.ToolResult -> {
            val id = if (event is SessionEvent.ToolCall) event.id else (event as SessionEvent.ToolResult).id
            val index = entries.indexOfFirst { it is Entry.Tool && it.id == id }
            val previous = if (index < 0) Entry.Tool(id = id, complete = false, at = at) else entries[index] as Entry.Tool
            val tool = when (event) {
                is SessionEvent.ToolCall -> previous.copy(name = event.name, input = event.input)
                is SessionEvent.ToolResult -> previous.copy(output = event.output, complete = true, failed = event.error == true)
                else -> previous
            }
            if (index < 0) entries.add(tool) else entries[index] = tool
        }
        is SessionEvent.PermissionRequest -> {
            if (entries.none { it is Entry.Permission && it.request.id == event.id }) {
                entries.add(Entry.Permission(request = event, at = at))
            }
            return state.copy(entries = entries, state = AgentState.Blocked)
        }
        is SessionEvent.SessionMeta -> return state.copy(model = event.model)
        is SessionEvent.Effort -> return state.copy(effort = event.effort)
        is SessionEvent.PermissionMode -> return state.copy(permissionMode = PermissionModeState(event.mode, event.modes))
        is SessionEvent.Error -> {
            entries.add(Entry.Error(event.message, at))
            return if (event.fatal) {
                state.copy(entries = entries, state = AgentState.Ended, fatal = event.message)
            } else state.copy(entries = entries)
        }
        is SessionEvent.TurnInterrupted -> {
            val started = entries.indexOfLast { it is Entry.User }
            val message = entries.getOrNull(started)
            if (message is Entry.User) entries[started] = message.copy(interrupted = true)
            closeOpenAnswer(entries)
        }
        else -> Unit // provider_event, subagent_model
    }
    val taken = entries.indexOfLast { it is Entry.User }
    val takenBack = entries.getOrNull(taken)
    if (takenBack is Entry.User && takenBack.withdrawn && answeredSince(entries)) {
        entries[taken] = takenBack.copy(withdrawn = false)
    }
    return state.copy(entries = entries)
}

private fun closeOpenAnswer(entries: MutableList<Entry>) {
    val open = entries.indexOfLast { it is Entry.Assistant && !it.final }
    val answer = entries.getOrNull(open)
    if (answer is Entry.Assistant) entries[open] = answer.copy(final = true)
}

/**
 * A hosted form's answers changed under its card (the desktop reducer's `permission_updated`):
 * the agent set fields on the open form, the person's own typing came back from the server
 * ([SessionEvent.PermissionUpdated.typed]), or the form was approved ([SessionEvent.PermissionUpdated.sent])
 * and every answer reaches the views that did not send them. The latest card under the id speaks for it.
 */
private fun formUpdated(state: Conversation, event: SessionEvent.PermissionUpdated): Conversation {
    val index = state.entries.indexOfLast { it is Entry.Permission && it.request.id == event.id }
    val entry = state.entries.getOrNull(index) as? Entry.Permission ?: return state
    val entries = state.entries.toMutableList()
    if (event.typed == true) {
        // Only an open form takes the person's typing; it starts the card from those values.
        if (event.sent == true || entry.answer != null || entry.answeredElsewhere) return state
        entries[index] = entry.copy(draft = entry.draft.orEmpty() + event.answers)
        return state.copy(entries = entries)
    }
    if (event.sent == true || entry.answer != null) {
        // An empty value clears the answer, as the server dropped it.
        val answers = entry.answers.orEmpty().toMutableMap()
        for ((key, value) in event.answers) {
            val text = formAnswerText(value)
            if (text.isEmpty()) answers.remove(key) else answers[key] = text
        }
        entries[index] = entry.copy(
            answer = entry.answer ?: "answer",
            answers = answers,
            answeredElsewhere = false,
            abandoned = false,
        )
        return state.copy(entries = entries)
    }
    // A note stands under its field until the field changes.
    val notes = entry.notes.orEmpty().toMutableMap()
    notes.putAll(event.notes.orEmpty())
    for (key in event.answers.keys) if (event.notes?.get(key) == null) notes.remove(key)
    entries[index] = entry.copy(draft = entry.draft.orEmpty() + event.answers, notes = notes.takeIf { it.isNotEmpty() })
    return state.copy(entries = entries)
}

/** An answer as one line: a multi-select's labels joined by ", ", the way an answer is sent. */
fun formAnswerText(answer: FormAnswer): String = when (answer) {
    is FormAnswer.Text -> answer.value
    is FormAnswer.Choices -> answer.values.joinToString(", ")
}

private val FORM_HEAD = Regex("^\\[The form \"[\\s\\S]*?\" was (approved|skipped) by the person\\]\n")
private val FORM_FOOT = Regex("^\\(form (clave:[0-9a-f-]{36})(?: · |\\))")

/**
 * The form a message is the outcome of, read off its own text (`src/shared/form-message.ts`):
 * its first line and its last line both have to say so. Null for any other text, so a message
 * that merely claims the marker hides nothing.
 */
fun formMessageMarker(text: String): String? {
    val trimmed = text.trimEnd()
    if (FORM_HEAD.find(trimmed)?.range?.first != 0) return null
    val foot = trimmed.substring(trimmed.lastIndexOf('\n') + 1)
    return FORM_FOOT.find(foot)?.takeIf { it.range.first == 0 }?.groupValues?.get(1)
}
