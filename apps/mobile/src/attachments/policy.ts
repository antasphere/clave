/**
 * Whether a picked file may go, and how (decision 11 of the spec): a photo
 * or a screenshot in a format the provider takes goes as a picture; a HEIC
 * photo, a video or any other file goes as a file the agent reads with its
 * own tools, with a sentence saying so; a file past the files route's
 * limit, an empty file, a folder, or one more than the message holds is
 * refused with a sentence. The desktop asks the reader to choose when a
 * picture cannot go as one; the beta chooses the file and says it, so
 * nothing is dropped in silence and nothing waits on a dialog.
 */
import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_TRANSFER_BYTES,
  type PickedFile
} from './types'

export interface AdmissionContext {
  /** Records already on the message. */
  readonly count: number
  /** Bytes of the pictures already on the message. */
  readonly imageBytes: number
  /** The session's provider takes images (`GET /sessions/capabilities`). */
  readonly imagesSupported: boolean
  /** The machine's server has the files route (a standalone server; the Mac app's own has none). */
  readonly filesRoute: boolean
}

export type Admission =
  | {
      readonly ok: true
      /** Uploaded as a picture (`image: true` on the prepare), else as a file. */
      readonly image: boolean
      /** What the composer says beside the chip, when the file goes otherwise than picked. */
      readonly note?: string
    }
  | { readonly ok: false; readonly reason: string }

const mib = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MiB`

export function admit(file: PickedFile, context: AdmissionContext): Admission {
  if (!context.filesRoute)
    return {
      ok: false,
      reason:
        'This machine cannot take files from the phone: its server has no files route (a standalone server has one, the Mac app’s own server does not).'
    }
  if (context.count >= MAX_ATTACHMENTS)
    return { ok: false, reason: `Attach up to ${MAX_ATTACHMENTS} files per message.` }
  if (file.size === null || !Number.isSafeInteger(file.size) || file.size < 0)
    return { ok: false, reason: `The size of ${file.name} is not known, so it cannot be sent.` }
  if (file.size === 0) return { ok: false, reason: `${file.name} is empty and cannot be sent.` }
  if (file.size > MAX_TRANSFER_BYTES)
    return {
      ok: false,
      reason: `${file.name} is ${mib(file.size)}; the beta sends files of ${mib(MAX_TRANSFER_BYTES)} at most.`
    }
  const picture = (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType)
  if (picture && context.imagesSupported) {
    if (file.size > MAX_IMAGE_BYTES)
      return {
        ok: false,
        reason: `${file.name} is ${mib(file.size)}; a picture is ${mib(MAX_IMAGE_BYTES)} at most.`
      }
    if (context.imageBytes + file.size > MAX_TOTAL_IMAGE_BYTES)
      return {
        ok: false,
        reason: `Pictures in one message must total ${mib(MAX_TOTAL_IMAGE_BYTES)} or less.`
      }
    return { ok: true, image: true }
  }
  if (picture)
    return {
      ok: true,
      image: false,
      note: 'Sent as a file, not as a picture: this agent does not take pictures directly.'
    }
  if (file.kind === 'image')
    return {
      ok: true,
      image: false,
      note: 'Sent as a file, not as a picture: this format cannot be shown to the agent directly.'
    }
  if (file.kind === 'video')
    return {
      ok: true,
      image: false,
      note: 'Sent as a file: the agent reads it with its own tools.'
    }
  return { ok: true, image: false }
}
