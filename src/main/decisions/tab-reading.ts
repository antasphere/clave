import * as fs from 'node:fs'
import { conversationRoot, locateTranscript } from '../session-history/transcript-peek'
import { findCodexRollout } from '../session-history/codex'
import { findPiSession } from '../session-history/pi'
import { codexScopedTexts, piScopedTexts, scopedTexts } from '../session-history/search'

/**
 * What a tab said and touched, read from its transcript for the `tab-project`
 * decision (PRDCT-5179): the person's first message, their three latest, and
 * how many times the agent's tool calls named each absolute path of the
 * workspace. The transcript is found as the history finds it, per harness,
 * and read as a stream, one line at a time: a transcript reaches tens of
 * megabytes, nearly all of them the results of tool calls, which are dropped
 * as bytes (`neededLines`). Nothing here is sent anywhere; `tab-project.ts`
 * scrubs and clips what it sends.
 */

export type TabHarness = 'claude' | 'codex' | 'pi'

export interface TabSource {
  harness: TabHarness
  cwd: string
  conversationId: string
  /** The tab's own Claude account directory, when it ran with one. */
  configDir?: string
  workspaceRoot: string
}

export interface TabReading {
  firstMessage: string
  latestMessages: string[]
  /** Absolute paths under the workspace's root, by how often the agent's
   *  tool calls named them. */
  touched: Record<string, number>
}

/** How many of the latest messages are kept beside the first. */
export const LATEST_KEPT = 3

/* eslint-disable @typescript-eslint/no-explicit-any */

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const COMMAND_NAME = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** A person's text made readable: the reminders the harness injects
 *  removed, a slash command rendered as typed (`/x <args>`). Pure. */
export function cleanHumanText(text: string): string {
  const name = COMMAND_NAME.exec(text)
  if (name && name[1]) {
    const command = name[1].startsWith('/') ? name[1] : `/${name[1]}`
    const args = (COMMAND_ARGS.exec(text)?.[1] ?? '').trim()
    return args ? `${command} ${args}` : command
  }
  return text.replace(REMINDER, '').trim()
}

/** Whether a cleaned text is something a person said: not empty, not what
 *  the harness writes in their name. Pure. */
export function isSaid(text: string): boolean {
  if (!text) return false
  return !(
    text.startsWith('<') ||
    text.startsWith('Caveat: The messages below') ||
    text.startsWith('[Request interrupted')
  )
}

/** The entry with its text blocks cleaned, so the history's own scope
 *  (`scopedTexts` and its two siblings) decides what is the person's: its
 *  filter drops a text that OPENS with a tag, which a slash command and a
 *  message led by a reminder both do before they are cleaned. */
function cleanedEntry(entry: any, harness: TabHarness): any {
  if (!entry || typeof entry !== 'object') return entry
  const blockType = harness === 'codex' ? 'input_text' : 'text'
  const cleanContent = (content: unknown): unknown => {
    if (typeof content === 'string') return cleanHumanText(content)
    if (!Array.isArray(content)) return content
    return content.map((block: any) =>
      block?.type === blockType && typeof block.text === 'string'
        ? { ...block, text: cleanHumanText(block.text) }
        : block
    )
  }
  if (harness === 'codex') {
    if (!entry.payload || typeof entry.payload !== 'object') return entry
    return { ...entry, payload: { ...entry.payload, content: cleanContent(entry.payload.content) } }
  }
  if (!entry.message || typeof entry.message !== 'object') return entry
  return { ...entry, message: { ...entry.message, content: cleanContent(entry.message.content) } }
}

/** What a person said in one entry, cleaned. Pure. */
export function saidIn(entry: any, harness: TabHarness): string[] {
  const cleaned = cleanedEntry(entry, harness)
  const texts =
    harness === 'codex'
      ? codexScopedTexts(cleaned, 'human')
      : harness === 'pi'
        ? piScopedTexts(cleaned, 'human')
        : scopedTexts(cleaned, 'human')
  return texts.map((text) => text.trim()).filter(isSaid)
}

/** The inputs of the agent's own tool calls in one entry: never a tool's
 *  RESULT (the history's `tools` scope also answers the results a Claude
 *  user entry carries, which hold every path a listing printed). Pure. */
export function toolInputsIn(entry: any, harness: TabHarness): unknown[] {
  if (!entry || typeof entry !== 'object') return []
  if (harness === 'claude') {
    if (entry.type !== 'assistant' || entry.isSidechain) return []
    const content = entry.message?.content
    if (!Array.isArray(content)) return []
    return content.filter((b: any) => b?.type === 'tool_use').map((b: any) => b.input)
  }
  if (harness === 'codex') {
    if (entry.type !== 'response_item') return []
    const p = entry.payload
    if (!p || typeof p !== 'object') return []
    if (p.type === 'function_call') {
      if (typeof p.arguments !== 'string') return [p.arguments]
      try {
        return [JSON.parse(p.arguments)]
      } catch {
        return [p.arguments]
      }
    }
    if (p.type === 'custom_tool_call') return [p.input]
    return []
  }
  if (entry.type !== 'message' || entry.message?.role !== 'assistant') return []
  const content = entry.message.content
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b?.type === 'toolCall').map((b: any) => b.arguments)
}

