/**
 * Codex's storage: one rollout file per thread,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<started>-<thread id>.jsonl`, one
 * JSON row per line (`timestamp`, `type`, `payload`, and `ordinal` since the
 * paginated history of 0.167). The rows carry two tapes: `response_item` rows
 * are what the model sees again on resume (messages, function calls and
 * their outputs), `event_msg` rows are what the person saw (`item_completed`
 * items since 0.159, `user_message` and `agent_message` before). The SQLite
 * files beside `sessions/` are Codex's own indexes, rebuilt from a scan of the
 * rollouts (docs/formats/codex-0.167.md).
 *
 * `replayCodexHistory` is a copy of Clave's
 * `src/main/sessions/adapters/codex-history.ts`; `readCodex` finds the file
 * and wraps the replay with the session's head.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

const contentText = (value: unknown): string =>
  (Array.isArray(value) ? value : [])
    .map(object)
    .map((block) => {
      const type = text(block.type).toLowerCase()
      if (['text', 'input_text', 'output_text'].includes(type)) return text(block.text)
      if (['image', 'input_image', 'localimage', 'local_image'].includes(type)) return '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')

function userMessageOf(text: string): UserMessage {
  const form = formMessageMarker(text)
  return { type: 'user_message', text, ...(form && { form }) }
}

/** Rollouts hold both the model's messages and the person's items. Within a
 *  turn the items win: they omit injected instructions and expand a tool
 *  batch into the commands the person saw. Older turns have only
 *  `response_item` rows. */
export function replayCodexHistory(lines: Iterable<string>): HistoryItem[] {
  let turn = ''
  const modern = new Set<string>()
  const rows: { row: Record<string, unknown>; turn: string }[] = []
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = object(JSON.parse(line))
    } catch {
      continue // A crash can leave the last row incomplete.
    }
    const payload = object(row.payload)
    if (row.type === 'turn_context' || payload.type === 'task_started')
      turn = text(payload.turn_id) || turn
    const key = text(payload.turn_id) || turn
    rows.push({ row, turn: key })
    if (row.type === 'event_msg' && payload.type === 'item_completed') modern.add(key)
  }

  const items: HistoryItem[] = []
  const seen = new Set<string>()
  const open = new Set<string>()
  const close = (): void => {
    for (const id of open) items.push({ event: { type: 'tool_result', id, output: undefined } })
    open.clear()
  }
  for (const { row, turn } of rows) {
    const payload = object(row.payload)
    const time = Date.parse(text(row.timestamp))
    const push = (event: SessionEvent): void => {
      if (event.type === 'user_message') close()
      items.push({ event, ...(Number.isFinite(time) ? { at: time } : {}) })
    }
    if (row.type === 'event_msg') {
      if (payload.type === 'turn_aborted') {
        close()
        push({ type: 'turn_interrupted' })
      } else if (payload.type === 'token_count') {
        const info = object(payload.info)
        const last = object(info.last_token_usage)
        const used =
          typeof last.total_tokens === 'number'
            ? last.total_tokens -
              (typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0)
            : 0
        if (Number.isFinite(used) && used > 0)
          push({
            type: 'context_usage',
            used,
            window:
              typeof info.model_context_window === 'number' && info.model_context_window > 0
                ? info.model_context_window
                : null
          })
      } else if (payload.type === 'item_completed') {
        const item = object(payload.item)
        const id = text(item.id)
        const key = `${turn}:${id}`
        if (id && seen.has(key)) continue
        if (id) seen.add(key)
        if (item.type === 'UserMessage') {
          const message = contentText(item.content)
          if (message) push(userMessageOf(message))
        } else if (item.type === 'AgentMessage') {
          const message = contentText(item.content) || text(item.text)
          if (message) push({ type: 'assistant_text', delta: message, final: true })
        } else if (
          id &&
          ['CommandExecution', 'FileChange', 'McpToolCall'].includes(text(item.type))
        ) {
          const name =
            item.type === 'CommandExecution'
              ? 'commandExecution'
              : item.type === 'FileChange'
                ? 'fileChange'
                : `${text(item.server)}/${text(item.tool)}`
          push({ type: 'tool_call', id, name, input: item })
          push({
            type: 'tool_result',
            id,
            output:
              item.type === 'CommandExecution'
                ? (item.aggregated_output ?? item.error)
                : item.type === 'FileChange'
                  ? item.changes
                  : (item.result ?? item.error),
            error:
              typeof item.exit_code === 'number'
                ? item.exit_code !== 0
                : item.status === 'failed' || item.status === 'declined' || item.error != null
          })
        }
      }
      continue
    }
    if (row.type !== 'response_item' || modern.has(turn)) continue
    if (payload.type === 'message') {
      const message = contentText(payload.content)
      if (!message.trim()) continue
      if (payload.role === 'user') {
        // Older rollouts store the injected environment and AGENTS.md as
        // user messages too. Only the conversation belongs in the chat.
        if (
          /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions instructions>|Caveat:)/.test(
            message.trimStart()
          )
        )
          continue
        push(userMessageOf(message))
      } else if (payload.role === 'assistant') {
        push({ type: 'assistant_text', delta: message, final: true })
      }
    } else if (['function_call', 'custom_tool_call'].includes(text(payload.type))) {
      const id = text(payload.call_id)
      if (!id) continue
      let input = payload.arguments ?? payload.input
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input)
        } catch {
          /* Custom tools also take plain text. */
        }
      }
      open.add(id)
      push({ type: 'tool_call', id, name: text(payload.name) || 'Tool', input })
    } else if (['function_call_output', 'custom_tool_call_output'].includes(text(payload.type))) {
      const id = text(payload.call_id)
      if (!id || !open.delete(id)) continue
      push({ type: 'tool_result', id, output: payload.output })
    }
  }
  close()
  return items
}

