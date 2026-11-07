import * as fs from 'fs'
import * as path from 'path'
import { transcriptProjectDirName } from '../exchange-capture/contract/workstream-events'

/**
 * A peek at the TAIL of a Claude Code transcript: what the history row shows
 * without parsing the file.
 *
 * Claude Code writes, as it goes, two tail entries the row is made of —
 * `{"type":"ai-title","aiTitle":…}`, its own running title for the session,
 * and `{"type":"last-prompt","lastPrompt":…}`, the latest human message
 * verbatim (verified on 226 of 234 recent transcripts, 2026-08-25) — plus
 * timestamped `user` entries. Reading the last 64 KB gives the title, the
 * last prompt and the time of the last human message with one small read per
 * session, whatever the file's size (multi-megabyte is normal). A file that
 * ends in a long stretch of tool results may hold no human text in its last
 * 64 KB; a second, larger read covers that before giving up.
 *
 * No Electron imports; the transcripts root is injected so the tests (and the
 * E2E harness) point it at fixtures instead of `~/.claude/projects`.
 */

export interface TranscriptPeek {
  exists: boolean
  path: string
  /** The conversation's working directory, read from the transcript's own
   *  head records — the project DIR NAME is a lossy encoding, the records
   *  carry the truth. Null when the head holds none. */
  cwd: string | null
  /** The first timestamped record: when the conversation started. */
  firstAt: string | null
  /** `ai-title`, when the tail carries one. */
  title: string | null
  /** `last-prompt`, when the tail carries one. */
  lastPrompt: string | null
  /** Timestamp of the last user entry carrying human text (not a tool result,
   *  not injected context), or null when none was found. */
  lastHumanAt: string | null
  /** File mtime, ISO; the fallback ordering signal. */
  modifiedAt: string | null
  sizeBytes: number
}

const TAIL_FIRST = 64 * 1024
const TAIL_SECOND = 1024 * 1024
const HEAD_FIRST = 64 * 1024
const HEAD_SECOND = 1024 * 1024

/** The transcript's expected location under a projects root. Same encoding
 *  the export handlers and the capture use (`transcriptProjectDirName`). */
export function transcriptPath(projectsRoot: string, cwd: string, claudeSessionId: string): string {
  return path.join(projectsRoot, transcriptProjectDirName(cwd), `${claudeSessionId}.jsonl`)
}

/** Find the transcript when the cwd encoding does not match (a symlinked or
 *  renamed folder): the direct path first, then one level of project dirs. */
export function locateTranscript(
  projectsRoot: string,
  cwd: string,
  claudeSessionId: string,
  index?: TranscriptIndex
): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(claudeSessionId)) return null
  const direct = transcriptPath(projectsRoot, cwd, claudeSessionId)
  if (fs.existsSync(direct)) return direct
  // The fallback is a lookup in an index built ONCE per list (O(files)),
  // never a probe per project dir per miss: the missing share only grows as
  // Claude Code cleans transcripts up while the ledger never forgets one.
  const idx = index ?? indexTranscripts(projectsRoot)
  for (const [dir, stems] of idx) {
    if (stems.has(claudeSessionId)) return path.join(projectsRoot, dir, `${claudeSessionId}.jsonl`)
  }
  return null
}

/** Project dir name → the transcript stems it holds. */
export type TranscriptIndex = Map<string, Set<string>>

/** One listing per project dir under the root; empty when unreadable. */
export function indexTranscripts(projectsRoot: string): TranscriptIndex {
  const index: TranscriptIndex = new Map()
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
  } catch {
    return index
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    try {
      const stems = fs
        .readdirSync(path.join(projectsRoot, d.name))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
      index.set(d.name, new Set(stems))
    } catch {
      // An unreadable project dir holds nothing we can resume.
    }
  }
  return index
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function humanText(entry: any): string | null {
  if (entry?.type !== 'user' || entry.isSidechain || entry.isMeta || entry.toolUseResult)
    return null
  const content = entry.message?.content
  let text: string | null = null
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    if (parts.length === 0) return null
    text = parts.map((b: any) => b.text as string).join('\n')
  }
  if (!text) return null
  const head = text.trimStart()
  // Injected context, not something the human typed: the same exclusions the
  // recover-sessions skill applies when it reads a transcript by hand.
  if (
    head.startsWith('<') ||
    head.startsWith('Caveat:') ||
    head.slice(0, 80).includes('system-reminder')
  ) {
    return null
  }
  return text
}

