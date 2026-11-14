package com.clave.android.ui

import android.net.Uri
import com.clave.android.OwnerSession
import com.clave.core.chat.Admission
import com.clave.core.chat.AdmissionContext
import com.clave.core.chat.AttachmentJson
import com.clave.core.chat.DeliveryController
import com.clave.core.chat.MAX_TRANSFER_BYTES
import com.clave.core.chat.NO_FILES_ROUTE
import com.clave.core.chat.PickedKind
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.admit
import com.clave.core.chat.attachmentDraftKey
import com.clave.core.chat.labelled
import com.clave.core.chat.Entry
import com.clave.core.chat.formAnswerText
import com.clave.core.contract.Attachment
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.PermissionResponse
import com.clave.core.contract.SessionWriteInput
import com.clave.core.contract.SetEffort
import com.clave.core.contract.SetModel
import com.clave.core.contract.SetPermissionMode
import com.clave.core.contract.StopTask
import com.clave.core.state.conversationKey
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.transport.ServerError
import com.clave.core.transport.messageOf
import com.clave.platform.files.ContentFiles
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

/** The sentence an attachment that could not be read or uploaded shows. */
const val ATTACH_FAILED: String = "The file could not be attached. Try again."

/** How long the composer's text waits before it is written to the draft store. */
const val DRAFT_DEBOUNCE_MS: Long = 300

/**
 * One open conversation's composer and subscription, the prototype's ChatScreen rules on
 * the core's store: the draft and the attachment draft kept on the device until a send
 * lands, never sent by themselves; a send of unknown outcome shown as a choice (send again
 * under a NEW id, which may duplicate, or discard) and nothing sent meanwhile, the store
 * refusing a plain send until the person has chosen. [open] subscribes and [close] lets go,
 * around the screen's life.
 */
