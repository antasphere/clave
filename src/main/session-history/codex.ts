import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'

/**
 * The Codex CLI's transcript store (PRDCT-1766): `~/.codex/sessions` holds
 * one `rollout-<timestamp>-<uuid>.jsonl` per thread under `YYYY/MM/DD` dirs.
 * The first record is `session_meta`, whose payload carries the thread's own
 * id, its cwd and its start time — and, for a subagent fan-out, a
 * `thread_source` of `subagent`: those are inner threads of a conversation
 * already listed, never a conversation of their own.
 *
 * History lists these for the record — counted, titled by their first human
 * message, searchable — but resume stays Claude-only: nothing here spawns.
 *
 * No Electron imports; the root is injected (or `CLAVE_CODEX_ROOT`) so the
 * tests and the E2E harness point it at fixtures instead of `~/.codex`.
 */

export interface CodexSessionInfo {
  /** The thread id from `session_meta` (the filename's uuid as fallback). */
  id: string
  path: string
  cwd: string | null
  firstAt: string | null
  /** The first real human message, one line — the row's title material. */
  firstUserText: string | null
  modifiedAt: string | null
  sizeBytes: number
}

const HEAD_BYTES = 256 * 1024
const WALK_DEPTH = 4

/** The store's root: the machine's own Codex home (the user's `CODEX_HOME`
 *  when their shell exports one, else `~/.codex`), or the fixture root the
 *  tests inject. Every account's home links its `sessions` here (ADR 0002),
 *  so one root holds every thread whatever account wrote it. */
export function codexRoot(env: Record<string, string | undefined> = process.env): string {
  const home = env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
  return process.env.CLAVE_CODEX_ROOT || path.join(home, 'sessions')
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every rollout file under the root, walked breadth-first to `WALK_DEPTH`
 *  (the store nests `YYYY/MM/DD`); empty when the root is absent. */
export function listCodexFiles(root: string): string[] {
  const out: string[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (depth < WALK_DEPTH) queue.push({ dir: path.join(dir, item.name), depth: depth + 1 })
      } else if (item.name.startsWith('rollout-') && item.name.endsWith('.jsonl')) {
        out.push(path.join(dir, item.name))
      }
    }
  }
  return out
}

/** Whether the store holds the rollout of a thread — the file Codex names
 *  `rollout-<time>-<threadId>.jsonl` once the thread's first turn is written.
 *  A thread that never got a message has none, and `thread/resume` of it
 *  fails ("no rollout found"), so a restore resumes only what this finds. */
export function hasCodexRollout(threadId: string, root: string = codexRoot()): boolean {
  const suffix = `-${threadId}.jsonl`
  return listCodexFiles(root).some((file) => file.endsWith(suffix))
}

function isInjected(text: string): boolean {
  const head = text.trimStart()
  return (
    head.startsWith('<') ||
    head.startsWith('Caveat:') ||
    head.slice(0, 80).includes('system-reminder')
  )
}

/** The human texts of one codex head record, injected context excluded. */
function userTexts(entry: any): string[] {
  if (entry?.type !== 'response_item') return []
  const p = entry.payload
  if (!p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return []
  return p.content
    .filter((b: any) => b?.type === 'input_text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .filter((t: string) => t.trim() !== '' && !isInjected(t))
}

/** Parse the head text of one rollout file. Null when the meta says the
 *  thread is a subagent's (an inner thread, not a conversation), or when no
 *  meta record parses at all. */
export function scanCodexHead(
  text: string,
  fallbackId: string
): Omit<CodexSessionInfo, 'path' | 'modifiedAt' | 'sizeBytes'> | null {
  let meta: { id: string; cwd: string | null; firstAt: string | null } | null = null
  let firstUserText: string | null = null
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (meta !== null && firstUserText !== null) break
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (meta === null && entry?.type === 'session_meta') {
      const p = entry.payload
      if (p?.thread_source === 'subagent' || p?.source?.subagent) return null
      meta = {
        id: typeof p?.id === 'string' && p.id !== '' ? p.id : fallbackId,
        cwd: typeof p?.cwd === 'string' && p.cwd.startsWith('/') ? p.cwd : null,
        firstAt:
          typeof p?.timestamp === 'string'
            ? p.timestamp
            : typeof entry.timestamp === 'string'
              ? entry.timestamp
              : null
      }
    }
    if (firstUserText === null) {
      const texts = userTexts(entry)
      if (texts.length > 0) {
        // The TUI prefixes pasted lines with a gutter bar; strip it so the
        // title reads as the message.
        firstUserText = texts[0].replace(/^\s*▎\s?/gm, '').trim() || null
      }
    }
  }
  if (meta === null) return null
  return { ...meta, firstUserText }
}

function readHead(filePath: string): { text: string; size: number; mtimeMs: number } {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const length = Math.min(HEAD_BYTES, stat.size)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, 0)
    let text = buf.toString('utf-8')
    if (length < stat.size) {
      const nl = text.lastIndexOf('\n')
      text = nl === -1 ? '' : text.slice(0, nl)
    }
    return { text, size: stat.size, mtimeMs: stat.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

/** The uuid at the end of `rollout-<timestamp>-<uuid>`, as the id fallback. */
function stemId(filePath: string): string {
  const stem = path.basename(filePath, '.jsonl')
  const m = stem.match(/([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})$/)
  return m ? m[1] : stem
}

/**
 * Codex heads, cached per (path, size, mtime) like the claude `PeekCache`:
 * a stat decides whether the file moved, and only then is the head re-read.
 * A cached null is a subagent thread (or an unparseable file), skipped for
 * good until the file changes.
 */
export class CodexCache {
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; info: CodexSessionInfo | null }
  >()

  get(filePath: string): CodexSessionInfo | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      this.entries.delete(filePath)
      return null
    }
    const hit = this.entries.get(filePath)
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.info
    let info: CodexSessionInfo | null = null
    try {
      const head = readHead(filePath)
      const scan = scanCodexHead(head.text, stemId(filePath))
      if (scan) {
        info = {
          ...scan,
          path: filePath,
          modifiedAt: new Date(head.mtimeMs).toISOString(),
          sizeBytes: head.size
        }
      }
    } catch {
      // Unreadable mid-listing: skipped this round, retried when it moves.
    }
    this.entries.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, info })
    return info
  }
}

/** Every codex conversation under the root, subagent threads excluded. */
export function listCodexSessions(root: string, cache: CodexCache): CodexSessionInfo[] {
  const out: CodexSessionInfo[] = []
  for (const file of listCodexFiles(root)) {
    const info = cache.get(file)
    if (info) out.push(info)
  }
  return out
}

/**
 * The thread a Codex TERMINAL session is running: Codex's TUI never tells
 * its host which rollout it writes, so the thread is found by what the
 * store says — the earliest conversation started in this cwd at or after
 * the session started (a small allowance for clock drift), which is the one
 * this session opened. Null when nothing in the store fits: the restart
 * then starts fresh and says so. A chat session knows its thread from the
 * app-server and never comes here.
 */
export function findCodexThreadForSession(
  cwd: string,
  startedAt: number,
  root: string = codexRoot(),
  cache: CodexCache = new CodexCache()
): string | null {
  const since = startedAt - 5_000
  let best: { id: string; at: number } | null = null
  for (const info of listCodexSessions(root, cache)) {
    if (info.cwd !== cwd || !info.firstAt) continue
    const at = Date.parse(info.firstAt)
    if (!Number.isFinite(at) || at < since) continue
    if (!best || at < best.at) best = { id: info.id, at }
  }
  return best?.id ?? null
}
