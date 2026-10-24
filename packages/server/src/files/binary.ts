import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

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
