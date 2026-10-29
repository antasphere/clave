/**
 * The conversation reducer of the chat: the joining of `assistant_text`
 * deltas until `final`, the pairing of a tool call with its result by id,
 * the permission cards and what the kernel's state does to them, the pages
 * of the past put in front.
 *
 * Ported from the desktop's `plugins/chat-view/src/reducer.ts` (Clave, MIT),
 * semantics unchanged; the types come from the phone's mirror of the
 * contract instead of the renderer's zod model. The desktop's file is the
 * original: a change there is a change here.
 */
import type {
  AgentState,
  Attachment,
  HistoryItem,
  PermissionModeOption,
  PermissionRequestEvent,
  SessionEvent
} from '../contract/types'

export type ChatEvent = SessionEvent
export type Permission = PermissionRequestEvent
export type Entry =
  | {
      kind: 'user'
      text: string
      final: boolean
      at: number
      attachments?: readonly Attachment[]
      /** The reader stopped the turn this message started (`turn_interrupted`). */
      interrupted?: boolean
      /** Taken back before the agent answered anything; undone if an answer arrives. */
      withdrawn?: boolean
    }
  | { kind: 'assistant'; text: string; final: boolean; at: number }
  | {
      kind: 'tool'
      id: string
      name?: string
      input?: unknown
      output?: unknown
      complete: boolean
      /** The adapter's word that this call failed, never a guess read off the output. */
      failed?: boolean
      at: number
    }
  | {
      kind: 'permission'
      request: Permission
      answer?: string
      answers?: Record<string, string>
      /** The kernel left blocked while this request was open: the adapter no
       *  longer holds it (abandoned, or answered by another client). */
      answeredElsewhere?: boolean
      at: number
    }
  | { kind: 'error'; message: string; at: number }

export interface Conversation {
  entries: Entry[]
  /** The ordinal of `entries[0]`: `first + index` is an entry's key for good;
   *  only a page of the past moves it, so no entry on screen changes key. */
  first: number
  state: AgentState
  model: string | null
  effort: string | null
  permissionMode: { mode: string; modes: readonly PermissionModeOption[] } | null
  exitCode?: number
  /** The last fatal error the stream carried, for the phone's `error` state. */
  fatal?: string
}

export const emptyConversation: Conversation = {
  entries: [],
  first: 0,
  state: 'idle',
  model: null,
  effort: null,
  permissionMode: null
}

export type Action =
  | { event: ChatEvent; at?: number }
  | { answer: string; optionId: string; answers?: Record<string, string> }
  | { exit: number }
  /** A page of the past, oldest first, in front of what is here. */
  | { prepend: readonly HistoryItem[] }
  | { sync: readonly HistoryItem[] }
  | { withdraw: true }

export function answeredSince(entries: Entry[]): boolean {
  const last = entries.findLastIndex((e) => e.kind === 'user')
  return entries
    .slice(last + 1)
    .some((e) => e.kind !== 'user' && (e.kind !== 'assistant' || e.text.trim() !== ''))
}

const reduceItem = (state: Conversation, item: HistoryItem): Conversation =>
  reduceConversation(
    state,
    item.at === undefined ? { event: item.event } : { event: item.event, at: item.at }
  )

