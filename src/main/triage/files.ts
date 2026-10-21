/**
 * The triage's bounded reads (issue #227), without Electron so they are
 * tested on real files. A triage runs inside the app's main process, so a
 * read that blocks or grows without bound would freeze the very app it
 * describes, whatever deadline the promise around it has:
 *
 *  - a file is opened non-blocking and without following a link, and the
 *    DESCRIPTOR is checked to be a regular file (a FIFO swapped in after a
 *    stat would block a plain read forever), then at most `max + 1` bytes
 *    are read, so a file that grew past its bound is refused, not loaded;
 *  - an HTTP body is read up to its cap and the rest cancelled;
 *  - the command line contributes only the flags Clave defines, by name,
 *    with a value only where the value is one Clave itself chooses.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { RawRecordFile } from './collect'

/** A discovery file is small; anything bigger is not read. */
export const MAX_JSON_BYTES = 256 * 1024
/** A session record is smaller still. */
export const MAX_RECORD_BYTES = 64 * 1024
/** How much of a health body is kept. */
export const MAX_BODY_BYTES = 4096

/** Read at most `maxBytes` of a regular file; null when it does not exist.
 *  Throws for a link, a FIFO or any other non-regular file, and for a file
 *  larger than the bound, before or during the read. */
export function readBoundedFile(file: string, maxBytes: number): Buffer | null {
  let fd: number
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0)
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw new Error(`${path.basename(file)} is a link; it is not read`)
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a regular file`)
    if (stat.size > maxBytes)
      throw new Error(`${path.basename(file)} is larger than ${maxBytes} bytes`)
    const buffer = Buffer.alloc(maxBytes + 1)
    let read = 0
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, read)
      if (n === 0) break
      read += n
    }
    if (read > maxBytes) throw new Error(`${path.basename(file)} is larger than ${maxBytes} bytes`)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

/** A bounded JSON file, parsed; null when it does not exist. */
export function readBoundedJson(file: string, maxBytes = MAX_JSON_BYTES): unknown {
  const bytes = readBoundedFile(file, maxBytes)
  if (bytes === null) return null
  try {
    return JSON.parse(bytes.toString('utf-8'))
  } catch {
    // The parser's own message quotes the text around the fault, which in a
    // discovery file can be its token: say what failed, never where.
    throw new Error(`${path.basename(file)} is not valid JSON`)
  }
}

/** The record files of a directory, read as bounded regular files only;
 *  one that cannot be read is listed with no content, never repaired or
 *  removed here. */
export function readRecordFiles(
  dir: string,
  max: number
): { total: number; files: RawRecordFile[] } {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, files: [] }
    throw error
  }
  if (!stat.isDirectory()) throw new Error('the session records folder is not a plain directory')
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
  const files: RawRecordFile[] = []
  for (const name of names.slice(0, max)) {
    let content: unknown = null
    try {
      content = readBoundedJson(path.join(dir, name), MAX_RECORD_BYTES)
    } catch {
      // unreadable: projected away by the assembler
    }
    files.push({ key: name.slice(0, -'.json'.length), content })
  }
  return { total: names.length, files }
}

/** A response body up to `maxBytes`, the rest cancelled, decoded as text. */
export async function readBoundedBody(
  response: Response,
  maxBytes = MAX_BODY_BYTES
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value.subarray(0, maxBytes - size))
      size += Math.min(value.length, maxBytes - size)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** The flags Clave defines that say how this instance runs. Each is kept by
 *  name; a value only for `--server`, whose values Clave fixes. Anything
 *  else on the command line (paths, other programs' flags, values) is not
 *  collected. */
const KNOWN_FLAGS = new Set([
  '--test-no-activate',
  '--test-no-machine-usage',
  '--test-version',
  '--dev-echo-adapter',
  '--dev-echo-view'
])
const SERVER_MODES = new Set(['in-process', 'separate'])

export function modeFlags(argv: readonly string[]): string[] {
  const flags: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--server' || a.startsWith('--server=')) {
      const value = a === '--server' ? argv[++i] : a.slice('--server='.length)
      flags.push(SERVER_MODES.has(value ?? '') ? `--server=${value}` : '--server=<other>')
      continue
    }
    const name = a.split('=')[0]
    if (KNOWN_FLAGS.has(name)) flags.push(name)
  }
  return flags
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is somebody else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
