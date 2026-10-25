import { realpath, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import {
  FILE_TREE_IGNORED,
  MAX_FILE_ENTRIES,
  FilesWatchInput,
  FileAttachment,
  FileLocation,
  FileOperationFailed,
  MAX_PREVIEW_BYTES,
  MAX_TEXT_BYTES,
  MAX_TRANSFER_BYTES,
  PrepareFileAttachmentInput,
  PreviewFileAttachmentInput,
  UploadFileInput,
  WriteFileInput
} from '@clave/contract/files'
import type { FilesService } from './port'
import { imageMime } from './binary'
import { secureFiles } from './platform'
import type { FileTreeWatcher } from './watch'

export interface ServerFilesOptions {
  readonly watcher?: FileTreeWatcher
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
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (error instanceof FileOperationFailed && error.code === 'not_found')
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
  const capture = <T>(
    promise: Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
  const unwrap = async <T>(promise: ReturnType<typeof capture<T>>): Promise<T> => {
    const result = await promise
    if (!result.ok) throw result.error
    return result.value
  }
  // Configuration roots are resolved once. Re-resolving an allowlist after an
  // attacker exchanges a root for a link would authorize the link's new target.
  const policy = capture(Promise.all((options.roots ?? []).map((path) => realpath(path))))
  const storage = capture(
    (async () => {
      let ancestor = resolve(options.attachmentsRoot)
      const suffix: string[] = []
      for (;;) {
        try {
          return join(await realpath(ancestor), ...suffix.reverse())
        } catch (error) {
          if (!missing(error)) throw error
          suffix.push(basename(ancestor))
          ancestor = dirname(ancestor)
        }
      }
    })()
  )
  const checkedRoot = async (root: string): Promise<string> => {
    if (!isAbsolute(root) || root.includes('\0'))
      fail('invalid_path', 'Choose an absolute server directory.')
    const allowed = await unwrap(policy)
    const canonical = await realpath(root)
    if (options.roots && !allowed.some((path) => within(path, canonical)))
      fail('invalid_path', 'Directory is outside the allowed roots.')
    if ((await secureFiles.stat(canonical)).type !== 'directory')
      fail('invalid_path', 'Choose a server directory.')
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
      const leaf = await secureFiles.stat(target).catch((e: unknown) => {
        if (!missing(e)) throw e
        return null
      })
      if (leaf) fail('invalid_path', 'Invalid destination.')
      canonical = join(await realpath(dirname(target)), basename(target))
    }
    if (!within(root, canonical)) fail('invalid_path', 'File is outside the requested directory.')
    return canonical
  }
  const read = secureFiles.read
  const bounded = async (path: string, limit: number): Promise<Buffer> => {
    const sample = await read(path, limit + 1)
    if (sample.size > limit || sample.bytes.length > limit)
      fail('too_large', 'The file exceeds the transfer limit.')
    if (sample.size !== sample.bytes.length)
      fail('invalid_data', 'File changed while it was being read.')
    return sample.bytes
  }
  const sessionDirectory = async (sessionId: string): Promise<string> => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) fail('invalid_path', 'Invalid session.')
    const path = join(await unwrap(storage), sessionId)
    await secureFiles.mkdirp(path)
    return path
  }
  const attachment = (id: string, path: string, name: string, size: number): FileAttachment => {
    const mimeType = mimeOf(name)
    // Validate the whole response before any managed bytes are persisted.
    return Schema.decodeUnknownSync(FileAttachment)({
      id,
      path,
      name,
      size,
      mimeType,
      delivery: mimeType.startsWith('image/') ? 'image' : 'reference'
    })
  }
  const service: FilesService = {
    onEvent: (listener) => options.watcher?.onEvent(listener) ?? (() => {}),
    dispose: () => options.watcher?.dispose(),
    async syncWatch(input) {
      Schema.decodeUnknownSync(FilesWatchInput)(input)
      if (!options.watcher) return { watched: [] }
      return options.watcher.sync(input, checkedRoot)
    },
    async listAll({ root }) {
      const canonical = await checkedRoot(root)
      const files: string[] = []
      const ignored = new Set<string>(FILE_TREE_IGNORED)
      let truncated = false
      const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
          if (!prefix) throw error
          return []
        })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (entry.name.startsWith('.') || ignored.has(entry.name)) continue
          const path = join(dir, entry.name)
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            // Check the canonical path before descending into a folder.
            if ((await realpath(path).catch(() => null)) !== path) continue
            await walk(path, rel)
          } else if (
            entry.isFile() ||
            (entry.isSymbolicLink() && (await stat(path).catch(() => null))?.isFile())
          ) {
            files.push(rel)
            if (files.length >= MAX_FILE_ENTRIES) {
              truncated = true
              return
            }
          }
          if (truncated) return
        }
      }
      await walk(canonical, '')
      return { files: files.sort(), truncated }
    },
    async list(input) {
      const listing = await secureFiles.list(await locate(input))
      const entries = listing.entries.map((entry) => ({
        ...entry,
        path: join(input.path, entry.name)
      }))
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
      )
      return { entries, truncated: listing.truncated }
    },
    async stat(input) {
      return secureFiles.stat(await locate(input))
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
      await secureFiles.write(await locate(input, true), bytes)
    },
    async upload(input) {
      Schema.decodeUnknownSync(UploadFileInput)(input)
      const bytes = decodeFileBytes(input.base64)
      const path = await locate(input, true)
      // Uploads do not silently overwrite a repository file.
      await secureFiles.create(path, bytes)
    },
    async createFile(input) {
      await secureFiles.create(await locate(input, true))
    },
    async createDirectory(input) {
      await secureFiles.mkdir(await locate(input, true))
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
          const suffix = `.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`
          let stem = ''
          for (const point of name.replace(/\.[^.]+$/, '')) {
            if (stem.length + point.length > 255 - suffix.length) break
            stem += point
          }
          name = `${stem}${suffix}`
        }
        // Picked files keep their original MIME/delivery. The existing
        // send-time validator checks magic and offers an explicit reference
        // choice for a corrupt or unsupported image, just as for local files.

        path = join(directory, `${id}${extname(name).toLowerCase().slice(0, 16)}`)
        const result = attachment(id, path, name, bytes.length)
        await secureFiles.create(path, bytes)
        return result
      } else {
        path = await locate(input.source)
        const info = await secureFiles.stat(path)
        if (info.type !== 'file') fail('not_file', 'Folders and special files cannot be attached.')
        name = basename(path)
        // A temporary server file must survive the source's removal, just as
        // a temporary Mac attachment does. Durable remote references stay put.
        if (
          /^(\/private)?\/(tmp\/|var\/folders\/)/i.test(path) ||
          /\/temporaryitems\//i.test(path)
        ) {
          if (info.size > 100 * 1024 * 1024)
            fail('too_large', 'Temporary files must be 100 MiB or smaller.')
          const bytes = await bounded(path, 100 * 1024 * 1024)
          path = join(directory, `${id}${extname(name).toLowerCase().slice(0, 16)}`)
          const result = attachment(id, path, name, bytes.length)
          await secureFiles.create(path, bytes)
          return result
        }
        return attachment(id, path, name, info.size)
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
    onEvent: service.onEvent,
    dispose: service.dispose,
    syncWatch: protect(service.syncWatch),
    listAll: protect(service.listAll),
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