export function reduceConversation(state: Conversation, action: Action): Conversation {
  if ('exit' in action) return { ...state, state: 'ended', exitCode: action.exit }
  if ('withdraw' in action) {
    if (answeredSince(state.entries)) return state
    const last = state.entries.findLastIndex((e) => e.kind === 'user')
    const message = state.entries[last]
    if (message?.kind !== 'user') return state
    const entries = [...state.entries]
    entries[last] = { ...message, withdrawn: true }
    return { ...state, entries }
  }
  if ('sync' in action) {
    if (!action.sync.length) return state
    return action.sync.reduce(reduceItem, { ...state, entries: [], first: 0 })
  }
  if ('prepend' in action) {
    if (!action.prepend.length) return state
    const past = action.prepend.reduce(reduceItem, emptyConversation).entries
    return { ...state, entries: [...past, ...state.entries], first: state.first - past.length }
  }
  if ('answer' in action) {
    const entries = state.entries.map((e) =>
      e.kind === 'permission' && e.request.id === action.answer
        ? {
            ...e,
            answer: action.optionId,
            answeredElsewhere: undefined,
            ...(action.answers ? { answers: action.answers } : {})
          }
        : e
    )
    const waiting = entries.some(
      (e) => e.kind === 'permission' && !e.answer && !e.answeredElsewhere
    )
    return {
      ...state,
      entries,
      state: state.state === 'blocked' && !waiting ? 'working' : state.state
    }
  }
  const { event } = action
  const at = action.at ?? Date.now()
  if (event.type === 'state_change') {
    const marks = event.state === 'working' || event.state === 'done' || event.state === 'idle'
    const clears = event.state === 'blocked'
    const touches = (e: Entry): boolean =>
      e.kind === 'permission' &&
      !e.answer &&
      (marks ? e.answeredElsewhere !== true : clears && e.answeredElsewhere === true)
    if (!state.entries.some(touches)) return { ...state, state: event.state }
    return {
      ...state,
      entries: state.entries.map((e) =>
        touches(e) ? { ...e, answeredElsewhere: marks ? true : undefined } : e
      ),
      state: event.state
    }
  }
  const entries = [...state.entries]
  switch (event.type) {
    case 'user_message':
      entries.push({
        kind: 'user',
        text: event.text,
        final: true,
        at,
        ...(event.attachments?.length ? { attachments: event.attachments } : {})
      })
      break
    case 'assistant_text': {
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && !last.final)
        entries[entries.length - 1] = { ...last, text: last.text + event.delta, final: event.final }
      else if (event.delta === '' && event.final) {
        const open = entries.findLastIndex((e) => e.kind === 'assistant' && !e.final)
        const answer = open >= 0 ? entries[open] : undefined
        if (answer?.kind === 'assistant') entries[open] = { ...answer, final: true }
      } else entries.push({ kind: 'assistant', text: event.delta, final: event.final, at })
      break
    }
    case 'tool_call':
    case 'tool_result': {
      const index = entries.findIndex((e) => e.kind === 'tool' && e.id === event.id)
      const previous =
        index < 0 ? { kind: 'tool' as const, id: event.id, complete: false, at } : entries[index]
      if (!previous || previous.kind !== 'tool') break
      const tool =
        event.type === 'tool_call'
          ? { ...previous, name: event.name, input: event.input }
          : { ...previous, output: event.output, complete: true, failed: event.error }
      if (index < 0) entries.push(tool)
      else entries[index] = tool
      break
    }
    case 'permission_request':
      if (!entries.some((e) => e.kind === 'permission' && e.request.id === event.id))
        entries.push({ kind: 'permission', request: event, at })
      return { ...state, entries, state: 'blocked' }
    case 'session_meta':
      return { ...state, model: event.model }
    case 'effort':
      return { ...state, effort: event.effort }
    case 'permission_mode':
      return { ...state, permissionMode: { mode: event.mode, modes: event.modes } }
    case 'error':
      entries.push({ kind: 'error', message: event.message, at })
      return event.fatal
        ? { ...state, entries, state: 'ended', fatal: event.message }
        : { ...state, entries }
    case 'turn_interrupted': {
      const started = entries.findLastIndex((e) => e.kind === 'user')
      const message = started >= 0 ? entries[started] : undefined
      if (message?.kind === 'user') entries[started] = { ...message, interrupted: true }
      const open = entries.findLastIndex((e) => e.kind === 'assistant' && !e.final)
      const answer = open >= 0 ? entries[open] : undefined
      if (answer?.kind === 'assistant') entries[open] = { ...answer, final: true }
      break
    }
    case 'provider_event':
    case 'context_usage':
    case 'subagent_model':
    case 'background_tasks':
      break
  }
  const taken = entries.findLastIndex((e) => e.kind === 'user')
  const takenBack = entries[taken]
  if (takenBack?.kind === 'user' && takenBack.withdrawn && answeredSince(entries))
    entries[taken] = { ...takenBack, withdrawn: undefined }
  return { ...state, entries }
}
