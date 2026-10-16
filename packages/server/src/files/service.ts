import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  opendir,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import {
  FileLocation,
  FileOperationFailed,
  MAX_FILE_ENTRIES,
  MAX_PREVIEW_BYTES,
  MAX_TEXT_BYTES,
  MAX_TRANSFER_BYTES,
  PrepareFileAttachmentInput,
  PreviewFileAttachmentInput,
  UploadFileInput,
  WriteFileInput
} from '@clave/contract/files'
import type { FilesService } from './port'
import { imageMime, readBounded } from './binary'

export interface ServerFilesOptions {
  /** Private durable storage, shared with the session host, independent of clients. */
  readonly attachmentsRoot: string
  /** Optional server-enforced allowlist. Absent means the authenticated user's
   * filesystem, as in the local file browser. Never derived from renderer state. */
  readonly roots?: readonly string[]
}
const fail = (code: FileOperationFailed['code'], message: string): never => {
  throw new FileOperationFailed({ code, message })
}
const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + (root.endsWith(sep) ? '' : sep))
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const mimeOf = (name: string): string =>
  ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.avif': 'image/avif',
    '.pdf': 'application/pdf'
  })[extname(name).toLowerCase()] ?? 'application/octet-stream'

/** Canonical base64 only. Buffer.from alone silently accepts malformed or
 * truncated input; neither a size declaration nor the filename is evidence. */
export function decodeFileBytes(base64: string): Buffer {
  if (base64.length > 4 * Math.ceil(MAX_TRANSFER_BYTES / 3))
    fail('too_large', 'Transfers must be 5 MiB or smaller.')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > MAX_TRANSFER_BYTES) fail('too_large', 'Transfers must be 5 MiB or smaller.')
  if (bytes.toString('base64') !== base64) fail('invalid_data', 'Invalid file encoding.')
  return bytes
}