function readTail(
  filePath: string,
  bytes: number
): { text: string; size: number; mtimeMs: number } {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const length = Math.min(bytes, stat.size)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, stat.size - length)
    let text = buf.toString('utf-8')
    // A read that starts mid-line: drop the partial first line, unless the
    // read covered the whole file.
    if (length < stat.size) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    return { text, size: stat.size, mtimeMs: stat.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

interface TailScan {
  title: string | null
  lastPrompt: string | null
  lastHumanAt: string | null
}

interface HeadScan {
  cwd: string | null
  firstAt: string | null
}

/** Scan head text for the conversation's own cwd and start time: the first
 *  record carrying each wins. Stops as soon as both are known. */
export function scanHead(text: string): HeadScan {
  const out: HeadScan = { cwd: null, firstAt: null }
  for (const line of text.split('\n')) {
    if (out.cwd !== null && out.firstAt !== null) break
    if (line === '') continue
    if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (out.cwd === null && typeof entry?.cwd === 'string' && entry.cwd.startsWith('/')) {
      out.cwd = entry.cwd
    }
    if (out.firstAt === null && typeof entry?.timestamp === 'string') {
      out.firstAt = entry.timestamp
    }
  }
  return out
}

function readHead(filePath: string, bytes: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const length = Math.min(bytes, stat.size)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, 0)
    let text = buf.toString('utf-8')
    // Cut the trailing partial line unless the read covered the whole file.
    if (length < stat.size) {
      const nl = text.lastIndexOf('\n')
      text = nl === -1 ? '' : text.slice(0, nl)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

/** Scan tail text for the three signals. Last occurrence wins for each. */
export function scanTail(text: string): TailScan {
  const out: TailScan = { title: null, lastPrompt: null, lastHumanAt: null }
  for (const line of text.split('\n')) {
    if (line === '') continue
    // Cheap substring gates before any JSON.parse: most lines are neither.
    const isTitle = line.includes('"type":"ai-title"')
    const isPrompt = line.includes('"type":"last-prompt"')
    const isUser = line.includes('"type":"user"')
    if (!isTitle && !isPrompt && !isUser) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      out.title = entry.aiTitle.trim()
    } else if (entry?.type === 'last-prompt' && typeof entry.lastPrompt === 'string') {
      out.lastPrompt = entry.lastPrompt
    } else if (entry?.type === 'user') {
      if (humanText(entry) !== null && typeof entry.timestamp === 'string') {
        out.lastHumanAt = entry.timestamp
      }
    }
  }
  return out
}

/** Peek one transcript. A missing file is `exists: false` with nulls, never
 *  a throw: the row is still listed, greyed, not resumable. */
export function peekTranscript(filePath: string | null): TranscriptPeek {
  if (!filePath) {
    return {
      exists: false,
      path: '',
      cwd: null,
      firstAt: null,
      title: null,
      lastPrompt: null,
      lastHumanAt: null,
      modifiedAt: null,
      sizeBytes: 0
    }
  }
  let tail: ReturnType<typeof readTail>
  try {
    tail = readTail(filePath, TAIL_FIRST)
  } catch {
    return {
      exists: false,
      path: filePath,
      cwd: null,
      firstAt: null,
      title: null,
      lastPrompt: null,
      lastHumanAt: null,
      modifiedAt: null,
      sizeBytes: 0
    }
  }
  let scan = scanTail(tail.text)
  if ((scan.lastHumanAt === null || scan.title === null) && tail.size > TAIL_FIRST) {
    try {
      const wider = scanTail(readTail(filePath, TAIL_SECOND).text)
      scan = {
        title: scan.title ?? wider.title,
        lastPrompt: scan.lastPrompt ?? wider.lastPrompt,
        lastHumanAt: scan.lastHumanAt ?? wider.lastHumanAt
      }
    } catch {
      // The first read answered; the second is best-effort.
    }
  }
  let head: HeadScan = { cwd: null, firstAt: null }
  try {
    head = scanHead(readHead(filePath, HEAD_FIRST))
    // A transcript can open with dozens of KB of cwd-less records (mode,
    // permission-mode, injected context); on the real store 7% carried no
    // cwd in the first 16 KB and a handful none in the first 64 KB. One
    // wider read recovers all but the files that truly carry none.
    if (head.cwd === null && tail.size > HEAD_FIRST) {
      const wider = scanHead(readHead(filePath, HEAD_SECOND))
      head = { cwd: wider.cwd, firstAt: head.firstAt ?? wider.firstAt }
    }
  } catch {
    // The tail answered; the head is best-effort.
  }
  return {
    exists: true,
    path: filePath,
    cwd: head.cwd,
    firstAt: head.firstAt,
    title: scan.title,
    lastPrompt: scan.lastPrompt,
    lastHumanAt: scan.lastHumanAt,
    modifiedAt: new Date(tail.mtimeMs).toISOString(),
    sizeBytes: tail.size
  }
}

/**
 * Peeks, cached per (path, size, mtime): a `stat` decides whether the file
 * moved since the last peek, and only then is the tail read again. Without
 * this every list re-read every tail (measured: 170 opens and 55 MB per
 * dialog open on a real install). The reader is injected for the tests.
 */
export class PeekCache {
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; peek: TranscriptPeek }
  >()

  constructor(
    private readonly read: (filePath: string | null) => TranscriptPeek = peekTranscript
  ) {}

  get(filePath: string | null): TranscriptPeek {
    if (!filePath) return this.read(null)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      this.entries.delete(filePath)
      return this.read(filePath)
    }
    const hit = this.entries.get(filePath)
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.peek
    const peek = this.read(filePath)
    this.entries.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, peek })
    return peek
  }

  size(): number {
    return this.entries.size
  }
}
