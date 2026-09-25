import type { AgentState, HistoryItem, SessionEvent } from '../../../src/shared/session-model'
import type { Attachment } from '../../../src/shared/attachments'

export type ChatEvent = SessionEvent
export type Permission = Extract<SessionEvent, { type: 'permission_request' }>
export type Entry =
  | {
      kind: 'user'
      text: string
      final: boolean
      at: number
      attachments?: Attachment[]
      /* The reader stopped the turn this message started, so the agent never
         finished with it: the row reads muted, and the text is back in the
         composer when Escape did the stopping. The adapter's word
         (`turn_interrupted`), never inferred from an error. */
      interrupted?: boolean
    }
  | { kind: 'assistant'; text: string; final: boolean; at: number }
  | {
      kind: 'tool'
      id: string
      name?: string
      input?: unknown
      output?: unknown
      complete: boolean
      /* The ADAPTER's word that this call failed, carried through untouched.
         Absent means no adapter said so — never a guess read off the output,
         which on a Read of a log file would call every error line a failure. */
      failed?: boolean
      at: number
    }
  | {
      kind: 'permission'
      request: Permission
      answer?: string
      /** What the reader chose, for a request that asked questions. */
      answers?: Record<string, string>
      /* The kernel left blocked while this request was still open, so the
         adapter is no longer holding it: it abandoned the request (Claude's
         `control_cancel_request` and the end-of-turn `result` both drop their
         pending set, claude-adapter.ts:198-213), or another consumer of this
         window answered it through sessionsWrite. Not another WINDOW: the
         session IPC refuses a subscribe or a write whose window key is not the
         session's (sessions/ipc.ts:34, :79-93). Either way the card offers no
         click the adapter would refuse. */
      answeredElsewhere?: boolean
      at: number
    }
  | { kind: 'error'; message: string; at: number }
export interface Conversation {
  entries: Entry[]
  /** The ordinal of `entries[0]`: an entry's `first + index` is its own for
   *  good, the key a view renders it under. Only a page of the past moves it,
   *  down by the entries put in front, so no entry already on screen changes
   *  key — as it would under a plain index, remounting the transcript. */
  first: number
  state: AgentState
  model: string | null
  exitCode?: number
}
export const emptyConversation: Conversation = { entries: [], first: 0, state: 'idle', model: null }
export type Action =
  | { event: ChatEvent; at?: number }
  | { answer: string; optionId: string; answers?: Record<string, string> }
  | { exit: number }
  /** A page of the conversation's past, oldest first, in front of what is here.
   *  Main only cuts a page where nothing pairs across the cut (a tool call and
   *  its result, an interrupt and its message), so it reduces on its own. */
  | { prepend: HistoryItem[] }
export function reduceConversation(state: Conversation, action: Action): Conversation {
  if ('exit' in action) return { ...state, state: 'ended', exitCode: action.exit }
  if ('prepend' in action) {
    if (!action.prepend.length) return state
    const past = action.prepend.reduce(reduceConversation, emptyConversation).entries
    return { ...state, entries: [...past, ...state.entries], first: state.first - past.length }
  }
  if ('answer' in action) {
    const entries = state.entries.map((e) =>
      e.kind === 'permission' && e.request.id === action.answer
        ? { ...e, answer: action.optionId, ...(action.answers ? { answers: action.answers } : {}) }
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
    // The kernel record is the conversation's state, never the view's own tally
    // of what it answered. Leaving blocked means the adapter is holding no
    // request of ours any more, whether it was answered elsewhere or abandoned,
    // so a still-open card stops offering a click. Going back to blocked means
    // something IS awaited again — and the view cannot tell which request, so it
    // restores every card it had closed on the kernel's word. That is the right
    // way round: a card wrongly closed can never be answered (codex emits
    // working on every turn/started, approvals pending or not, and leaves an
    // approval whose turn id is empty in its set), while a card wrongly
    // reopened costs at worst one refused answer, which shows as an error card.
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
        // The turn's closing frame after a tool call: it closes the last open
        // answer and never opens an empty one of its own.
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
      if (previous.kind !== 'tool') break
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
    case 'error':
      entries.push({ kind: 'error', message: event.message, at })
      return { ...state, entries, state: event.fatal ? 'ended' : state.state }
    case 'turn_interrupted': {
      // The message that started the turn is the last one the reader sent;
      // an answer still streaming when the stop landed is closed as it stands.
      const started = entries.findLastIndex((e) => e.kind === 'user')
      const message = started >= 0 ? entries[started] : undefined
      if (message?.kind === 'user') entries[started] = { ...message, interrupted: true }
      const open = entries.findLastIndex((e) => e.kind === 'assistant' && !e.final)
      const answer = open >= 0 ? entries[open] : undefined
      if (answer?.kind === 'assistant') entries[open] = { ...answer, final: true }
      break
    }
    case 'provider_event':
      // The provider's own wire format is the adapter's business, not the
      // reader's: nothing of it reaches the transcript.
      break
  }
  return { ...state, entries }
}
