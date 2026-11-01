/**
 * From a picked file to a record on the message, and the message itself
 * (decision 11 of the spec): the policy, the bytes read through the
 * platform's file port, the upload, the label and its marker. The labels
 * and the markers are the desktop composer's, ported from
 * `src/shared/attachments.ts` (a renderer file with a zod schema the phone
 * cannot import): every record is `Image #n`, `File #n` or `Folder #n`,
 * numbered per kind in the order attached, and written into the text as
 * `[Image #1]` so the agent knows where each one belongs. The desktop puts
 * the marker at the caret; the phone appends it, with one space, which is
 * where a thumb was.
 *
 * The message is lane C's `user_message` with the records as the contract
 * carries them (never bytes) and the id the phone minted, so the write goes
 * through lane C's send table unchanged.
 */
import { ServerError, messageOf } from '../api/errors'
import type { Attachment, FileAttachment, SessionWriteInput } from '../contract/types'
import type { AttachmentClient } from './client'
import { admit, type AdmissionContext } from './policy'
import { MAX_ATTACHMENTS, type PickedFile } from './types'

export type AttachmentKind = 'Image' | 'File' | 'Folder'

/** The kind a record is labelled by: what it is to the agent, its delivery. */
export function attachmentKind(record: FileAttachment): AttachmentKind {
  if (record.delivery === 'folder') return 'Folder'
  return record.delivery === 'image' ? 'Image' : 'File'
}

const LABEL = /^(Image|File|Folder|Session) #(\d+)$/

/** The next label of a kind among `current`: one past the highest number
 *  that kind already holds, so a label is never issued twice in one message. */
export function nextLabel(kind: AttachmentKind, current: readonly Attachment[]): string {
  let highest = 0
  for (const file of current) {
    const m = file.label ? LABEL.exec(file.label) : null
    if (m && m[1] === kind) highest = Math.max(highest, Number(m[2]))
  }
  return `${kind} #${highest + 1}`
}

export const markerOf = (file: Pick<Attachment, 'label'>): string | undefined =>
  file.label ? `[${file.label}]` : undefined

/** The record with its label, numbered after what the message already holds. */
export function labelled(record: FileAttachment, current: readonly Attachment[]): FileAttachment {
  return { ...record, label: nextLabel(attachmentKind(record), current) }
}

/** `text` with every record's marker in it: the ones the text lacks are
 *  appended, one space apart, in the records' order. */
export function textWithMarkers(text: string, attachments: readonly Attachment[]): string {
  let out = text
  for (const file of attachments) {
    const marker = markerOf(file)
    if (!marker || out.includes(marker)) continue
    out = out.length === 0 || /\s$/.test(out) ? `${out}${marker}` : `${out} ${marker}`
  }
  return out
}

/** The write lane C's client sends: a user message with its records. */
export function buildUserMessage(
  text: string,
  attachments: readonly Attachment[],
  clientMessageId?: string
): Extract<SessionWriteInput, { type: 'user_message' }> {
  if (attachments.length > MAX_ATTACHMENTS)
    throw new Error(`Attach up to ${MAX_ATTACHMENTS} files per message.`)
  return {
    type: 'user_message',
    text: textWithMarkers(text, attachments),
    ...(attachments.length ? { attachments: [...attachments] } : {}),
    ...(clientMessageId ? { clientMessageId } : {})
  }
}

/** The platform's file read: expo-file-system's `File(uri).base64()` on the phone. */
export interface FileReaderPort {
  readBase64(uri: string): Promise<string>
}

export type Prepared =
  | { readonly ok: true; readonly record: FileAttachment; readonly note?: string }
  | { readonly ok: false; readonly reason: string }

/** The bytes a base64 text decodes to. */
export const base64Bytes = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * One picked file onto the message: admitted by the policy, read, uploaded,
 * labelled. A refusal carries its sentence; a server's refusal (a picture
 * whose bytes are not one, a file it cannot write) carries the server's.
 */
export async function prepareAttachment(
  file: PickedFile,
  sessionId: string,
  current: readonly Attachment[],
  ports: {
    readonly client: Pick<AttachmentClient, 'prepareUpload'>
    readonly reader: FileReaderPort
  },
  context: Omit<AdmissionContext, 'count' | 'imageBytes'>
): Promise<Prepared> {
  const imageBytes = current.reduce(
    (sum, record) => sum + (record.delivery === 'image' ? record.size : 0),
    0
  )
  const admission = admit(file, { ...context, count: current.length, imageBytes })
  if (!admission.ok) return admission
  let base64: string
  try {
    base64 = await ports.reader.readBase64(file.uri)
  } catch (error) {
    return { ok: false, reason: `${file.name} could not be read: ${messageOf(error)}` }
  }
  // The picker's size was a promise; the bytes are the fact.
  const read = admit(
    { ...file, size: base64Bytes(base64) },
    { ...context, count: current.length, imageBytes }
  )
  if (!read.ok) return read
  try {
    const record = await ports.client.prepareUpload(sessionId, {
      name: file.name,
      base64,
      image: read.image
    })
    return {
      ok: true,
      record: labelled(record, current),
      ...(read.note ? { note: read.note } : {})
    }
  } catch (error) {
    if (error instanceof ServerError && error.capabilityUnavailable)
      return {
        ok: false,
        reason:
          'This machine cannot take files from the phone: its server has no files route (a standalone server has one, the Mac app’s own server does not).'
      }
    return { ok: false, reason: `${file.name} was not sent: ${messageOf(error)}` }
  }
}
