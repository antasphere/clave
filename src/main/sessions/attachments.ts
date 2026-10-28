import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FOLDER_MIME_TYPE, mimeTypeOf } from '@clave/contract/attachments'
import {
  AttachmentsSchema,
  attachmentIssue,
  IMAGE_MIME_TYPES,
  markerOf,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type FileAttachment,
  type AttachmentSource,
  type ProviderImage
} from '../../shared/attachments'
import type { PreparedPrompt } from '../../shared/session-model'
import { imageMime, readBounded } from '../../../packages/server/src/files/binary'
export { imageMime, readBounded } from '../../../packages/server/src/files/binary'

/* Attachments, main side. Two moments: `prepareAttachment` when a file is
   added to the composer (validate it, copy it out of a temp folder, name its
   type), and `preparePrompt` when the message is sent (read the images, append
   the references). Everything here treats a path as data — nothing is ever
   passed to a shell. */

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
): Promise<FileAttachment> {
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
    await access(path, constants.R_OK)
    // A folder is a record of its own: its path, for the agent to list, and
    // its top-level item count, for the reader. Never copied, never read.
    if (info.isDirectory())
      return {
        id,
        path,
        name,
        mimeType: FOLDER_MIME_TYPE,
        size: 0,
        entries: (await readdir(path)).length,
        delivery: 'folder'
      }
    if (!info.isFile()) throw new Error('Special files cannot be attached.')
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
  const mimeType = mimeTypeOf(name)
  // An image in a format no provider takes as image content (HEIC, SVG,
  // AVIF) is a file from the start: the agent gets its path and does what it
  // can with it, rather than the composer refusing the message until the
  // reader finds the downgrade button.
  return {
    id,
    path,
    name,
    mimeType,
    size: info.size,
    delivery: IMAGE_MIME_TYPES.includes(mimeType) ? 'image' : 'reference'
  }
}
/** Build what the provider receives. Every file is checked again here, at
 *  send time — the file may have moved since it was added, and a renderer's
 *  record of a file is never taken on trust. Images are read and encoded, and
 *  only go when the adapter takes image content; files and sessions are
 *  appended to the text as one line each, keyed by the marker the text
 *  refers to them by (`[File #1]`, `[Session #1]`), so the agent reads
 *  "finish when [Session #1] is done" and knows which tab that is. */
export async function preparePrompt(
  text: string,
  input: unknown,
  imagesSupported: boolean
): Promise<PreparedPrompt> {
  const attachments = AttachmentsSchema.parse(input ?? [])
  let total = 0
  const images: ProviderImage[] = []
  const lines: string[] = []
  const key = (file: { label?: string }): string => (markerOf(file) ? markerOf(file) + ' ' : '')
  for (const file of attachments) {
    if (file.delivery === 'session') {
      lines.push(
        key(file) +
          JSON.stringify({
            session: file.sessionId,
            name: file.name,
            agent: file.agent,
            cwd: file.cwd
          })
      )
      continue
    }
    if (!isAbsolute(file.path)) throw new Error('Attachment paths must be absolute.')
    const info = await stat(file.path).catch(() => {
      throw new Error(`File is unavailable: ${file.name}. Remove it or choose it again.`)
    })
    await access(file.path, constants.R_OK)
    if (file.delivery === 'folder') {
      if (!info.isDirectory())
        throw new Error(`Folder is unavailable: ${file.name}. Remove it or choose it again.`)
      lines.push(key(file) + JSON.stringify({ folder: file.name, path: file.path }))
      continue
    }
    if (!info.isFile()) throw new Error('Special files cannot be attached.')
    if (file.delivery === 'reference') {
      lines.push(key(file) + JSON.stringify({ name: file.name, path: file.path }))
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
    if (file.label) lines.push(key(file) + JSON.stringify({ image: file.name }))
  }
  const has = (delivery: string): boolean => attachments.some((f) => f.delivery === delivery)
  const legend = [
    'Attachments, by the marker the message refers to them by:',
    has('image') ? '- an image: sent with this message as image content.' : '',
    has('reference') ? '- a local file: read the current contents at its path.' : '',
    has('folder') ? '- a local folder: list and read its contents at its path.' : '',
    has('session')
      ? '- a Clave session (another tab of this app): read it with clave_read_session, message it with clave_send_to_session, by its session id.'
      : ''
  ].filter(Boolean)
  const suffix = lines.length ? [...legend, ...lines].join('\n') : ''
  return { text: [text, suffix].filter(Boolean).join('\n\n'), images }
}
