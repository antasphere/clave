import * as fs from 'fs'
import * as path from 'path'

/**
 * Where a settings domain keeps its documents: JSON files, and the odd folder
 * another program is pointed at (a Codex home), under one data directory the
 * port owns. A domain names a document by its file name and never learns
 * where the directory is, except through `pathOf`, which exists for the one
 * domain that must hand a path to another process.
 *
 * Synchronous on purpose: the PTY layer stamps a spawn with an account's
 * token and a cwd's workspace without an async hop, and every manager behind
 * this port is a synchronous cache over its file.
 *
 * Two adapters, both `fileStorage` on a different directory: Electron's own
 * data folder while the server runs inside the app (`electron.ts`), a
 * configured directory for the standalone server (`standalone.ts`).
 */
export interface StoragePort {
  /** The absolute path of a document or folder, for a program that needs one. */
  pathOf(name: string): string
  /** Legacy best-effort read: null for a missing or unreadable document. */
  read(name: string): string | null
  /** A preservation-sensitive read: null only for ENOENT; all other I/O
   * errors throw. Optional so existing adapters/mocks keep their contract.
   * Domains requiring this guarantee must refuse adapters without it. */
  readChecked?(name: string): string | null
  /** Replace the document atomically (write, then rename), creating the folders. */
  write(name: string, text: string, options?: { mode?: number }): void
  /** Forget a document. Nothing happens when there is none. */
  remove(name: string): void
  /** The names of the documents directly under a folder, unordered; empty
   *  when the folder is not there. A domain that keeps one document per
   *  record (the session records) reads its folder through this. */
  list(folder: string): string[]
}

/** The one storage adapter: JSON documents as files under `dir`. */
export function fileStorage(dir: string): StoragePort {
  const target = (name: string): string => path.join(dir, name)
  const readChecked = (name: string): string | null => {
    try {
      return fs.readFileSync(target(name), 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return {
    pathOf: target,
    readChecked,
    read(name) {
      try {
        return readChecked(name)
      } catch {
        return null
      }
    },
    write(name, text, options) {
      const file = target(name)
      // Write-then-rename: a kill mid-write can never leave a truncated file.
      const tmp = `${file}.tmp`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // A mode is applied when the file is created, never to a file that is
      // already there: a temp file left by a kill mid-write is dropped first.
      fs.rmSync(tmp, { force: true })
      fs.writeFileSync(tmp, text, options?.mode === undefined ? 'utf-8' : { mode: options.mode })
      fs.renameSync(tmp, file)
    },
    remove(name) {
      fs.rmSync(target(name), { force: true })
    },
    list(folder) {
      try {
        return fs
          .readdirSync(target(folder), { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    }
  }
}

/** The document parsed, or null when it is missing or not JSON. */
export function readJson(storage: StoragePort, name: string): unknown {
  const text = storage.read(name)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function writeJson(
  storage: StoragePort,
  name: string,
  value: unknown,
  options?: { mode?: number }
): void {
  storage.write(name, JSON.stringify(value, null, 2), options)
}
