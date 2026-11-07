import * as nodeFs from 'node:fs'

/**
 * The incremental reader: each call reads only the bytes appended since the last one.
 * `offset` counts BYTES. A line cut by the end of the data is held in `partial` and
 * completed by the next read; a UTF-8 character cut by the end of the data is never
 * decoded half: its leading bytes stay unread and are read again next time.
 */

export interface FileCursor {
  path: string
  offset: number
  partial: string
  /** The last message ids counted from this file, newest last (see `rememberSeen`). */
  seen: string[]
}

export interface ReadResult {
  lines: string[]
  cursor: FileCursor
  reset: boolean
  /** The bytes read from disk by this call. */
  bytesRead: number
}

export type ReaderFs = Pick<typeof nodeFs, 'statSync' | 'openSync' | 'readSync' | 'closeSync'>

export function newCursor(path: string): FileCursor {
  return { path, offset: 0, partial: '', seen: [] }
}

const NEWLINE = 0x0a
const CHUNK = 1 << 20

/** How many bytes at the end of `buf` start a UTF-8 character that is not complete yet. */
export function incompleteTail(buf: Uint8Array): number {
  const n = buf.length
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = buf[n - back]!
    if ((byte & 0xc0) === 0x80) continue // a continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? back : 0
  }
  return 0
}

function readRange(fs: ReaderFs, path: string, from: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const fd = fs.openSync(path, 'r')
  try {
    let got = 0
    while (got < length) {
      const n = fs.readSync(fd, buf, got, Math.min(CHUNK, length - got), from + got)
      if (n <= 0) break
      got += n
    }
    return got === length ? buf : buf.subarray(0, got)
  } finally {
    fs.closeSync(fd)
  }
}

export function readMore(cursor: FileCursor, fs: ReaderFs = nodeFs): ReadResult {
  let size: number
  try {
    size = fs.statSync(cursor.path).size
  } catch {
    return { lines: [], cursor, reset: false, bytesRead: 0 }
  }
  let reset = false
  let start = cursor
  if (size < cursor.offset) {
    reset = true
    start = { path: cursor.path, offset: 0, partial: '', seen: [] }
  }
  if (size === start.offset) return { lines: [], cursor: start, reset, bytesRead: 0 }

  const data = readRange(fs, start.path, start.offset, size - start.offset)
  const lastNewline = data.lastIndexOf(NEWLINE)
  const complete = lastNewline >= 0 ? data.subarray(0, lastNewline + 1) : data.subarray(0, 0)
  const rest = data.subarray(lastNewline + 1)
  const held = rest.length - incompleteTail(rest)

  const text = start.partial + complete.toString('utf8')
  const lines = lastNewline >= 0 ? text.split('\n') : []
  // `text` ends with the newline, so the last piece is always empty.
  if (lines.length > 0) lines.pop()
  const partial = (lastNewline >= 0 ? '' : start.partial) + rest.subarray(0, held).toString('utf8')

  return {
    lines: lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)),
    cursor: {
      path: start.path,
      offset: start.offset + complete.length + held,
      partial,
      seen: start.seen
    },
    reset,
    bytesRead: data.length
  }
}
