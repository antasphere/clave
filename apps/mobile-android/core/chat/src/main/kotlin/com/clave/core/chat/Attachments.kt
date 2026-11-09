/**
 * What a photo, a screenshot or a file is on its way into a message (decision 11 of the
 * spec), the limits the beta sends under, whether a picked file may go and how, and the
 * labels and markers the desktop composer writes. Ported from the pure parts of
 * `apps/mobile/src/attachments/types.ts`, `policy.ts` and `compose.ts`; the upload itself
 * belongs to the transport.
 */
package com.clave.core.chat

import com.clave.core.contract.Attachment
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.SessionAttachment
import com.clave.core.contract.SessionEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Ten records per message, images of 5 MiB at most and 20 MiB together (the desktop chat's limits). */
const val MAX_ATTACHMENTS: Int = 10
const val MAX_IMAGE_BYTES: Long = 5L * 1024 * 1024
const val MAX_TOTAL_IMAGE_BYTES: Long = 20L * 1024 * 1024
/** The files route's own limit on one upload. */
const val MAX_TRANSFER_BYTES: Long = 5L * 1024 * 1024
/** The formats a provider takes as image content; anything else travels as a file. */
val IMAGE_MIME_TYPES: List<String> = listOf("image/png", "image/jpeg", "image/gif", "image/webp")

enum class PickedKind(val wire: String) { Image("image"), Video("video"), File("file") }

/** A file the platform's picker handed over, before anything is read. */
data class PickedFile(
    val uri: String,
    val name: String,
    val mimeType: String,
    /** Bytes, when the picker knew; null when it did not. */
    val size: Long?,
    val kind: PickedKind,
)

/** The media type a file's name says it is; the server re-types every upload by name anyway. */
private val MIME_BY_EXTENSION = mapOf(
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "gif" to "image/gif",
    "webp" to "image/webp",
    "heic" to "image/heic",
    "heif" to "image/heif",
    "mp4" to "video/mp4",
    "mov" to "video/quicktime",
    "pdf" to "application/pdf",
    "txt" to "text/plain",
    "md" to "text/markdown",
    "json" to "application/json",
    "csv" to "text/csv",
    "zip" to "application/zip",
)

fun mimeTypeOf(name: String): String {
    val base = name.substring(maxOf(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
    val dot = base.lastIndexOf('.')
    val extension = if (dot > 0) base.substring(dot + 1).lowercase() else ""
    return MIME_BY_EXTENSION[extension] ?: "application/octet-stream"
}

fun kindOf(mimeType: String): PickedKind = when {
    mimeType.startsWith("image/") -> PickedKind.Image
    mimeType.startsWith("video/") -> PickedKind.Video
    else -> PickedKind.File
}

data class AdmissionContext(
    /** Records already on the message. */
    val count: Int,
    /** Bytes of the pictures already on the message. */
    val imageBytes: Long,
    /** The session's provider takes images (`GET /sessions/capabilities`). */
    val imagesSupported: Boolean,
    /** The machine's server has the files route (a standalone server; the Mac app's own has none). */
    val filesRoute: Boolean,
)

sealed interface Admission {
    data class Admitted(
        /** Uploaded as a picture (`image: true` on the prepare), else as a file. */
        val image: Boolean,
        /** What the composer says beside the chip, when the file goes otherwise than picked. */
        val note: String? = null,
    ) : Admission

    data class Refused(val reason: String) : Admission
}

const val NO_FILES_ROUTE: String =
    "This machine cannot take files from the phone: its server has no files route (a standalone server has one, the Mac app’s own server does not)."

/** JavaScript's `Number.MAX_SAFE_INTEGER`: the bound the original checks a size against. */
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

private fun mib(bytes: Long): String = "${Math.floor(bytes / (1024.0 * 1024.0) + 0.5).toLong()} MiB"

/**
 * Whether a picked file may go, and how: a picture the provider takes goes as a picture; a
 * HEIC photo, a video or any other file goes as a file with a sentence saying so; a file
 * past the limit, an empty one, or one more than the message holds is refused with a
 * sentence. Nothing is dropped in silence.
 */
fun admit(file: PickedFile, context: AdmissionContext): Admission {
    if (!context.filesRoute) return Admission.Refused(NO_FILES_ROUTE)
    if (context.count >= MAX_ATTACHMENTS) return Admission.Refused("Attach up to $MAX_ATTACHMENTS files per message.")
    val size = file.size
    if (size == null || size < 0 || size > MAX_SAFE_INTEGER) {
        return Admission.Refused("The size of ${file.name} is not known, so it cannot be sent.")
    }
    if (size == 0L) return Admission.Refused("${file.name} is empty and cannot be sent.")
    if (size > MAX_TRANSFER_BYTES) {
        return Admission.Refused("${file.name} is ${mib(size)}; the beta sends files of ${mib(MAX_TRANSFER_BYTES)} at most.")
    }
    val picture = file.mimeType in IMAGE_MIME_TYPES
    if (picture && context.imagesSupported) {
        if (size > MAX_IMAGE_BYTES) {
            return Admission.Refused("${file.name} is ${mib(size)}; a picture is ${mib(MAX_IMAGE_BYTES)} at most.")
        }
        if (context.imageBytes + size > MAX_TOTAL_IMAGE_BYTES) {
            return Admission.Refused("Pictures in one message must total ${mib(MAX_TOTAL_IMAGE_BYTES)} or less.")
        }
        return Admission.Admitted(image = true)
    }
    if (picture) {
        return Admission.Admitted(false, "Sent as a file, not as a picture: this agent does not take pictures directly.")
    }
    if (file.kind == PickedKind.Image) {
        return Admission.Admitted(false, "Sent as a file, not as a picture: this format cannot be shown to the agent directly.")
    }
    if (file.kind == PickedKind.Video) {
        return Admission.Admitted(false, "Sent as a file: the agent reads it with its own tools.")
    }
    return Admission.Admitted(image = false)
}

enum class AttachmentKind(val word: String) { Image("Image"), File("File"), Folder("Folder") }

/** The kind a record is labelled by: what it is to the agent, its delivery. */
fun attachmentKind(record: FileAttachment): AttachmentKind = when (record.delivery) {
    FileDelivery.Folder -> AttachmentKind.Folder
    FileDelivery.Image -> AttachmentKind.Image
    FileDelivery.Reference -> AttachmentKind.File
}

private val LABEL = Regex("(Image|File|Folder|Session) #(\\d+)")

/** The next label of a kind among [current]: one past the highest number that kind already
 *  holds, so a label is never issued twice in one message. */
fun nextLabel(kind: AttachmentKind, current: List<Attachment>): String {
    var highest = 0L
    for (file in current) {
        val m = file.label?.let { LABEL.matchEntire(it) } ?: continue
        if (m.groupValues[1] == kind.word) highest = maxOf(highest, m.groupValues[2].toLongOrNull() ?: 0L)
    }
    return "${kind.word} #${highest + 1}"
}

/** The marker a record is written into the text as: `[Image #1]`. */
fun markerOf(file: Attachment): String? = file.label?.takeIf { it.isNotEmpty() }?.let { "[$it]" }

/** The record with its label, numbered after what the message already holds. */
fun labelled(record: FileAttachment, current: List<Attachment>): FileAttachment =
    record.copy(label = nextLabel(attachmentKind(record), current))

/** [text] with every record's marker in it: the ones the text lacks are appended, one space
 *  apart, in the records' order (the desktop puts it at the caret; the phone at the end). */
fun textWithMarkers(text: String, attachments: List<Attachment>): String {
    var out = text
    for (file in attachments) {
        val marker = markerOf(file) ?: continue
        if (out.contains(marker)) continue
        out = if (out.isEmpty() || out.last().isWhitespace()) "$out$marker" else "$out $marker"
    }
    return out
}

/** The write the client sends: a user message with its records, under the id the phone minted. */
fun buildUserMessage(text: String, attachments: List<Attachment>, clientMessageId: String? = null): SessionEvent.UserMessage {
    require(attachments.size <= MAX_ATTACHMENTS) { "Attach up to $MAX_ATTACHMENTS files per message." }
    return SessionEvent.UserMessage(
        clientMessageId = clientMessageId?.takeIf { it.isNotEmpty() },
        text = textWithMarkers(text, attachments),
        attachments = attachments.takeIf { it.isNotEmpty() }?.toList(),
    )
}

/** The key a conversation's attachment draft is kept under, beside its text draft. */
fun attachmentDraftKey(machineId: String, sessionId: String): String = "clave.attachment-draft:$machineId:$sessionId"

/**
 * Attachments as JSON, in the contract's wire shape (a session record carries
 * `delivery: "session"`). One encoder for every stored copy, so the ledger and the
 * attachment draft compare equal byte for byte.
 */
object AttachmentJson {
    fun encode(attachment: Attachment): JsonObject = when (attachment) {
        is FileAttachment -> buildJsonObject {
            put("id", attachment.id)
            attachment.label?.let { put("label", it) }
            put("path", attachment.path)
            put("name", attachment.name)
            put("mimeType", attachment.mimeType)
            put("size", attachment.size)
            put("delivery", attachment.delivery.wire)
            attachment.entries?.let { put("entries", it) }
        }
        is SessionAttachment -> buildJsonObject {
            put("id", attachment.id)
            attachment.label?.let { put("label", it) }
            put("delivery", "session")
            put("sessionId", attachment.sessionId)
            put("name", attachment.name)
            put("agent", attachment.agent)
            put("cwd", attachment.cwd)
        }
    }

    fun encodeList(attachments: List<Attachment>): String = JsonArray(attachments.map(::encode)).toString()

    /** Null for a shape this file does not read. */
    fun decode(value: JsonElement?): Attachment? {
        val o = value as? JsonObject ?: return null
        val id = stringOf(o["id"]) ?: return null
        val label = stringOf(o["label"])
        val delivery = stringOf(o["delivery"]) ?: return null
        if (delivery == "session") {
            return SessionAttachment(
                id = id,
                label = label,
                sessionId = stringOf(o["sessionId"]) ?: return null,
                name = stringOf(o["name"]) ?: return null,
                agent = stringOf(o["agent"]) ?: return null,
                cwd = stringOf(o["cwd"]) ?: return null,
            )
        }
        return FileAttachment(
            id = id,
            label = label,
            path = stringOf(o["path"]) ?: return null,
            name = stringOf(o["name"]) ?: return null,
            mimeType = stringOf(o["mimeType"]) ?: return null,
            size = numberOf(o["size"])?.toLong() ?: return null,
            delivery = FileDelivery.of(delivery) ?: return null,
            entries = numberOf(o["entries"])?.toLong(),
        )
    }

}