/** The machine's Codex home: `$CODEX_HOME`, else `~/.codex`. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** The rollout file of a thread, found by its id under `<codexHome>/sessions`
 *  (the file name ends with the id), newest day first. */
export function findCodexRollout(threadId: string, codexHome = defaultCodexHome()): string | null {
  const root = join(codexHome, 'sessions')
  const suffix = `-${threadId}.jsonl`
  const walk = (dir: string): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort().reverse()
    } catch {
      return null
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let dirStat
      try {
        dirStat = statSync(path)
      } catch {
        continue
      }
      if (dirStat.isDirectory()) {
        const found = walk(path)
        if (found) return found
      } else if (entry.startsWith('rollout-') && entry.endsWith(suffix)) return path
    }
    return null
  }
  return walk(root)
}

/** The session a thread holds. `threadRef` is a thread id (looked up under the
 *  Codex home) or the path of a rollout file. Refuses a file without a
 *  `session_meta` row: not a rollout, or one this reader does not know. */
export function readCodex(threadRef: string, codexHome = defaultCodexHome()): Session {
  const path = existsSync(threadRef) ? threadRef : findCodexRollout(threadRef, codexHome)
  if (!path) throw new UnrecognisedTranscriptError('codex', threadRef, 'no rollout file by that id')
  const lines = readFileSync(path, 'utf8').split('\n')
  let meta: Record<string, unknown> | null = null
  let model: string | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = object(JSON.parse(line))
    } catch {
      continue
    }
    const payload = object(row.payload)
    if (row.type === 'session_meta' && !meta) meta = payload
    if (row.type === 'turn_context' && text(payload.model)) model = text(payload.model)
    const at = Date.parse(text(row.timestamp))
    if (Number.isFinite(at)) {
      startedAt = startedAt === null ? at : Math.min(startedAt, at)
      endedAt = endedAt === null ? at : Math.max(endedAt, at)
    }
  }
  if (!meta || !text(meta.id))
    throw new UnrecognisedTranscriptError('codex', path, 'no session_meta row with an id')
  const started = Date.parse(text(meta.timestamp))
  return {
    head: {
      provider: 'codex',
      id: text(meta.id),
      model,
      cwd: text(meta.cwd),
      cliVersion: text(meta.cli_version) || null,
      startedAt: Number.isFinite(started) ? started : startedAt,
      endedAt,
      source: path
    },
    items: replayCodexHistory(lines)
  }
}
