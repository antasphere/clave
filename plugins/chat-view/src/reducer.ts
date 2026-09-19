import type { AgentState, SessionEvent } from '../../../src/shared/session-model'

export type ChatEvent = SessionEvent
export type Permission = Extract<SessionEvent, { type: 'permission_request' }>
export type Entry =
  | { kind: 'user' | 'assistant'; text: string; final: boolean; at: number }
  | {
      kind: 'tool'
      id: string
      name?: string
      input?: unknown
      output?: unknown
      complete: boolean
      at: number
    }
  | { kind: 'permission'; request: Permission; answer?: string; at: number }
  | { kind: 'error'; message: string; at: number }
  | { kind: 'raw'; event: unknown; at: number }
export interface Conversation {
  entries: Entry[]
  state: AgentState
  model: string | null
  exitCode?: number
}
export const emptyConversation: Conversation = { entries: [], state: 'idle', model: null }
export type Action =
  | { event: ChatEvent; at?: number }
  | { answer: string; optionId: string }
  | { exit: number }
export function reduceConversation(state: Conversation, action: Action): Conversation {
  if ('exit' in action) return { ...state, state: 'ended', exitCode: action.exit }
  if ('answer' in action) {
    const entries = state.entries.map((e) =>
      e.kind === 'permission' && e.request.id === action.answer
        ? { ...e, answer: action.optionId }
        : e
    )
    const waiting = entries.some((e) => e.kind === 'permission' && !e.answer)
    return {
      ...state,
      entries,
      state: state.state === 'blocked' && !waiting ? 'working' : state.state
    }
  }
  const { event } = action
  const at = action.at ?? Date.now()
  const entries = [...state.entries]
  switch (event.type) {
    case 'user_message':
      entries.push({ kind: 'user', text: event.text, final: true, at })
      break
    case 'assistant_text': {
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && !last.final)
        entries[entries.length - 1] = { ...last, text: last.text + event.delta, final: event.final }
      else entries.push({ kind: 'assistant', text: event.delta, final: event.final, at })
      break
    }
    case 'tool_call':
    case 'tool_result': {
      const index = entries.findIndex((e) => e.kind === 'tool' && e.id === event.id)
      const previous =
        index < 0 ? { kind: 'tool' as const, id: event.id, complete: false, at } : entries[index]
      if (previous.kind !== 'tool') break
      const tool =
        event.type === 'tool_call'
          ? { ...previous, name: event.name, input: event.input }
          : { ...previous, output: event.output, complete: true }
      if (index < 0) entries.push(tool)
      else entries[index] = tool
      break
    }
    case 'permission_request':
      if (!entries.some((e) => e.kind === 'permission' && e.request.id === event.id))
        entries.push({ kind: 'permission', request: event, at })
      return { ...state, entries, state: 'blocked' }
    case 'state_change':
      return { ...state, state: event.state }
    case 'session_meta':
      return { ...state, model: event.model }
    case 'error':
      entries.push({ kind: 'error', message: event.message, at })
      return { ...state, entries, state: event.fatal ? 'ended' : state.state }
    case 'provider_event':
      entries.push({ kind: 'raw', event, at })
      break
  }
  return { ...state, entries }
}
