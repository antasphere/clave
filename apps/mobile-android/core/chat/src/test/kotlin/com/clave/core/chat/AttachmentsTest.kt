package com.clave.core.chat

import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.SessionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentsTest {
    private val file = PickedFile("file:///photo.png", "photo.png", "image/png", 3, PickedKind.Image)
    private val context = AdmissionContext(count = 0, imageBytes = 0, imagesSupported = true, filesRoute = true)
    private val record = FileAttachment(
        id = "f-1",
        path = "/tmp/session/attachments/photo.png",
        name = "photo.png",
        mimeType = "image/png",
        size = 3,
        delivery = FileDelivery.Image,
    )

    @Test
    fun `admits images within the provider and transfer limits`() {
        assertEquals(Admission.Admitted(image = true), admit(file, context))
        assertTrue(admit(file.copy(size = MAX_TRANSFER_BYTES), context) is Admission.Admitted)
    }

    @Test
    fun `refuses an invalid or oversized size`() {
        // The TypeScript also feeds NaN and Infinity, which a Long size cannot hold.
        for (size in listOf(0L, -1L, MAX_TRANSFER_BYTES + 1, null)) {
            assertTrue("size $size", admit(file.copy(size = size), context) is Admission.Refused)
        }
    }

    @Test
    fun `refuses excess records and total image bytes`() {
        assertTrue(admit(file, context.copy(count = MAX_ATTACHMENTS)) is Admission.Refused)
        assertTrue(admit(file, context.copy(imageBytes = 20L * 1024 * 1024)) is Admission.Refused)
    }

    @Test
    fun `a missing files route refuses explicitly`() {
        val refusal = admit(file, context.copy(filesRoute = false)) as Admission.Refused
        assertTrue(refusal.reason.contains("cannot take files"))
    }

    @Test
    fun `HEIC, video, and a provider without images receive a file and an explanation`() {
        for (f in listOf(file.copy(mimeType = "image/heic"), file.copy(mimeType = "video/mp4", kind = PickedKind.Video))) {
            val admitted = admit(f, context) as Admission.Admitted
            assertEquals(false, admitted.image)
            assertTrue(!admitted.note.isNullOrEmpty())
        }
        val noImages = admit(file, context.copy(imagesSupported = false)) as Admission.Admitted
        assertEquals(false, noImages.image)
        assertTrue(!noImages.note.isNullOrEmpty())
    }

    @Test
    fun `the picker translation types a file by its name`() {
        // The pickers test's typing half: a document named notes.txt is a text file.
        assertEquals("text/plain", mimeTypeOf("notes.txt"))
        assertEquals(PickedKind.File, kindOf(mimeTypeOf("notes.txt")))
        assertEquals("image/jpeg", mimeTypeOf("/a.b/IMG.JPG"))
        assertEquals("application/octet-stream", mimeTypeOf(".png"))
        assertEquals(PickedKind.Video, kindOf("video/quicktime"))
    }

    @Test
    fun `labels the returned record and builds the message, preserving the message ID`() {
        val labelledRecord = labelled(record, emptyList())
        assertEquals("Image #1", labelledRecord.label)
        assertEquals(
            SessionEvent.UserMessage(clientMessageId = "message-1234", text = "Look [Image #1]", attachments = listOf(labelledRecord)),
            buildUserMessage("Look", listOf(labelledRecord), "message-1234"),
        )
        assertEquals("Look [Image #1]", buildUserMessage("Look [Image #1]", listOf(labelledRecord)).text)
    }

    @Test
    fun `numbers per kind without reusing removed labels`() {
        assertEquals("Image #5", labelled(record, listOf(record.copy(label = "Image #4"))).label)
        assertEquals("File #1", nextLabel(AttachmentKind.File, listOf(record.copy(label = "Image #4"))))
        assertEquals("[Image #4]", markerOf(record.copy(label = "Image #4")))
        assertNull(markerOf(record))
    }

    // Beyond the TypeScript suite: the marker spacing and the record limit of a message.
    @Test
    fun `appends a missing marker one space apart and refuses an eleventh record`() {
        val a = record.copy(label = "Image #1")
        assertEquals("[Image #1]", textWithMarkers("", listOf(a)))
        assertEquals("Look\n[Image #1]", textWithMarkers("Look\n", listOf(a)))
        assertNull(buildUserMessage("x", emptyList()).attachments)
        assertThrows(IllegalArgumentException::class.java) { buildUserMessage("x", List(MAX_ATTACHMENTS + 1) { a }) }
    }
}
