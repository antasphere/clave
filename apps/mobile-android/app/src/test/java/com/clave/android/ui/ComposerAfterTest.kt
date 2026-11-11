package com.clave.android.ui

import com.clave.core.chat.DeliveryController.DiscardResult
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.UnknownSend
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.state.ARRIVED_NOTHING_DISCARDED
import com.clave.core.state.ARRIVED_NOTHING_SENT
import com.clave.core.state.BEING_COMPLETED
import com.clave.core.state.CHOICE_NOT_SAVED
import com.clave.core.state.STILL_SENDING
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the composer shows after the person's choice on a send of unknown outcome, and after it was delivered meanwhile. */
class ComposerAfterTest {
    private val file = FileAttachment(id = "f-1", path = "/tmp/a/notes.txt", name = "notes.txt", mimeType = "text/plain", size = 3, delivery = FileDelivery.Reference)
    private val other = file.copy(id = "f-2", name = "other.txt")
    private val unknown = UnknownSend("m", "s", "m-1", text = "hello", at = 1, draftText = "hello", attachments = listOf(file))

    @Test
    fun `a real discard empties the composer and clears what is stored`() {
        for (result in listOf(DiscardResult.Discarded, null)) {
            assertEquals(ComposerAfter("", emptyList(), null, clearsStored = true), composerAfterDiscard(result, "hello", listOf(file), unknown))
        }
    }

    @Test
    fun `already delivered, the delivered text and files leave the composer and it says so, an edit stays`() {
        assertEquals(
            ComposerAfter("", emptyList(), ARRIVED_NOTHING_DISCARDED, clearsStored = false),
            composerAfterDiscard(DiscardResult.AlreadyDelivered, "hello", listOf(file), unknown),
        )
        assertEquals(
            ComposerAfter("hello, edited", listOf(other), ARRIVED_NOTHING_DISCARDED, clearsStored = false),
            composerAfterDiscard(DiscardResult.AlreadyDelivered, "hello, edited", listOf(other), unknown),
        )
    }

    @Test
    fun `when nothing was discarded the composer keeps everything and says why`() {
        val cases = mapOf(
            DiscardResult.AlreadyRejected to null,
            DiscardResult.BeingCompleted to BEING_COMPLETED,
            DiscardResult.InFlight to STILL_SENDING,
            DiscardResult.NothingToDiscard to null,
            DiscardResult.NotSaved to CHOICE_NOT_SAVED,
        )
        for ((result, sentence) in cases) {
            assertEquals("$result", ComposerAfter("hello", listOf(file), sentence, clearsStored = false), composerAfterDiscard(result, "hello", listOf(file), unknown))
        }
    }

    @Test
    fun `delivered, a file sent leaves the composer and a file added since stays`() {
        assertEquals(
            "" to listOf(other),
            composerAfterDelivered(unknown, null, null, storedDraft = "", draft = "hello", attachments = listOf(file, other)),
        )
        assertEquals(
            ComposerAfter("", listOf(other), ARRIVED_NOTHING_DISCARDED, clearsStored = false),
            composerAfterDiscard(DiscardResult.AlreadyDelivered, "hello", listOf(file, other), unknown),
        )
    }

    @Test
    fun `Send again answered with the first id as sent says nothing more went`() {
        assertEquals(ARRIVED_NOTHING_SENT, sentenceAfterSent("m-1", unknownAtStart = "m-1"))
        assertNull(sentenceAfterSent("m-2", unknownAtStart = "m-1"))
        assertNull(sentenceAfterSent("m-2", unknownAtStart = null))
    }

    @Test
    fun `delivered meanwhile, the composer's copy goes only when the store's draft went and the field still holds it`() {
        assertEquals("" to emptyList<FileAttachment>(), composerAfterDelivered(unknown, null, null, storedDraft = "", draft = "hello", attachments = listOf(file)))
        assertEquals("" to listOf(other), composerAfterDelivered(unknown, null, null, storedDraft = "", draft = "hello", attachments = listOf(other)))
        // An edit, a stored draft the core kept, a mark (refused, unknown), the send still waiting: nothing changes.
        assertNull(composerAfterDelivered(unknown, null, null, storedDraft = "", draft = "hello, edited", attachments = listOf(file)))
        assertNull(composerAfterDelivered(unknown, null, null, storedDraft = "hello", draft = "hello", attachments = listOf(file)))
        assertNull(composerAfterDelivered(unknown, null, DeliveryMark(DeliveryMark.Kind.Rejected, "m-1", "no", 2), storedDraft = "", draft = "hello", attachments = listOf(file)))
        assertNull(composerAfterDelivered(unknown, unknown, null, storedDraft = "", draft = "hello", attachments = listOf(file)))
        assertNull(composerAfterDelivered(null, null, null, storedDraft = "", draft = "hello", attachments = listOf(file)))
    }

    @Test
    fun `a notice an older build left without its send is the card over the kept draft, and its Discard keeps the draft and files`() {
        val orphan = DeliveryMark(DeliveryMark.Kind.Unknown, "m-old", "Delivery has not been confirmed.", 7)
        val card = orphanCard("m", "s", orphan, storedDraft = "hello")
        assertEquals(UnknownSend("m", "s", "m-old", text = "hello", at = 7), card)
        assertEquals(
            "that mark alone goes",
            ComposerAfter("hello", listOf(file), null, clearsStored = false),
            composerAfterDiscard(DiscardResult.OrphanCleared, "hello", listOf(file), card),
        )
        // Cleared, the card leaves without a mark: nothing it stands for leaves the composer.
        assertNull(composerAfterDelivered(card, null, null, storedDraft = "hello", draft = "hello", attachments = listOf(file)))
        val fileOnly = orphanCard("m", "s", orphan, storedDraft = "")
        assertEquals("" to listOf(file), composerAfterDelivered(fileOnly, null, null, storedDraft = "", draft = "", attachments = listOf(file)))
    }
}
