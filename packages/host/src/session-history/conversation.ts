import * as fs from 'fs'
import { piScopedTexts, scopedTexts } from './search'

/**
 * The conversation behind a LIVE tab, read off its transcript for the message
 * trail: one entry per human turn — what the user said, and the first line of
 * the agent's final answer for that turn. "Final" is deliberate: the last
 * text the agent wrote before the next human message is where Claude Code
 * puts the outcome ("done", "found it", "blocked on…"), while the first is
 * usually "let me look at…" — worthless as an overview.
 *
 * The filters are `scopedTexts`' (PRDCT-1738): injected context, tool
 * results, sidechains and meta entries are not conversation. Incremental by
 * construction — the trail refreshes on every agent-state word, and a
 * multi-megabyte transcript must not be re-parsed each time — so the cache
 * keeps, per file, the byte offset of the last complete line it consumed and
 * folds only what was appended since. No Electron imports: the tests feed
 * temp files.
 */

export interface ConversationTurn {
  /** Timestamp of the human message, when the entry carries one. */
  ts: string | null
  /** What the human said, capped. */
  userText: string
  /** First line of the turn's final agent text, capped; null while the agent
   *  has not answered with text yet. */
  replyHead: string | null
}

// Big enough that the trail's full-message view shows a real prompt whole;
// the cap only guards against a pathological megabyte paste.
const USER_TEXT_MAX = 4000
const REPLY_HEAD_MAX = 300
const MAX_CACHED_FILES = 64

function headLine(text: string, cap: number): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const line = first.trim()
  return line.length > cap ? line.slice(0, cap) : line
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Fold one transcript line into the turns. Exported for the tests; the
 *  cache is just this over the appended lines. */
export function foldConversationLine(turns: ConversationTurn[], line: string): void {
  // Cheap gate before any JSON.parse: only user and assistant entries can
  // contribute, and most lines are tool traffic.
  if (
    !line.includes('"type":"user"') &&
    !line.includes('"type":"assistant"') &&
    !line.includes('"type":"message"')
  )
    return
  let entry: any
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  const human = [...scopedTexts(entry, 'human'), ...piScopedTexts(entry, 'human')]
  if (human.length > 0) {
    const text = human.join('\n')
    turns.push({
      ts: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      userText: text.length > USER_TEXT_MAX ? text.slice(0, USER_TEXT_MAX) : text,
      replyHead: null
    })
    return
  }
  if (turns.length === 0) return
  const agent = [...scopedTexts(entry, 'agent'), ...piScopedTexts(entry, 'agent')].filter(
    (t) => t.trim() !== ''
  )
  if (agent.length > 0) {
    // Later text for the same turn overwrites: the final word wins.
    turns[turns.length - 1].replyHead = headLine(agent.join('\n'), REPLY_HEAD_MAX)
  }
}

/** Parse a whole transcript's lines. The cache's fold, testable in one call. */
export function parseConversation(lines: Iterable<string>): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    foldConversationLine(turns, line)
  }
  return turns
}

interface FileState {
  /** Byte offset of the end of the last complete line consumed. */
  offset: number
  turns: ConversationTurn[]
}

export class ConversationCache {
  private readonly states = new Map<string, FileState>()

  /** The turns of one transcript, reading only what was appended since the
   *  last call. A missing file is `exists: false`, never a throw; a file
   *  that shrank (a rotated or rewritten transcript) is re-read from zero. */
  read(filePath: string | null): { exists: boolean; turns: ConversationTurn[] } {
    if (!filePath) return { exists: false, turns: [] }
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      this.states.delete(filePath)
      return { exists: false, turns: [] }
    }
    let state = this.states.get(filePath)
    if (state && stat.size < state.offset) state = undefined
    if (!state) state = { offset: 0, turns: [] }
    if (stat.size > state.offset) {
      try {
        const appended = this.readRange(filePath, state.offset, stat.size)
        // The last piece may be a line still being written: consume only up
        // to the final newline, and pick the offset up there next time.
        // Newlines are single bytes, so the boundary never splits a UTF-8
        // character.
        const complete = appended.lastIndexOf('\n')
        if (complete !== -1) {
          const text = appended.toString('utf-8', 0, complete + 1)
          for (const line of text.split('\n')) {
            if (line.trim() === '') continue
            foldConversationLine(state.turns, line)
          }
          state.offset += complete + 1
        }
      } catch {
        this.states.delete(filePath)
        return { exists: false, turns: [] }
      }
    }
    // Refresh insertion order so the eviction below drops the coldest file.
    this.states.delete(filePath)
    this.states.set(filePath, state)
    if (this.states.size > MAX_CACHED_FILES) {
      const oldest = this.states.keys().next().value
      if (oldest !== undefined) this.states.delete(oldest)
    }
    return { exists: true, turns: state.turns }
  }

  private readRange(filePath: string, from: number, to: number): Buffer {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(to - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      return buf
    } finally {
      fs.closeSync(fd)
    }
  }
}
