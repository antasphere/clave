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
  /** The document's text, or null when there is none: a missing file is not an error. */
  read(name: string): string | null
  /** Replace the document atomically (write, then rename), creating the folders. */
  write(name: string, text: string, options?: { mode?: number }): void
  /** Forget a document. Nothing happens when there is none. */
  remove(name: string): void
}

/** The one storage adapter: JSON documents as files under `dir`. */
export function fileStorage(dir: string): StoragePort {
  const target = (name: string): string => path.join(dir, name)
  return {
    pathOf: target,
    read(name) {
      try {
        return fs.readFileSync(target(name), 'utf-8')
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
