/** Privileged Mac-side conversion. Only bytes cross to a remote server; a
 * local path is consumed here and is never a remote attachment reference. */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import {
  AttachmentSource as WireAttachmentSource,
  FileDownload,
  MAX_TRANSFER_BYTES
} from '@clave/contract/files'
import type { AttachmentSource } from '../../shared/attachments'
import { imageMime, readBounded } from '../sessions/attachments'
import { decodeFileBytes } from '../../../packages/server/src/files/service'

/** Native picker/drop sources are files; clipboard sources are pasted images.
 * The upload limit is explicit and never downgrades an image to a reference. */
export async function localAttachmentUpload(
  source: AttachmentSource
): Promise<WireAttachmentSource> {
  if (source.path && source.bytes) throw new Error('Choose one attachment source.')
  let bytes: Buffer
  let name: string
  let image: boolean
  if (source.path) {
    if (!isAbsolute(source.path) || source.path.includes('\0'))
      throw new Error('Choose a local file.')
    bytes = await readBounded(source.path, MAX_TRANSFER_BYTES)
    name = basename(source.path)
    image = false
  } else {
    bytes = Buffer.from(source.bytes ?? [])
    if (!bytes.length || bytes.length > MAX_TRANSFER_BYTES || !imageMime(bytes)) {
      throw new Error('Pasted images must be PNG, JPEG, GIF or WebP and 5 MiB or smaller.')
    }
    name = basename(source.name || 'Pasted image.png')
    image = true
  }
  return Schema.decodeUnknownSync(WireAttachmentSource)({
    kind: 'upload',
    name,
    base64: bytes.toString('base64'),
    image
  })
}

/** Validate the entire response before a downloaded file can be written or
 * opened on this Mac. The remote filename can never select a local directory. */
export function remoteDownloadBytes(input: unknown): { name: string; bytes: Buffer } {
  const value = Schema.decodeUnknownSync(FileDownload)(input)
  const bytes = decodeFileBytes(value.base64)
  if (bytes.length !== value.size)
    throw new Error('Downloaded file size does not match its contents.')
  return { name: value.name, bytes }
}
export async function saveRemoteDownload(directory: string, input: unknown): Promise<string> {
  const { name, bytes } = remoteDownloadBytes(input)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${randomUUID()}${extname(name).slice(0, 16)}`)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return path
}