export function createServerFiles(options: ServerFilesOptions): FilesService {
  if (!isAbsolute(options.attachmentsRoot) || options.attachmentsRoot.includes('\0'))
    throw new Error('attachmentsRoot must be absolute.')
  const checkedRoot = async (root: string): Promise<string> => {
    if (!isAbsolute(root) || root.includes('\0'))
      fail('invalid_path', 'Choose an absolute server directory.')
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) fail('invalid_path', 'Choose a server directory.')
    if (options.roots) {
      const allowed = await Promise.all(options.roots.map((path) => realpath(path)))
      if (!allowed.some((path) => within(path, canonical)))
        fail('invalid_path', 'Directory is outside the allowed roots.')
    }
    return canonical
  }
  const locate = async (input: FileLocation, create = false): Promise<string> => {
    Schema.decodeUnknownSync(FileLocation)(input)
    const root = await checkedRoot(input.root)
    // Resolve against the spelling provided by the caller before canonicalizing:
    // /tmp on macOS is a legitimate alias for /private/tmp.
    const lexicalRoot = resolve(input.root)
    const lexical = resolve(lexicalRoot, input.path)
    const target = within(lexicalRoot, lexical)
      ? resolve(root, relative(lexicalRoot, lexical))
      : within(root, lexical)
        ? lexical
        : fail('invalid_path', 'File is outside the requested directory.')
    let canonical: string
    try {
      canonical = await realpath(target)
    } catch (error) {
      if (!create || !missing(error)) throw error
      // Only the leaf may be new. A dangling symlink must never be followed.
      const leaf = await lstat(target).catch((e: unknown) => {
        if (!missing(e)) throw e
        return null
      })
      if (leaf) fail('invalid_path', 'Invalid destination.')
      canonical = join(await realpath(dirname(target)), basename(target))
    }
    if (!within(root, canonical)) fail('invalid_path', 'File is outside the requested directory.')
    return canonical
  }
  const read = async (path: string, limit: number): Promise<{ bytes: Buffer; size: number }> => {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    )
    try {
      const info = await handle.stat()
      if (!info.isFile()) fail('not_file', 'Only regular files are supported.')
      const bytes = Buffer.alloc(Math.min(info.size, limit))
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return { bytes: bytes.subarray(0, offset), size: info.size }
    } finally {
      await handle.close()
    }
  }
  const bounded = async (path: string, limit: number): Promise<Buffer> => {
    const info = await lstat(path)
    if (!info.isFile()) fail('not_file', 'Only regular files are supported.')
    if (info.size > limit) fail('too_large', 'Transfers must be 5 MiB or smaller.')
    const sample = await read(path, limit + 1)
    if (sample.size > limit || sample.bytes.length > limit)
      fail('too_large', 'Transfers must be 5 MiB or smaller.')
    if (sample.size !== sample.bytes.length)
      fail('invalid_data', 'File changed while it was being read.')
    return sample.bytes
  }
  const sessionDirectory = async (sessionId: string): Promise<string> => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) fail('invalid_path', 'Invalid session.')
    await mkdir(options.attachmentsRoot, { recursive: true, mode: 0o700 })
    const root = await realpath(options.attachmentsRoot)
    const path = join(root, sessionId)
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    if ((await lstat(path)).isSymbolicLink() || !(await stat(path)).isDirectory())
      fail('invalid_path', 'Invalid attachment storage.')
    return path
  }
  const save = async (path: string, bytes: Buffer): Promise<void> => {
    const info = await lstat(path).catch((error: unknown) => {
      if (!missing(error)) throw error
      return null
    })
    if (info && !info.isFile()) fail('not_file', 'Only regular files can be edited.')
    const temporary = join(dirname(path), `.clave-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { mode: info ? info.mode & 0o777 : 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const service: FilesService = {
    async list(input) {
      const path = await locate(input)
      const directory = await opendir(path)
      const entries: { name: string; path: string; type: 'file' | 'directory'; size: number }[] = []
      let scanned = 0
      let truncated = false
      for await (const entry of directory) {
        if (++scanned > MAX_FILE_ENTRIES) {
          truncated = true
          break
        }
        // Do not expose special files or links that may leave this root.
        if (!entry.isFile() && !entry.isDirectory()) continue
        const size = entry.isFile() ? (await stat(join(path, entry.name))).size : 0
        entries.push({
          name: entry.name,
          path: join(input.path, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file',
          size
        })
      }
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
      )
      return { entries, truncated }
    },
    async stat(input) {
      const info = await stat(await locate(input))
      if (!info.isFile() && !info.isDirectory())
        fail('not_file', 'Only regular files and directories are supported.')
      return {
        type: info.isDirectory() ? 'directory' : 'file',
        size: info.size,
        modified: info.mtimeMs
      }
    },
    async read(input) {
      const { bytes, size } = await read(await locate(input), MAX_TEXT_BYTES)
      const binary = bytes.includes(0)
      return {
        content: binary ? '' : bytes.toString('utf8'),
        binary,
        truncated: size > bytes.length,
        size
      }
    },
    async download(input) {
      const path = await locate(input)
      const bytes = await bounded(path, MAX_TRANSFER_BYTES)
      return { name: basename(path), base64: bytes.toString('base64'), size: bytes.length }
    },
    async write(input) {
      Schema.decodeUnknownSync(WriteFileInput)(input)
      const bytes = Buffer.from(input.content, 'utf8')
      if (bytes.length > MAX_TEXT_BYTES) fail('too_large', 'Text edits must be 1 MiB or smaller.')
      await save(await locate(input, true), bytes)
    },
    async upload(input) {
      Schema.decodeUnknownSync(UploadFileInput)(input)
      const bytes = decodeFileBytes(input.base64)
      const path = await locate(input, true)
      // Uploads do not silently overwrite a repository file.
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    },
    async createFile(input) {
      await writeFile(await locate(input, true), '', { flag: 'wx', mode: 0o600 })
    },
    async createDirectory(input) {
      await mkdir(await locate(input, true), { mode: 0o700 })
    },
    async prepareAttachment(input) {
      Schema.decodeUnknownSync(PrepareFileAttachmentInput)(input)
      const directory = await sessionDirectory(input.sessionId)
      const id = randomUUID()
      let path: string
      let name: string
      if (input.source.kind === 'upload') {
        const source = input.source
        const bytes = decodeFileBytes(source.base64)
        name = source.name
        if (source.image) {
          const mime = imageMime(bytes)
          if (!mime)
            return fail('invalid_data', 'Only PNG, JPEG, GIF and WebP images can be pasted.')
          if (!bytes.length) fail('invalid_data', 'Pasted images cannot be empty.')
          name = `${name.replace(/\.[^.]+$/, '')}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`
        }
        // Picked files keep their original MIME/delivery. The existing
        // send-time validator checks magic and offers an explicit reference
        // choice for a corrupt or unsupported image, just as for local files.

        path = join(directory, `${id}${extname(name).toLowerCase().slice(0, 16)}`)
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      } else {
        path = await locate(input.source)
        const info = await stat(path)
        if (!info.isFile()) fail('not_file', 'Folders and special files cannot be attached.')
        name = basename(path)
        // A temporary server file must survive the source's removal, just as
        // a temporary Mac attachment does. Durable remote references stay put.
        if (
          /^(\/private)?\/(tmp\/|var\/folders\/)/i.test(path) ||
          /\/temporaryitems\//i.test(path)
        ) {
          if (info.size > 100 * 1024 * 1024)
            fail('too_large', 'Temporary files must be 100 MiB or smaller.')
          const bytes = await readBounded(path, 100 * 1024 * 1024)
          path = join(directory, `${id}${extname(name).toLowerCase().slice(0, 16)}`)
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        }
      }
      const info = await stat(path)
      const mimeType = mimeOf(name)
      return {
        id,
        path,
        name,
        mimeType,
        size: info.size,
        delivery: mimeType.startsWith('image/') ? 'image' : 'reference'
      }
    },
    async previewAttachment(input) {
      Schema.decodeUnknownSync(PreviewFileAttachmentInput)(input)
      const directory = await sessionDirectory(input.sessionId)
      // Only this session's durable uploads can be previewed by attachment path.
      // Existing workspace files use read/download with their explicit root.
      const path = input.root
        ? await locate({ root: input.root, path: input.path })
        : await realpath(input.path)
      if (!input.root && !within(directory, path))
        fail('invalid_path', 'Attachment belongs to another session or server.')
      const mime = mimeOf(path)
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
        const bytes = await bounded(path, MAX_TRANSFER_BYTES)
        if (imageMime(bytes) !== mime)
          fail('invalid_data', 'Image contents do not match the file format.')
        return { image: `data:${mime};base64,${bytes.toString('base64')}` }
      }
      const { bytes, size } = await read(path, MAX_PREVIEW_BYTES)
      if (mime === 'application/pdf' || bytes.includes(0))
        return { notice: 'Download the file to view its contents.' }
      return {
        text: bytes.toString('utf8'),
        ...(size > bytes.length ? { notice: 'Showing the first 16 KiB.' } : {})
      }
    }
  }
  // Expected failures retain their code. OS failures expose no host paths.
  const protect =
    <I, O>(operation: (input: I) => Promise<O>) =>
    async (input: I): Promise<O> => {
      try {
        return await operation(input)
      } catch (error) {
        if (error instanceof FileOperationFailed) throw error
        if (missing(error)) fail('not_found', 'File or directory is unavailable.')
        if (error instanceof Error && error.name === 'ParseError')
          fail('invalid_data', 'Invalid file request.')
        return fail('io', 'The file operation failed.')
      }
    }
  return {
    list: protect(service.list),
    read: protect(service.read),
    stat: protect(service.stat),
    download: protect(service.download),
    write: protect(service.write),
    upload: protect(service.upload),
    createFile: protect(service.createFile),
    createDirectory: protect(service.createDirectory),
    prepareAttachment: protect(service.prepareAttachment),
    previewAttachment: protect(service.previewAttachment)
  }
}