/** Every string of a value, however deep (64 levels at most). */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1)
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) stringsOf(item, out, depth + 1)
  return out
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The absolute paths strictly under `root` that a text names, as written,
 *  trailing punctuation and separators dropped. Pure. */
export function pathsUnder(text: string, root: string): string[] {
  const base = root.replace(/\/+$/, '')
  if (!base.startsWith('/')) return []
  const pattern = new RegExp(
    `(?<![\\w:/.~-])${escapeRegExp(base)}/[^\\s"'<>()\\[\\]{}\`|;&*,]+`,
    'g'
  )
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const cleaned = match[0].replace(/[.,:;!?]+$/, '').replace(/\/+$/, '')
    if (cleaned.length > base.length + 1) found.push(cleaned)
  }
  return found
}

/** Where a tab's transcript is, per harness; null when there is none. */
export function locateTab(source: TabSource): string | null {
  if (source.harness === 'claude')
    return locateTranscript(conversationRoot(source.configDir), source.cwd, source.conversationId)
  if (source.harness === 'codex') return findCodexRollout(source.conversationId) ?? null
  return findPiSession(source.conversationId, source.cwd)
}

/** A line past this many bytes that carries a tool's result is skipped unread. */
export const RESULT_LINE_MIN = 4096
const RESULT_MARKER = '"tool_use_id"'

/** Whether a line is one of the results a Claude tool call got back: the
 *  largest lines of a transcript (a file's content, a listing), and never
 *  read here, since only what a person said and what the agent's own calls
 *  named count. Only a LONG line is skipped, so a message a person typed
 *  about tool calls is still read. Pure. */
export function isToolResultLine(line: string, harness: TabHarness): boolean {
  return harness === 'claude' && line.length > RESULT_LINE_MIN && line.includes(RESULT_MARKER)
}

/**
 * The lines of a transcript worth decoding, read as BYTES: a long line whose
 * first `RESULT_LINE_MIN` bytes carry the mark of a tool's result is dropped
 * without ever becoming a string. Decoding is the whole cost of reading a
 * long tab: measured on 25 November 2026 on a 100 MB transcript, 97 MB of it
 * tool results in 258 lines, a line reader took 828 ms where finding the
 * line ends in the bytes took 32 ms, and the 358 lines a reading needs
 * parsed in 28 ms. The mark sits in the first 4 KB of such a line (3,186 of
 * 3,191 in the twelve largest transcripts looked at); the rare line where it
 * does not is decoded and dropped by `isToolResultLine`.
 */
export async function* neededLines(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  harness: TabHarness
): AsyncGenerator<string> {
  let parts: Buffer[] = []
  let length = 0
  /** The line being read is a tool's result: its bytes are dropped. */
  let skipping = false
  /** The line's head was looked at once already. */
  let looked = false
  for await (const chunk of chunks) {
    let start = 0
    for (;;) {
      const end = chunk.indexOf(10, start)
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end)
      if (!skipping && piece.length > 0) {
        parts.push(piece)
        length += piece.length
        if (harness === 'claude' && !looked && length > RESULT_LINE_MIN) {
          looked = true
          const head = parts.length === 1 ? parts[0] : Buffer.concat(parts, length)
          if (head.subarray(0, RESULT_LINE_MIN).includes(RESULT_MARKER)) {
            skipping = true
            parts = []
          }
        }
      }
      if (end === -1) break
      if (!skipping && length > 0) yield Buffer.concat(parts, length).toString('utf-8')
      parts = []
      length = 0
      skipping = false
      looked = false
      start = end + 1
    }
  }
  if (!skipping && length > 0) yield Buffer.concat(parts, length).toString('utf-8')
}

/** Read one transcript's lines into a reading. Pure over the lines, so the
 *  tests feed arrays and `readTab` feeds a stream. Null when nothing was said. */
export async function readTabLines(
  lines: AsyncIterable<string> | Iterable<string>,
  harness: TabHarness,
  workspaceRoot: string
): Promise<TabReading | null> {
  let firstMessage: string | null = null
  const latest: string[] = []
  const touched: Record<string, number> = {}
  for await (const line of lines) {
    if (!line.trim()) continue
    if (isToolResultLine(line, harness)) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    for (const said of saidIn(entry, harness)) {
      if (firstMessage === null) firstMessage = said
      else {
        latest.push(said)
        if (latest.length > LATEST_KEPT) latest.shift()
      }
    }
    for (const input of toolInputsIn(entry, harness))
      for (const text of stringsOf(input))
        for (const found of pathsUnder(text, workspaceRoot))
          touched[found] = (touched[found] ?? 0) + 1
  }
  if (firstMessage === null) return null
  return { firstMessage, latestMessages: latest, touched }
}

/** A tab's reading from its transcript; null when no transcript is found
 *  or nothing was said in it. Never throws. */
export async function readTab(source: TabSource): Promise<TabReading | null> {
  let file: string | null
  try {
    file = locateTab(source)
  } catch {
    return null
  }
  if (!file) return null
  // Bytes, never a decoded stream: see `neededLines`.
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 })
  try {
    return await readTabLines(
      neededLines(stream as AsyncIterable<Buffer>, source.harness),
      source.harness,
      source.workspaceRoot
    )
  } catch {
    return null
  } finally {
    stream.destroy()
  }
}
