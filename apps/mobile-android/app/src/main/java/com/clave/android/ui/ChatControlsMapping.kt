package com.clave.android.ui

import com.clave.core.chat.Conversation
import com.clave.core.chat.Entry
import com.clave.core.chat.claudeContextWindow
import com.clave.core.chat.contextMeterLabel
import com.clave.core.chat.contextRatio
import com.clave.core.chat.currentModelOption
import com.clave.core.chat.effortChoice
import com.clave.core.chat.effortWord
import com.clave.core.chat.modelChipLabel
import com.clave.core.chat.permissionModeLabel
import com.clave.core.chat.sameModelId
import com.clave.core.contract.CommandOption
import com.clave.core.contract.ModelOption
import com.clave.ui.chat.ChatChoice
import com.clave.ui.chat.ChatControlsView

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
