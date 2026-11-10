package com.clave.android.ui

import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.UnknownSend
import com.clave.core.contract.Attachment
import com.clave.core.state.ARRIVED_NOTHING_DISCARDED
import com.clave.core.state.ARRIVED_NOTHING_SENT
import com.clave.core.state.BEING_COMPLETED
import com.clave.core.state.STILL_SENDING

/**
 * What the composer shows after the person's choice on a send of unknown outcome, decided apart
 * from the screen so ComposerAfterTest holds each case. [clearsStored]: the stored draft, the
 * attachment draft and the mark go too (only a real discard).
 */
internal data class ComposerAfter(
    val draft: String,
    val attachments: List<Attachment>,
    val error: String?,
    val clearsStored: Boolean,
)

/** The text and files of [unknown] as the composer held them when it was sent. */
private fun sentText(unknown: UnknownSend): String = unknown.draftText ?: unknown.text
private fun sentFiles(unknown: UnknownSend): List<Attachment> = unknown.attachments ?: emptyList()

/**
 * After a Discard, by what it did. Discarded: everything of it goes. Already delivered: the
 * delivered text and files leave the composer (left there, one tap would send them again under a
 * new id) and it says so. Already rejected: the rejection's mark says why, the draft stays.
 * Being completed, in flight: nothing changes and it says why. Nothing to discard: nothing changes.
 */
internal fun composerAfterDiscard(
    result: DeliveryController.DiscardResult?,
    draft: String,
    attachments: List<Attachment>,
    unknown: UnknownSend,
): ComposerAfter = when (result) {
    DeliveryController.DiscardResult.Discarded, null -> ComposerAfter("", emptyList(), null, clearsStored = true)
    DeliveryController.DiscardResult.AlreadyDelivered -> ComposerAfter(
        draft = if (draft == sentText(unknown)) "" else draft,
        attachments = if (attachments == sentFiles(unknown)) emptyList() else attachments,
        error = ARRIVED_NOTHING_DISCARDED,
        clearsStored = false,
    )
    DeliveryController.DiscardResult.AlreadyRejected -> ComposerAfter(draft, attachments, null, clearsStored = false)
    DeliveryController.DiscardResult.BeingCompleted -> ComposerAfter(draft, attachments, BEING_COMPLETED, clearsStored = false)
    DeliveryController.DiscardResult.InFlight -> ComposerAfter(draft, attachments, STILL_SENDING, clearsStored = false)
    DeliveryController.DiscardResult.NothingToDiscard -> ComposerAfter(draft, attachments, null, clearsStored = false)
}

/** The sentence after a send: a Send again answered with the FIRST id as sent says that message had arrived and nothing more went. */
internal fun sentenceAfterSent(sentClientMessageId: String, unknownAtStart: String?): String? =
    if (sentClientMessageId == unknownAtStart) ARRIVED_NOTHING_SENT else null

/**
 * When the conversation's unknown send has left the ledger without a mark (delivered: by the pass,
 * a completion that landed, or its own write), the composer's copy of it goes too, provided the
 * store's own draft went with it and the field still holds that text: the new text and files and
 * the attachments a field holds otherwise. Null when nothing changes.
 */
internal fun composerAfterDelivered(
    previous: UnknownSend?,
    now: UnknownSend?,
    mark: DeliveryMark?,
    storedDraft: String,
    draft: String,
    attachments: List<Attachment>,
): Pair<String, List<Attachment>>? {
    if (previous == null || now != null || mark != null) return null
    if (storedDraft.isNotEmpty() || draft != sentText(previous)) return null
    return "" to (if (attachments == sentFiles(previous)) emptyList() else attachments)
}