class ChatSession(
    private val owner: OwnerSession,
    val machineId: String,
    val sessionId: String,
    private val files: ContentFiles,
    private val scope: CoroutineScope,
    /** Whether this machine's server is still believed to have the files route. */
    private val filesRouteOf: (machineId: String) -> Boolean,
    /** The machine answered that it has no files route. */
    private val markNoFilesRoute: (machineId: String) -> Unit,
) {
    private val _state = MutableStateFlow(ChatSessionState(filesRoute = filesRouteOf(machineId)))
    val state: StateFlow<ChatSessionState> = _state.asStateFlow()

    private val _controls = MutableStateFlow(ChatControlsState())
    /** The pickers' choices, the model just picked, a refused switch. */
    val controls: StateFlow<ChatControlsState> = _controls.asStateFlow()

    private val store get() = owner.store
    private val drafts get() = owner.services.drafts
    private val delivery get() = owner.services.delivery
    private val attachmentKey = attachmentDraftKey(machineId, sessionId)

    @Volatile private var opened = false
    @Volatile private var closed = false
    private var closeChat: (() -> Unit)? = null
    private var offMarks: (() -> Unit)? = null
    private var offSends: (() -> Unit)? = null
    private var draftWrite: Job? = null
    private val attaching = Mutex()

    /** Subscribes to the conversation and reads back the draft, the attachments, the mark and the unknown send. */
    fun open() {
        if (opened) return
        opened = true
        offMarks = delivery.marks.subscribe { scope.launch { readDelivery() } }
        // A settled send's entry leaves the ledger after its mark's write: the card goes then.
        offSends = delivery.sends.subscribe { scope.launch { readDelivery() } }
        scope.launch {
            val text = drafts.get(machineId, sessionId)
            val restored = owner.kv.get(attachmentKey)?.let(::decodeAttachments).orEmpty()
            _state.update { it.copy(draft = if (it.draft.isEmpty()) text else it.draft, attachments = restored) }
            readDelivery()
        }
        scope.launch {
            if (store.state.value.machines.none { it.id == machineId }) store.loadMachines()
            if (closed) return@launch
            // Not cancellable once begun: the store's subscription is let go by the close it answers.
            val close = try {
                store.openChat(machineId, sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = messageOf(e)) }
                return@launch
            }
            if (closed) close() else closeChat = close
            readCapabilities()
            readModels()
            readCommands()
        }
    }

    /** Leaves the conversation: the subscription released, the pending draft written. */
    fun close() {
        if (closed) return
        closed = true
        offMarks?.invoke()
        offSends?.invoke()
        closeChat?.invoke()
        closeChat = null
        val text = _state.value.draft
        draftWrite?.cancel()
        scope.launch { drafts.set(machineId, sessionId, text) }
    }

    private suspend fun readCapabilities() {
        try {
            val capabilities = store.connect(machineId).client.sessions.capabilities(sessionId)
            _state.update { it.copy(imagesSupported = capabilities.images) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Unknown capabilities: pictures go as files, which every provider reads.
        }
    }

    /** The models the session may switch to; a server that cannot say leaves the list unread. */
    private suspend fun readModels() {
        _controls.update { it.copy(modelsLoading = true) }
        try {
            val models = store.connect(machineId).client.sessions.models(sessionId)
            _controls.update { it.copy(models = models, modelsLoading = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _controls.update { it.copy(modelsLoading = false) }
        }
    }

    /** The commands the composer offers under "/"; unread stays empty. */
    private suspend fun readCommands() {
        try {
            val commands = store.connect(machineId).client.sessions.commands(sessionId)
            _controls.update { it.copy(commands = commands) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // No list: typing "/" offers nothing, and the text still goes as written.
        }
    }

    /** A picker opened: the choices are read again, the provider may have changed them. */
    fun refreshControls() {
        if (_controls.value.modelsLoading) return
        scope.launch { readModels() }
    }

    /**
     * Puts the session on another model: shown at once, confirmed by the provider's next word
     * on the model, reverted by its refusal. A refused write is said in the server's words.
     */
    fun pickModel(id: String) {
        val conversation = store.state.value.conversations[conversationKey(machineId, sessionId)]?.conversation
        _controls.update {
            it.copy(
                pendingModel = id,
                pendingFrom = conversation?.model,
                pendingErrors = conversation?.entries?.count { e -> e is Entry.Error } ?: 0,
                refusal = null,
            )
        }
        control(SetModel(id)) { _controls.update { it.copy(pendingModel = null) } }
    }

    fun pickEffort(id: String) = control(SetEffort(id))

    fun pickMode(id: String) = control(SetPermissionMode(id))

    /** Stops one background task, a subagent or a background shell. */
    fun stopTask(taskId: String) = control(StopTask(taskId))

    fun dismissRefusal() {
        _controls.update { it.copy(refusal = null) }
    }

    /** One control write; the server's refusal is shown as it said it, never hidden. */
    private fun control(input: SessionWriteInput, onRefused: () -> Unit = {}) {
        scope.launch {
            try {
                store.connect(machineId).client.sessions.write(sessionId, input)
                _controls.update { it.copy(refusal = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onRefused()
                _controls.update { it.copy(refusal = messageOf(e)) }
            }
        }
    }

    private suspend fun readDelivery() {
        val mark = delivery.marks.get(machineId, sessionId)
        val stored = drafts.get(machineId, sessionId)
        // A notice an older build left without its send is shown as the same choice, over the draft kept.
        val unknown = delivery.sends.forSession(machineId, sessionId).lastOrNull()
            ?: delivery.orphan(machineId, sessionId)?.let { orphanCard(machineId, sessionId, it, stored) }
        val storedFiles = owner.kv.get(attachmentKey)?.let(::decodeAttachments).orEmpty()
        _state.update {
            // Delivered meanwhile (the pass, a completion that landed): the composer's copy goes too.
            val delivered = composerAfterDelivered(it.unknownSend, unknown, mark, stored, storedFiles, it.draft, it.attachments)
            if (delivered == null) {
                it.copy(deliveryMark = mark, unknownSend = unknown)
            } else {
                it.copy(deliveryMark = mark, unknownSend = unknown, draft = delivered.first, attachments = delivered.second)
            }
        }
    }

    /** The composer's text: shown at once, written to the draft store after a pause. */
    fun setDraft(text: String) {
        _state.update { it.copy(draft = text) }
        draftWrite?.cancel()
        draftWrite = scope.launch {
            delay(DRAFT_DEBOUNCE_MS)
            drafts.set(machineId, sessionId, text)
        }
    }

    /** A sentence for the composer from outside the session (a picker the platform refused). */
    fun showError(text: String) {
        _state.update { it.copy(error = text) }
    }

    /** Opens or folds a transcript block. */
    fun toggle(blockKey: String) {
        _state.update { it.copy(expanded = if (blockKey in it.expanded) it.expanded - blockKey else it.expanded + blockKey) }
    }

    /**
     * Sends the draft and its attachments under a new id. While a send of this conversation
     * has an unknown outcome the store refuses (the composer's Send is disabled too): the
     * person picks "Send again" or "Discard". Sent clears the draft (when it is still the text
     * sent) and the attachment draft; Rejected and Failed keep both and say why; Unknown shows
     * the choice and sends nothing more.
     */
    fun send() = deliver { text, attachments -> store.send(machineId, sessionId, text, attachments = attachments) }

    /**
     * "Send again (may duplicate)", decided at once against any reconnection pass of the machine:
     * before the pass sends the same-id completion, the unknown send is discarded and the draft
     * goes under a NEW id. When the first message had already arrived nothing more goes, the
     * composer empties and it says so; when the completion has left, nothing changes and it says why.
     */
    fun resend() {
        val unknown = _state.value.unknownSend ?: return
        deliver { text, attachments -> store.resend(machineId, sessionId, unknown.clientMessageId, text, attachments) }
    }

    private fun deliver(call: suspend (text: String, attachments: List<Attachment>) -> SendOutcome) {
        val current = _state.value
        if ((current.draft.isBlank() && current.attachments.isEmpty()) || current.sending || current.attaching) return
        // A Send again answered with the first id as sent: that message had arrived, none went now.
        val unknownAtStart = current.unknownSend
        _state.update { it.copy(sending = true, error = null) }
        scope.launch {
            val text = current.draft
            val attachments = current.attachments
            try {
                // The store clears the draft only when the stored one is the text sent.
                draftWrite?.cancel()
                drafts.set(machineId, sessionId, text)
                when (val outcome = call(text, attachments)) {
                    is SendOutcome.Sent -> {
                        // Its own write: what it sent leaves. "It had arrived": only what the first message carried.
                        var clearsStoredFiles = false
                        _state.update {
                            val after = composerAfterSent(outcome.clientMessageId, unknownAtStart, text, attachments, it.draft, it.attachments)
                            clearsStoredFiles = after.clearsStoredFiles
                            it.copy(draft = after.draft, attachments = after.attachments, error = after.error)
                        }
                        if (clearsStoredFiles) owner.kv.remove(attachmentKey)
                        if (_state.value.draft.isEmpty()) drafts.clear(machineId, sessionId)
                    }
                    // The rejection's mark says why above the draft, and stays through a restart.
                    is SendOutcome.Rejected -> Unit
                    is SendOutcome.Failed -> _state.update { it.copy(error = outcome.reason) }
                    is SendOutcome.Unknown -> Unit
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = messageOf(e)) }
            } finally {
                readDelivery()
                _state.update { it.copy(sending = false) }
            }
        }
    }

    @Volatile private var discarding = false

    /**
     * "Discard", decided at once against any reconnection pass of the machine; what the server
     * had answered before stands and is said. Discarded, the send and its mark go, and what it
     * carried: its text while the field still holds it, its files; an edit and a file added since
     * stay. Arrived before the choice, the delivered text leaves the composer and it
     * says so. Refused, the rejection's mark stays with the draft. A completion already on its
     * way, or the send's own write still out, changes nothing and says why.
     */
    fun discard() {
        val unknown = _state.value.unknownSend ?: return
        if (discarding) return
        discarding = true
        scope.launch {
            try {
                val result = store.discardUnknown(machineId, sessionId, unknown.clientMessageId)
                val shown = _state.value
                val after = composerAfterDiscard(result, shown.draft, shown.attachments, unknown)
                if (after.clearsStored) {
                    delivery.marks.clear(machineId, sessionId)
                    draftWrite?.cancel()
                    drafts.clear(machineId, sessionId)
                    owner.kv.remove(attachmentKey)
                } else if (result == DeliveryController.DiscardResult.Discarded) {
                    // The ledger took out of the stores what the discarded message carried; the field's own
                    // copy follows, and a text typed just now and not yet written lands as it now reads.
                    draftWrite?.cancel()
                    drafts.set(machineId, sessionId, after.draft)
                    if (after.attachments.isEmpty()) owner.kv.remove(attachmentKey) else owner.kv.set(attachmentKey, AttachmentJson.encodeList(after.attachments))
                }
                _state.update { it.copy(draft = after.draft, attachments = after.attachments, error = after.error) }
            } finally {
                discarding = false
                readDelivery()
            }
        }
    }

    /** Stops the agent's turn. */
    fun interrupt() {
        scope.launch {
            val outcome = store.interrupt(machineId, sessionId)
            if (!outcome.ok) _state.update { it.copy(error = outcome.error) }
        }
    }

    /** Answers a permission or a question shown in the transcript. */
    fun answer(requestId: String, optionId: String, answers: Map<String, String>?) {
        scope.launch {
            val outcome = store.answerInChat(machineId, sessionId, requestId, optionId, answers?.takeIf { it.isNotEmpty() })
            if (!outcome.ok) _state.update { it.copy(error = outcome.error) }
        }
    }

    /**
     * Answers a question's card. One line per question goes the store's way, which marks the
     * card answered at once; a hosted multi-select's labels go as a list, written here, and the
     * card is marked answered by this chat until the conversation says so itself.
     */
    fun answerForm(requestId: String, optionId: String, answers: Map<String, FormAnswer>) {
        val lists = answers.filterValues { it is FormAnswer.Choices }.mapValues { (it.value as FormAnswer.Choices).values }
        if (lists.isEmpty()) {
            answer(requestId, optionId, answers.mapValues { formAnswerText(it.value) })
            return
        }
        val lines = answers.filterValues { it is FormAnswer.Text }.mapValues { (it.value as FormAnswer.Text).value }
        scope.launch {
            try {
                store.connect(machineId).client.sessions.write(sessionId, PermissionResponse(requestId, optionId, lines, lists))
                _controls.update { it.copy(answeredHere = it.answeredHere + requestId) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = messageOf(e)) }
            }
        }
    }

    /** Asks for the page before the oldest shown. */
    fun loadOlder() {
        scope.launch { store.loadOlder(machineId, sessionId) }
    }

    /**
     * Adds a picked file: described, admitted by the core's rules (a refusal is said, a note
     * kept), read under the files route's ceiling and uploaded through the machine's prepare
     * route, then labelled after what the message holds and kept in the attachment draft. A
     * server without the files route says so once and takes no more files for that machine.
     */
    fun attach(uri: Uri, kindHint: PickedKind?) {
        scope.launch {
            attaching.withLock {
                _state.update { it.copy(attaching = true, error = null) }
                try {
                    _state.update { it.copy(error = attachOne(uri, kindHint)) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    _state.update { it.copy(error = ATTACH_FAILED) }
                } finally {
                    _state.update { it.copy(attaching = false) }
                }
            }
        }
    }

    /** One file; answers the sentence to show, null when it went without one. */
    private suspend fun attachOne(uri: Uri, kindHint: PickedKind?): String? {
        val file = files.describe(uri, kindHint) ?: return ATTACH_FAILED
        val current = _state.value
        val context = AdmissionContext(
            count = current.attachments.size,
            imageBytes = current.attachments.filterIsInstance<FileAttachment>().filter { it.delivery == FileDelivery.Image }.sumOf { it.size },
            imagesSupported = current.imagesSupported,
            filesRoute = filesRouteOf(machineId),
        )
        val admitted = when (val admission = admit(file, context)) {
            is Admission.Refused -> return admission.reason
            is Admission.Admitted -> admission
        }
        val base64 = files.readBase64(uri, MAX_TRANSFER_BYTES) ?: return ATTACH_FAILED
        val record = try {
            store.connect(machineId).client.attachments.prepareUpload(sessionId, file.name, base64, admitted.image)
        } catch (e: ServerError) {
            if (e.capabilityUnavailable || e.status == 404) {
                markNoFilesRoute(machineId)
                _state.update { it.copy(filesRoute = false) }
                return NO_FILES_ROUTE
            }
            return ATTACH_FAILED
        }
        val next = _state.value.attachments.let { it + labelled(record, it) }
        owner.kv.set(attachmentKey, AttachmentJson.encodeList(next))
        // A picture's chip shows it, from the phone's own copy; the server's path is not readable here.
        if (record.delivery == FileDelivery.Image || record.mimeType.startsWith("image/")) {
            _controls.update { it.copy(thumbnails = it.thumbnails + (record.id to uri.toString())) }
        }
        _state.update { it.copy(attachments = next) }
        return admitted.note
    }

    /** Removes the chip at [index] from the message and from the attachment draft. */
    fun removeAttachment(index: Int) {
        val next = _state.value.attachments.filterIndexed { i, _ -> i != index }
        _state.update { it.copy(attachments = next) }
        scope.launch {
            if (next.isEmpty()) owner.kv.remove(attachmentKey) else owner.kv.set(attachmentKey, AttachmentJson.encodeList(next))
        }
    }
}

/** The attachment draft as stored; an unreadable one is no attachment. */
private fun decodeAttachments(raw: String): List<Attachment> = try {
    (Json.parseToJsonElement(raw) as? JsonArray)?.mapNotNull(AttachmentJson::decode).orEmpty()
} catch (_: Exception) {
    emptyList()
}
