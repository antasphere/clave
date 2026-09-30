import { z } from 'zod'

/* Files a reader attaches to a chat message. The attachment record is what the
   composer holds and what the transcript shows: a name, a local path, and how
   it is DELIVERED — an image goes to the provider as image content, anything
   else as a reference the agent reads with its own tools. Bytes never cross the
   renderer: the main process reads the file once the message is sent. */

export const MAX_ATTACHMENTS = 10
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
/** The formats providers accept as image content. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export const AttachmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().nonnegative(),
    delivery: z.enum(['reference', 'image'])
  })
  .strict()
export const AttachmentsSchema = z.array(AttachmentSchema).max(MAX_ATTACHMENTS)
export type Attachment = z.infer<typeof AttachmentSchema>

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
