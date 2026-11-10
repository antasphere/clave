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
        override val at: Long,
    ) : Entry

    data class Error(val message: String, override val at: Long) : Entry
}

data class PermissionModeState(val mode: String, val modes: List<IdLabel>)

data class Conversation(
    val entries: List<Entry> = emptyList(),
    /** The ordinal of `entries[0]`: `first + index` is an entry's key for good; only a page
     *  of the past moves it, so no entry on screen changes key. */
    val first: Int = 0,
    val state: AgentState = AgentState.Idle,
    val model: String? = null,
    val effort: String? = null,
    val permissionMode: PermissionModeState? = null,
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
            val past = action.items.fold(emptyConversation) { s, i -> reduceItem(s, i, clock) }.entries
            return state.copy(entries = past + state.entries, first = state.first - past.size)
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
        is SessionEvent.UserMessage -> entries.add(
            Entry.User(
                text = event.text,
                final = true,
                at = at,
                attachments = event.attachments?.takeIf { it.isNotEmpty() },
            ),
        )
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
        else -> Unit // provider_event, context_usage, subagent_model, background_tasks
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
