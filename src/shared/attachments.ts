import { z } from 'zod'

/* What a reader attaches to a chat message. The attachment record is what the
   composer holds and what the transcript shows. A FILE record is a name, a
   local path, and how it is DELIVERED — an image goes to the provider as image
   content, anything else as a reference the agent reads with its own tools;
   bytes never cross the renderer, the main process reads the file once the
   message is sent. A SESSION record is another Clave tab dragged onto the
   composer: its id, name, agent and folder, delivered as a line the agent can
   act on with the Clave tools (read the tab, message it).

   Every record carries a LABEL, `Image #1`, `File #2`, `Session #1`, numbered
   per kind in the order they were attached. The label is the attachment's
   name in the message text, written as a marker `[Image #1]` at the point the
   reader attached it, so the text says where each one belongs; the marker
   leaving the text removes the attachment, and removing the chip removes the
   marker. Main explains the markers to the provider at send time. */

export const MAX_ATTACHMENTS = 10
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
/** The formats providers accept as image content. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const labelSchema = z.string().min(1).max(32).optional()

export const FileAttachmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: labelSchema,
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().nonnegative(),
    /** How it reaches the agent: image content, a path to read, or a path
     *  to list (a folder). */
    delivery: z.enum(['reference', 'image', 'folder']),
    /** A folder's top-level item count; folders only. */
    entries: z.number().int().nonnegative().optional()
  })
  .strict()
export type FileAttachment = z.infer<typeof FileAttachmentSchema>

export const SessionAttachmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: labelSchema,
    delivery: z.literal('session'),
    /** The Clave session id, the one the agent tools take. */
    sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    /** The tab's name as the sidebar shows it. */
    name: z.string().min(1).max(255),
    /** The agent in that tab, in the reader's words: Claude Code, Codex, Terminal… */
    agent: z.string().min(1).max(64),
    cwd: z.string().max(4096)
  })
  .strict()
export type SessionAttachment = z.infer<typeof SessionAttachmentSchema>

export const AttachmentSchema = z.union([FileAttachmentSchema, SessionAttachmentSchema])
export const AttachmentsSchema = z.array(AttachmentSchema).max(MAX_ATTACHMENTS)
export type Attachment = z.infer<typeof AttachmentSchema>

export const isFileAttachment = (file: Attachment): file is FileAttachment =>
  file.delivery !== 'session'
export const isSessionAttachment = (file: Attachment): file is SessionAttachment =>
  file.delivery === 'session'

/** An image as the provider receives it, base64 in main only. */
export const ProviderImageSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string()
})
export type ProviderImage = z.infer<typeof ProviderImageSchema>

/** Where an attachment comes from: a path on disk, or bytes the renderer holds
 *  (a pasted screenshot has no path). */
export interface AttachmentSource {
  path?: string
  name?: string
  bytes?: Uint8Array
}
export interface AttachmentPreview {
  image?: string
  text?: string
  notice?: string
}

/** Why an image cannot go as image content, in the reader's words; nothing
 *  when it can. The fallback to a file reference is the reader's choice,
 *  never automatic — a silent downgrade would hand the agent a path it may
 *  not be able to read and call it a picture. */
export function attachmentIssue(file: Attachment, imagesSupported: boolean): string | undefined {
  if (file.delivery !== 'image') return undefined
  if (!imagesSupported) return 'This provider does not take images directly.'
  if (!IMAGE_MIME_TYPES.includes(file.mimeType)) return 'This image format cannot be sent directly.'
  if (file.size > MAX_IMAGE_BYTES) return 'Direct images must be 5 MiB or smaller.'
  return undefined
}

// ── Labels and markers ──

export type AttachmentKind = 'Image' | 'File' | 'Folder' | 'Session'

/** The kind a record is labelled by: what it IS to the agent, which is its
 *  delivery — a HEIC that goes as a path is a File, however it is named,
 *  and a folder is a Folder, a path to list. */
export function attachmentKind(file: Attachment): AttachmentKind {
  if (file.delivery === 'session') return 'Session'
  if (file.delivery === 'folder') return 'Folder'
  return file.delivery === 'image' ? 'Image' : 'File'
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

/** The marker a record is written as in the text; nothing for a record that
 *  carries no label (one from before labels existed). */
export function markerOf(file: Pick<Attachment, 'label'>): string | undefined {
  return file.label ? `[${file.label}]` : undefined
}

/** `text` with `marker` inserted at `at`: spaced off from what is around it,
 *  and followed by a space so the reader types straight on. Returns the new
 *  text and where the caret lands. */
export function insertMarker(
  text: string,
  marker: string,
  at: number
): { text: string; caret: number } {
  const index = Math.max(0, Math.min(at, text.length))
  const before = text.slice(0, index)
  const after = text.slice(index)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && /^\S/.test(after) ? ' ' : after ? '' : ' '
  const insert = `${lead}${marker}${trail}`
  // A space already there after the marker is the one the reader types past.
  const skip = !trail && after.startsWith(' ') ? 1 : 0
  return { text: before + insert + after, caret: before.length + insert.length + skip }
}

/** `text` without `marker`, every occurrence, and without the one space that
 *  followed each so the words around close up. */
export function removeMarker(text: string, marker: string): string {
  let out = text
  let index = out.indexOf(marker)
  while (index !== -1) {
    const end = index + marker.length
    const trailing = out[end] === ' ' ? 1 : 0
    out = out.slice(0, index) + out.slice(end + trailing)
    index = out.indexOf(marker)
  }
  return out
}

/** The records whose marker is still in `text`: the reader editing a marker
 *  out of the message — `[Session #1]` to `[Session #1` — takes the
 *  attachment with it. A record with no label is kept: nothing in the text
 *  can speak for it. */
export function reconcileAttachments<T extends Pick<Attachment, 'label'>>(
  text: string,
  files: readonly T[]
): T[] {
  return files.filter((file) => {
    const marker = markerOf(file)
    return !marker || text.includes(marker)
  })
}
