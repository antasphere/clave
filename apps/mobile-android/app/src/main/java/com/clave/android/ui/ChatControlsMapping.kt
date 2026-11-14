package com.clave.android.ui

import com.clave.core.chat.Conversation
import com.clave.core.chat.Entry
import com.clave.core.chat.claudeContextWindow
import com.clave.core.chat.claudeModelName
import com.clave.core.chat.contextMeterLabel
import com.clave.core.chat.contextRatio
import com.clave.core.chat.currentModelOption
import com.clave.core.chat.describeRequest
import com.clave.core.chat.effortChoice
import com.clave.core.chat.effortWord
import com.clave.core.chat.isQuestion
import com.clave.core.chat.modelChipLabel
import com.clave.core.chat.openRequests
import com.clave.core.chat.permissionModeLabel
import com.clave.core.chat.providerLabel
import com.clave.core.chat.readingOf
import com.clave.core.chat.sameModelId
import com.clave.core.chat.slashMatches
import com.clave.core.contract.BackgroundTaskKind
import com.clave.core.contract.CommandOption
import com.clave.core.contract.ModelOption
import com.clave.ui.chat.ChatChoice
import com.clave.ui.chat.ChatControlsView
import com.clave.ui.chat.PromptView
import com.clave.ui.chat.SlashCommandView
import com.clave.ui.chat.WorkCardView

/**
 * What one open chat holds beyond its composer: the session's models and commands as the
 * server offered them (null until read), the model just picked until the provider says it,
 * and the server's sentence when it refused a switch.
 */
data class ChatControlsState(
    val models: List<ModelOption>? = null,
    val modelsLoading: Boolean = false,
    val commands: List<CommandOption>? = null,
    /** The model the person picked, shown at once until the provider confirms or refuses it. */
    val pendingModel: String? = null,
    /** The model the conversation was on at the pick: a new word from the provider ends the wait. */
    val pendingFrom: String? = null,
    /** How many errors the transcript held at the pick: one more is the provider's refusal. */
    val pendingErrors: Int = 0,
    val refusal: String? = null,
    /** Forms this chat answered with a list, until the conversation echoes the answer. */
    val answeredHere: Set<String> = emptySet(),
)

/** The pick still waits on the provider: it has said no new model and no new error since. */
fun pendingModelOf(conversation: Conversation, controls: ChatControlsState): String? {
    val pending = controls.pendingModel ?: return null
    if (conversation.model != controls.pendingFrom) return null
    if (conversation.entries.count { it is Entry.Error } > controls.pendingErrors) return null
    if (conversation.model != null && sameModelId(conversation.model!!, pending)) return null
    return pending
}

/**
 * The composer's status row, the desktop's composer footer: the model chip names the option
 * (or the name the id reads as), the effort chip appears for a model that takes one, the mode
 * chip for a provider that has modes, and the context meter fills from the window the turn
 * said or, before any did, the one the model is known to read.
 */
fun chatControlsView(provider: String, conversation: Conversation, controls: ChatControlsState): ChatControlsView {
    val pending = pendingModelOf(conversation, controls)
    val model = pending ?: conversation.model
    val models = controls.models
    val current = currentModelOption(model, models)
    val effort = effortChoice(model, conversation.effort, models)
    val mode = conversation.permissionMode
    val usage = conversation.contextUsage
    val window = usage?.window ?: claudeContextWindow(conversation.model)
    // A chat that has not heard a model yet still shows the chip, so the picker is reachable.
    val showsModel = provider.isNotEmpty() || model != null
    return ChatControlsView(
        provider = provider,
        model = if (showsModel) modelChipLabel(model, models) else null,
        modelPending = pending != null,
        models = models.orEmpty().map {
            ChatChoice(id = it.id, label = it.label, hint = it.hint, selected = it == current)
        },
        modelsLoading = controls.modelsLoading,
        effort = effort?.let { it.current?.label ?: "Effort" } ?: effortWord(conversation.effort),
        efforts = effort?.efforts.orEmpty().map {
            ChatChoice(id = it.id, label = it.label, hint = it.hint, selected = it == effort?.current)
        },
        mode = mode?.let { permissionModeLabel(it.mode, it.modes) },
        modes = mode?.modes.orEmpty().map { ChatChoice(id = it.id, label = it.label, selected = it.id == mode?.mode) },
        contextLabel = if (usage == null && window == null) null else contextMeterLabel(usage?.used, window),
        contextRatio = contextRatio(usage?.used, window),
        refusal = controls.refusal,
    )
}

/**
 * The first permission of the conversation still waiting, as the docked card draws it, and
 * how many wait in all. A question is answered in its own card in the transcript, never here.
 */
fun promptView(provider: String, conversation: Conversation): PromptView? {
    val open = openRequests(conversation.entries).filterNot(::isQuestion)
    val request = open.firstOrNull() ?: return null
    val described = describeRequest(request, if (provider.isEmpty()) "the agent" else providerLabel(provider))
    val reading = readingOf(request, conversation.explained[request.id], open = true)
    return PromptView(
        id = request.id,
        title = described.title,
        target = described.target.ifEmpty { null },
        detail = request.detail,
        code = described.code,
        language = described.language,
        level = reading?.level,
        levelLabel = reading?.levelLabel,
        sentence = reading?.sentence,
        mismatch = reading?.mismatch == true,
        note = reading?.note,
        options = request.options.map { it.id to it.label },
        count = open.size,
    )
}

/** The background work as cards: a command by its description (its command under it), a
 *  subagent by its task (the model it runs on under it). */
fun workCards(conversation: Conversation): List<WorkCardView> = conversation.backgroundTasks.map { task ->
    val shell = task.kind == BackgroundTaskKind.Shell
    WorkCardView(
        id = task.id,
        title = task.description.ifBlank { task.command ?: if (shell) "Command" else "Subagent" },
        shell = shell,
        startedAt = task.startedAt,
        detail = if (shell) task.command else task.model?.let { model -> claudeModelName(model)?.let { "On $it" } },
    )
}

/** The commands the composer lists for the "/" being typed; none at any other moment. */
fun slashCommands(draft: String, commands: List<CommandOption>?): List<SlashCommandView> =
    slashMatches(draft, commands).map { SlashCommandView(it.name, it.description, it.insert) }
