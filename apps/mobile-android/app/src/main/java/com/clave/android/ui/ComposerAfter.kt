package com.clave.android.ui

import com.clave.core.chat.DeliveryController
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.UnknownSend
import com.clave.core.contract.Attachment
import com.clave.core.state.ARRIVED_NOTHING_DISCARDED
import com.clave.core.state.ARRIVED_NOTHING_SENT
import com.clave.core.state.BEING_COMPLETED
import com.clave.core.state.CHOICE_NOT_SAVED
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

/** [attachments] without the records [unknown] sent: a file the person added since stays, the one
 *  delivered never sits beside it one tap from going again under a new id. */
private fun withoutSent(attachments: List<Attachment>, unknown: UnknownSend): List<Attachment> =
    sentFiles(unknown).let { sent -> attachments.filterNot { it in sent } }

/**
 * After a Discard, by what it did. Discarded: everything of it goes. Already delivered: the
 * delivered text and files leave the composer (left there, one tap would send them again under a
 * new id) and it says so. Already rejected: the rejection's mark says why, the draft stays.
 * Being completed, in flight, the choice not saved: nothing changes and it says why. Nothing to
 * discard: nothing changes.
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
        attachments = withoutSent(attachments, unknown),
        error = ARRIVED_NOTHING_DISCARDED,
        clearsStored = false,
    )
    DeliveryController.DiscardResult.AlreadyRejected -> ComposerAfter(draft, attachments, null, clearsStored = false)
    DeliveryController.DiscardResult.BeingCompleted -> ComposerAfter(draft, attachments, BEING_COMPLETED, clearsStored = false)
    DeliveryController.DiscardResult.InFlight -> ComposerAfter(draft, attachments, STILL_SENDING, clearsStored = false)
    DeliveryController.DiscardResult.NothingToDiscard -> ComposerAfter(draft, attachments, null, clearsStored = false)
    DeliveryController.DiscardResult.NotSaved -> ComposerAfter(draft, attachments, CHOICE_NOT_SAVED, clearsStored = false)
    // A notice an older build left without its send: that mark alone went; whether the message
    // arrived is not known, so the draft and its files stay as they are.
    DeliveryController.DiscardResult.OrphanCleared -> ComposerAfter(draft, attachments, null, clearsStored = false)
}

/**
 * A notice of unknown delivery a build before this one left without its send
 * ([DeliveryController.orphan]), as the "Delivery unknown" card shows it: that mark's id, and the
 * draft kept as the text, since what went under that id is not known. Nothing of it is recorded,
 * and it carries no files, so nothing it stands for is ever taken out of the composer.
 */
internal fun orphanCard(machineId: String, sessionId: String, mark: DeliveryMark, storedDraft: String): UnknownSend =
    UnknownSend(machineId, sessionId, mark.clientMessageId, text = storedDraft, at = mark.at)

/** The sentence after a send: a Send again answered with the FIRST id as sent says that message had arrived and nothing more went. */
internal fun sentenceAfterSent(sentClientMessageId: String, unknownAtStart: String?): String? =
    if (sentClientMessageId == unknownAtStart) ARRIVED_NOTHING_SENT else null

/**
 * When the conversation's unknown send has left the ledger without a mark (delivered: by the pass,
 * a completion that landed, or its own write), the composer's copy of it goes too, provided the
 * store's own draft went with it and the field still holds that text: of the files, the records sent
 * go and the ones added since stay. Null when nothing changes (an edited text keeps everything).
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
    return "" to withoutSent(attachments, previous)
}
