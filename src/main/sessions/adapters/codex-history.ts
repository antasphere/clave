import type { HistoryItem, SessionEvent } from '../../../shared/session-model'
import { object } from './codex-app-server'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
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

/** Rollouts contain both model messages and UI items. Prefer the UI items
 * within each turn: they omit injected instructions and expand tool batches
 * into the commands the user saw. Older turns have only response_item rows. */
export function replayCodexHistory(lines: Iterable<string>): HistoryItem[] {
  let turn = ''
  const modern = new Set<string>()
  const rows: { row: Record<string, unknown>; turn: string }[] = []
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = object(JSON.parse(line))
    } catch {
      continue // A crash can leave the last JSONL record incomplete.
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
          if (message) push({ type: 'user_message', text: message })
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
        push({ type: 'user_message', text: message })
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
