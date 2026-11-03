import { addTokens, emptyTokens, localDay, type DayBucket, type Tally, type Tokens } from './ledger'

/**
 * The rules of a Claude Code transcript (`~/.claude/projects/<slug>/<id>.jsonl`), pure:
 * `parseLine` turns one line into the event it means, `foldEvents` adds events to a tally.
 *
 * One streamed assistant message is written once per content block, each row repeating the
 * same `usage`, so usage is counted once per message id; tool calls are counted by their
 * distinct `tool_use` ids; a `<synthetic>` model marks an API error row, which counts
 * nothing. A user row is a prompt only when a person typed it.
 */

export type TranscriptEvent =
  | {
      kind: 'assistant'
      timestamp: string | null
      /** `message.id ?? uuid`; null when the row has neither. */
      messageId: string | null
      model: string
      synthetic: boolean
      toolUseIds: string[]
      tokens: Tokens
    }
  | { kind: 'prompt'; timestamp: string | null }
  | { kind: 'skipped' }

/** How many message ids a file's cursor remembers across reads (newest last). */
export const SEEN_LIMIT = 64

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

const NOT_A_PERSON = [
  '<',
  '[',
  'Caveat:',
  'Base directory for this skill',
  'Tool loaded',
  'This session is being continued'
]

/** The text a person typed in a user row, or null when the row is not a typed prompt. */
function promptText(row: Obj): string | null {
  if (row['isSidechain'] === true) return null
  const message = row['message']
  if (!isObj(message)) return null
  const content = message['content']
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    if (content.some((b) => isObj(b) && b['type'] === 'tool_result')) return null
    text = content
      .filter((b): b is Obj => isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string')
      .map((b) => b['text'] as string)
      .join('\n')
  } else {
    return null
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  if (NOT_A_PERSON.some((prefix) => trimmed.startsWith(prefix))) return null
  if (trimmed.slice(0, 200).includes('stopped by a safety classifier')) return null
  return trimmed
}

function usageTokens(usage: unknown): Tokens {
  const t = emptyTokens()
  if (!isObj(usage)) return t
  t.input = num(usage['input_tokens'])
  t.cacheRead = num(usage['cache_read_input_tokens'])
  t.output = num(usage['output_tokens'])
  const split = usage['cache_creation']
  if (
    isObj(split) &&
    ('ephemeral_5m_input_tokens' in split || 'ephemeral_1h_input_tokens' in split)
  ) {
    t.cacheWrite5m = num(split['ephemeral_5m_input_tokens'])
    t.cacheWrite1h = num(split['ephemeral_1h_input_tokens'])
  } else {
    t.cacheWriteUnsplit = num(usage['cache_creation_input_tokens'])
  }
  return t
}

/** One transcript line → its event; null for a blank line or a row that counts nothing. */
export function parseLine(line: string): TranscriptEvent | null {
  if (!line.trim()) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return { kind: 'skipped' }
  }
  if (!isObj(row)) return { kind: 'skipped' }
  const timestamp = str(row['timestamp'])
  if (row['type'] === 'assistant') {
    const message = row['message']
    if (!isObj(message)) return null
    const model = str(message['model']) ?? 'unknown'
    const content = Array.isArray(message['content']) ? message['content'] : []
    const toolUseIds = content
      .filter((b): b is Obj => isObj(b) && b['type'] === 'tool_use' && str(b['id']) !== null)
      .map((b) => b['id'] as string)
    return {
      kind: 'assistant',
      timestamp,
      messageId: str(message['id']) ?? str(row['uuid']),
      model,
      synthetic: model === '<synthetic>',
      toolUseIds,
      tokens: usageTokens(message['usage'])
    }
  }
  if (row['type'] === 'user') {
    return promptText(row) === null ? null : { kind: 'prompt', timestamp }
  }
  return null
}

/**
 * Fold-time state that is not persisted: the distinct tool-use ids and timestamps a tally
 * has seen in this process. Rebuilt lazily; across a restart the reader never re-reads a
 * row, so the persisted counts carry on from where they were.
 */
interface Working {
  toolCallIds: Set<string>
  stamps: Set<string>
}
const working = new WeakMap<Tally, Working>()

function workingOf(tally: Tally): Working {
  let w = working.get(tally)
  if (!w) {
    w = { toolCallIds: new Set(), stamps: new Set(tally.stamps) }
    working.set(tally, w)
  }
  return w
}

/** The distinct tool-use ids folded into this tally in this process. */
export function toolCallIdsOf(tally: Tally): ReadonlySet<string> {
  return workingOf(tally).toolCallIds
}

/** Remembers a message id in a file's window of the last `SEEN_LIMIT`, newest last. */
export function rememberSeen(seen: string[], id: string): void {
  const at = seen.indexOf(id)
  if (at >= 0) seen.splice(at, 1)
  seen.push(id)
  if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT)
}

function earlier(a: string | null, b: string): string {
  return a === null || Date.parse(b) < Date.parse(a) ? b : a
}

function later(a: string | null, b: string): string {
  return a === null || Date.parse(b) > Date.parse(a) ? b : a
}

function emptyDay(): DayBucket {
  return { ...emptyTokens(), messages: 0, toolCalls: 0, prompts: 0, byModel: {} }
}

function dayOf(tally: Tally, timestamp: string | null): DayBucket | null {
  const key = timestamp ? localDay(timestamp) : null
  if (!key) return null
  return (tally.days[key] ??= emptyDay())
}

/**
 * Adds events to a tally (mutating and returning it). `seen` is the file's window of the
 * message ids already counted; it is updated in place, so usage is taken once per message
 * id across reads.
 */
export function foldEvents(
  events: Iterable<TranscriptEvent | null>,
  tally: Tally,
  seen: string[] = []
): Tally {
  const w = workingOf(tally)
  for (const event of events) {
    if (!event) continue
    if (event.kind === 'skipped') {
      tally.skipped++
      continue
    }
    if (event.kind === 'prompt') {
      tally.prompts++
      if (event.timestamp) {
        tally.promptFirstAt = earlier(tally.promptFirstAt, event.timestamp)
        tally.promptLastAt = later(tally.promptLastAt, event.timestamp)
      }
      const day = dayOf(tally, event.timestamp)
      if (day) day.prompts++
      continue
    }
    if (event.synthetic) continue
    const day = dayOf(tally, event.timestamp)
    if (event.timestamp) {
      tally.firstAt = earlier(tally.firstAt, event.timestamp)
      tally.lastAt = later(tally.lastAt, event.timestamp)
      if (!w.stamps.has(event.timestamp)) {
        w.stamps.add(event.timestamp)
        tally.stamps.push(event.timestamp)
      }
    }
    for (const id of event.toolUseIds) {
      if (w.toolCallIds.has(id)) continue
      w.toolCallIds.add(id)
      tally.toolCalls++
      if (day) day.toolCalls++
    }
    if (event.messageId !== null) {
      if (seen.includes(event.messageId)) continue
      rememberSeen(seen, event.messageId)
    }
    tally.messages++
    addTokens(tally.tokens, event.tokens)
    const model = (tally.byModel[event.model] ??= { ...emptyTokens(), messages: 0 })
    addTokens(model, event.tokens)
    model.messages++
    if (day) {
      day.messages++
      addTokens(day, event.tokens)
      addTokens((day.byModel[event.model] ??= emptyTokens()), event.tokens)
    }
  }
  return tally
}
