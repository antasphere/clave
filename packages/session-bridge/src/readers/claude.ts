/**
 * Claude Code's storage: `~/.claude/projects/<cwd, dashed>/<id>.jsonl`, one
 * JSON row per line. The rows that are the conversation carry `type: "user"`
 * or `type: "assistant"` with an Anthropic message under `message` (`role`,
 * `content` as a string or as blocks of `text`, `tool_use`, `tool_result`,
 * `thinking`); the other rows (`attachment`, `api-request*`, `last-prompt`,
 * `queue-operation`, …) are the CLI's own bookkeeping. A subagent's rows are
 * `isSidechain: true`, an injected skill or context row `isMeta: true`.
 *
 * `replayClaudeTranscript` is a copy of Clave's `ClaudeStreamTranslator.replay`
 * (`src/main/sessions/adapters/claude-adapter.ts`) without its dependencies;
 * `readClaude` wraps it with the session's head. The shapes were checked against
 * a Claude Code 2.1.319 transcript on 9 November 2026 (docs/formats/claude-code.md).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  UnrecognisedTranscriptError,
  object,
  text,
  type HistoryItem,
  type Session,
  type SessionEvent,
  type UserMessage
} from '../ir.ts'
import { formMessageMarker } from '../form-message.ts'

function userMessageOf(text: string): UserMessage {
  const form = formMessageMarker(text)
  return { type: 'user_message', text, ...(form && { form }) }
}
function isInterruptNotice(value: unknown): boolean {
  return typeof value === 'string' && /^\[Request interrupted by user/.test(value.trim())
}
/** What the person actually typed: a slash command's name and arguments out of
 *  the CLI's markup, nothing of an injected `<…>` block or a `Caveat:` notice. */
function spokenText(value: string): string {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(value)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(value)?.[1] ?? ''
    return `${command[1].trim()} ${args.trim()}`.trim()
  }
  if (value.trimStart().startsWith('<') || value.startsWith('Caveat:')) return ''
  return value
}
/** The tokens a call's context held: what it read, cached or not, and wrote. */
function contextTokens(usage: unknown): number {
  const u = object(usage)
  const n = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  return (
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens')
  )
}
/** The window a Claude model id names: the `[1m]` suffix is the one fact the
 *  id itself carries; anything else is left unknown rather than guessed. */
export function claudeContextWindow(id: string | null | undefined): number | null {
  if (!id) return null
  return /\[1m\]$/i.test(id) ? 1_000_000 : null
}
const blocks = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? content.map(object).filter((b) => typeof b.type === 'string') : []

/** The conversation a transcript holds, as the events a live session would
 *  have produced: subagent rows and injected context stay out, a call the
 *  transcript never answered is closed at the next message, and the context
 *  as it stood rides along so a resumed meter is not blank. */
export function replayClaudeTranscript(lines: Iterable<string>): HistoryItem[] {
  const items: HistoryItem[] = []
  const open = new Set<string>()
  const tools = new Set<string>()
  const close = (): void => {
    for (const id of open) items.push({ event: { type: 'tool_result', id, output: undefined } })
    open.clear()
  }
  let used = 0
  for (const line of lines) {
    let frame: Record<string, unknown>
    try {
      frame = object(JSON.parse(line))
    } catch {
      continue // A crash can leave the last row incomplete.
    }
    if (frame.isSidechain === true || frame.isMeta === true) continue
    const message = object(frame.message)
    const content = message.content
    const time = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : NaN
    const push = (event: SessionEvent): void => {
      // The person spoke again: whatever the turn before left unanswered is over.
      if (event.type === 'user_message') close()
      items.push(Number.isFinite(time) ? { event, at: time } : { event })
    }
    if (frame.type === 'user') {
      if (typeof content === 'string') {
        if (isInterruptNotice(content)) push({ type: 'turn_interrupted' })
        else if (spokenText(content)) push(userMessageOf(spokenText(content)))
        continue
      }
      for (const item of blocks(content)) {
        if (item.type === 'text' && isInterruptNotice(item.text)) {
          push({ type: 'turn_interrupted' })
        } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          open.delete(item.tool_use_id)
          push({
            type: 'tool_result',
            id: item.tool_use_id,
            output: item.content,
            ...(item.is_error === true ? { error: true } : {})
          })
        } else if (item.type === 'text' && typeof item.text === 'string') {
          const spoken = spokenText(item.text)
          if (spoken) push(userMessageOf(spoken))
        }
      }
    } else if (frame.type === 'assistant') {
      for (const item of blocks(content)) {
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim())
          push({ type: 'assistant_text', delta: item.text, final: true })
        else if (item.type === 'tool_use' && typeof item.id === 'string' && !tools.has(item.id)) {
          tools.add(item.id)
          open.add(item.id)
          push({
            type: 'tool_call',
            id: item.id,
            name: typeof item.name === 'string' ? item.name : 'Tool',
            input: item.input
          })
        }
      }
      const tokens = contextTokens(message.usage)
      if (tokens > 0 && tokens !== used) {
        used = tokens
        push({
          type: 'context_usage',
          used,
          window: claudeContextWindow(typeof message.model === 'string' ? message.model : null)
        })
      }
    }
  }
  close()
  return items
}

/** Where Claude Code keeps a conversation: `<root>/<cwd, dashed>/<id>.jsonl`,
 *  else wherever in the root a file of that id is (the cwd may have moved).
 *  The root is `~/.claude/projects`, or `<configDir>/projects`. */
export function findClaudeTranscript(id: string, cwd: string, configDir?: string): string | null {
  const root = join(configDir ?? join(homedir(), '.claude'), 'projects')
  const direct = join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${id}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // No transcript store at all.
  }
  return null
}

/** The session a transcript file holds. Refuses a file with no conversation
 *  row in it: an empty file, another provider's storage, or a shape this
 *  reader does not know, rather than returning an empty tape. */
export function readClaude(transcriptPath: string): Session {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n')
  let id: string | null = null
  let cwd: string | null = null
  let cliVersion: string | null = null
  let model: string | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null
  let conversationRows = 0
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = object(JSON.parse(line))
    } catch {
      continue
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue
    if (row.isSidechain === true) continue
    conversationRows++
    id ??= text(row.sessionId) || null
    cwd ??= text(row.cwd) || null
    cliVersion ??= text(row.version) || null
    const rowModel = text(object(row.message).model)
    if (rowModel && row.type === 'assistant') model = rowModel
    const at = Date.parse(text(row.timestamp))
    if (Number.isFinite(at)) {
      startedAt = startedAt === null ? at : Math.min(startedAt, at)
      endedAt = endedAt === null ? at : Math.max(endedAt, at)
    }
  }
  if (!conversationRows || !id)
    throw new UnrecognisedTranscriptError(
      'claude',
      transcriptPath,
      conversationRows ? 'no sessionId on any row' : 'no user or assistant row'
    )
  return {
    head: {
      provider: 'claude',
      id,
      model,
      cwd: cwd ?? '',
      cliVersion,
      startedAt,
      endedAt,
      source: transcriptPath
    },
    items: replayClaudeTranscript(lines)
  }
}
