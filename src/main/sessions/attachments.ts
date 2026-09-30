import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AttachmentsSchema,
  attachmentIssue,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type Attachment,
  type AttachmentSource,
  type ProviderImage
} from '../../shared/attachments'
import type { PreparedPrompt } from '../../shared/session-model'

/* Attachments, main side. Two moments: `prepareAttachment` when a file is
   added to the composer (validate it, copy it out of a temp folder, name its
   type), and `preparePrompt` when the message is sent (read the images, append
   the references). Everything here treats a path as data — nothing is ever
   passed to a shell. */

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf'
}
/** The image format the BYTES say they are, from the magic number; the name
 *  is what the user called it, and a renamed file must not go to a provider
 *  under the wrong media type. */
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp'
  return undefined
}
/** Read a whole file no larger than `limit`, refusing FIFOs and files that
 *  grow while being read: the size is checked on the open handle, and one
 *  byte more than it arriving means a different file from the one measured. */
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Folders and special files cannot be attached.')
    if (info.size > limit)
      throw new Error(
        'File is too large for a preview or a direct image. Send it as a file reference.'
      )
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > info.size) throw new Error('File changed while it was being read. Try again.')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}
/** macOS keeps an unsaved screenshot preview in a temp folder and deletes it
 *  the moment the preview commits; anything under the OS temp roots is copied. */
function transient(path: string): boolean {
  return /^(\/private)?\/(tmp\/|var\/folders\/)/i.test(path) || /\/temporaryitems\//i.test(path)
}
/** Take a file into the composer: a path is validated and, when it lives in a
 *  temp folder, copied under `directory`; bytes (a pasted image) are written
 *  there under the type their magic number names. Managed copies live as long
 *  as the app profile, unlike the terminal's seven-day drop cache: a chat's
 *  transcript still points at them after a restart. */
export async function prepareAttachment(
  directory: string,
  source: AttachmentSource
): Promise<Attachment> {
  const id = randomUUID()
  let path = source.path
  let name = path ? basename(path) : basename(source.name || 'Pasted image.png')
  if (source.bytes) {
    if (path || source.bytes.byteLength > MAX_IMAGE_BYTES || !source.bytes.byteLength)
      throw new Error('Pasted images must be 5 MiB or smaller.')
    const bytes = Buffer.from(source.bytes)
    const mime = imageMime(bytes)
    if (!mime) throw new Error('Only PNG, JPEG, GIF and WebP images can be pasted.')
    name = `${name.replace(/\.[^.]+$/, '')}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    path = join(directory, `${id}-${name}`)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
  } else {
    if (!path || !isAbsolute(path) || path.includes('\0')) throw new Error('Choose a local file.')
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Folders and special files cannot be attached.')
    await access(path, constants.R_OK)
    if (transient(path)) {
      if (info.size > 100 * 1024 * 1024)
        throw new Error(
          'Temporary files must be 100 MiB or smaller. Save the file to a permanent folder first.'
        )
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = join(directory, `${id}-${name}`)
      await copyFile(path, target, constants.COPYFILE_EXCL)
      path = target
    }
  }
  const info = await stat(path)
  const mimeType = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
  return {
    id,
    path,
    name,
    mimeType,
    size: info.size,
    delivery: mimeType.startsWith('image/') ? 'image' : 'reference'
  }
}
/** Build what the provider receives. Every attachment is checked again here,
 *  at send time — the file may have moved since it was added, and a
 *  renderer's record of a file is never taken on trust. References are
 *  appended to the text as one line per file; images are read and encoded,
 *  and only go when the adapter takes image content. */
export async function preparePrompt(
  text: string,
  input: unknown,
  imagesSupported: boolean
): Promise<PreparedPrompt> {
  const attachments = AttachmentsSchema.parse(input ?? [])
  let total = 0
  const images: ProviderImage[] = []
  const references: string[] = []
  for (const file of attachments) {
    if (!isAbsolute(file.path)) throw new Error('Attachment paths must be absolute.')
    const info = await stat(file.path).catch(() => {
      throw new Error(`File is unavailable: ${file.name}. Remove it or choose it again.`)
    })
    if (!info.isFile()) throw new Error('Folders and special files cannot be attached.')
    await access(file.path, constants.R_OK)
    if (file.delivery === 'reference') {
      references.push(JSON.stringify({ name: file.name, path: file.path }))
      continue
    }
    const issue = attachmentIssue({ ...file, size: info.size }, imagesSupported)
    if (issue) throw new Error(`${file.name}: ${issue} Choose Send as file reference.`)
    total += info.size
    if (total > MAX_TOTAL_IMAGE_BYTES)
      throw new Error('Images in one message must total 20 MiB or less.')
    const bytes = await readBounded(file.path, MAX_IMAGE_BYTES)
    const mimeType = imageMime(bytes)
    if (!mimeType || mimeType !== file.mimeType)
      throw new Error(`${file.name}: image contents do not match the file format.`)
    images.push({ name: file.name, mimeType, data: bytes.toString('base64') })
  }
  const suffix = references.length
    ? `Attached local files (read the current contents at these paths):\n${references.join('\n')}`
    : ''
  return { text: [text, suffix].filter(Boolean).join('\n\n'), images }
}
