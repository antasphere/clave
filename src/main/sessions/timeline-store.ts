import * as fs from 'node:fs'
import { join } from 'node:path'
import type { HistoryItem } from '../../shared/session-model'
import { privateDirectory } from '../ports/private-files'

/** One run of a chat, on disk: the launch replay first, then every live
 *  event, one item per line, append-only. Nothing is evicted, so a reader
 *  that arrives late pages the whole conversation by position (PRDCT-4666). */
export interface TimelineFile {
  /** Items appended so far (the next index). */
  readonly length: number
  append(item: HistoryItem): void
  /** Items [start, end), oldest first. */
  slice(start: number, end: number): HistoryItem[]
  close(): void
}

function fileOf(directory: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid timeline session id')
  return join(directory, `${sessionId}.jsonl`)
}

/** The file's lines, by byte offset: `offsets[i]` is where line i begins and
 *  `offsets[length]` where the next one will. */
function timelineFile(fd: number, offsets: number[], writable: boolean): TimelineFile {
  let open = true
  return {
    get length() {
      return offsets.length - 1
    },
    append(item) {
      if (!writable) throw new Error('This timeline file is read-only')
      if (!open) throw new Error('This timeline file is closed')
      const line = Buffer.from(JSON.stringify(item) + '\n')
      let written = 0
      while (written < line.length)
        written += fs.writeSync(fd, line, written, line.length - written)
      offsets.push(offsets[offsets.length - 1] + line.length)
    },
    slice(start, end) {
      if (!open) throw new Error('This timeline file is closed')
      const count = offsets.length - 1
      const from = Math.max(0, Math.min(start, count))
      const to = Math.max(from, Math.min(end, count))
      if (from === to) return []
      const length = offsets[to] - offsets[from]
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const n = fs.readSync(fd, buffer, read, length - read, offsets[from] + read)
        if (n === 0) throw new Error('This timeline file ended early')
        read += n
      }
      const lines = buffer.toString('utf8').split('\n')
      lines.pop()
      return lines.map((line) => JSON.parse(line) as HistoryItem)
    },
    close() {
      if (!open) return
      open = false
      fs.closeSync(fd)
    }
  }
}

/** A new run: creates the directory (private), truncates the file, opens it for append. */
export function writeTimelineFile(directory: string, sessionId: string): TimelineFile {
  const file = fileOf(directory, sessionId)
  privateDirectory(directory)
  const fd = fs.openSync(
    file,
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_APPEND |
      fs.constants.O_NOFOLLOW,
    0o600
  )
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('A timeline file must be a regular file owned by this user')
    // A file left by another mode is made private before anything is written.
    if ((stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  return timelineFile(fd, [0], true)
}

/** A finished run, read-only: scans the file once for line offsets; a trailing
 *  partial line (a crash mid-write) is ignored. `undefined` when there is no file. */
export function readTimelineFile(directory: string, sessionId: string): TimelineFile | undefined {
  const file = fileOf(directory, sessionId)
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('A timeline file must be owned by this user with mode 0600')
    const offsets = [0]
    const chunk = Buffer.alloc(1024 * 1024)
    let position = 0
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, position)
      if (n === 0) break
      for (let i = 0; i < n; i++) if (chunk[i] === 0x0a) offsets.push(position + i + 1)
      position += n
    }
    return timelineFile(fd, offsets, false)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

export function removeTimelineFile(directory: string, sessionId: string): void {
  fs.rmSync(fileOf(directory, sessionId), { force: true })
}
