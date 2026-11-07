import type {
  AgentState,
  HistoryItem,
  PermissionModeOption,
  SessionEvent
} from '../../../src/shared/session-model'
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
         finished with it: the row reads muted. The adapter's word
         (`turn_interrupted`), never inferred from an error. */
      interrupted?: boolean
      /* Taken back before the agent answered anything (Escape): the message is
         the composer's again, so the transcript does not show it. Undone if an
         answer to it arrives after all. */
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
      /* The adapter no longer holds the request, for good: it said so
         (`permission_withdrawn`: the provider withdrew the request, or the
         turn ended with it open), or the host refused this view's answer as
         naming a request it does not hold. Always set together with
         `answeredElsewhere: true` (`settle` is the one writer), so the dock's
         filter reads the latter alone; a later `blocked` restores a card
         closed on the kernel's word and never this one, since an answer
         would only be refused (PRDCT-4032). */
      abandoned?: boolean
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
  /** The reasoning effort the provider last reported; null while it has not
   *  said, or for a model that runs at none. */
  effort: string | null
  /** The mode the agent asks in and the modes it can switch to; null for a
   *  provider that has none, and the view shows no switch. */
  permissionMode: { mode: string; modes: PermissionModeOption[] } | null
  exitCode?: number
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
  /** A page of the conversation's past, oldest first, in front of what is here.
   *  Main only cuts a page where nothing pairs across the cut (a tool call and
   *  its result, an interrupt and its message), so it reduces on its own. */
  | { prepend: HistoryItem[] }
  | { sync: HistoryItem[] }
  /** The reader took their last message back before any answer to it. */
  | { withdraw: true }
  /** The host refused this view's answer because it no longer holds the
   *  request: the card is retired without an answer. */
  | { retire: string }

/** Whether anything answers the reader's last message yet: text, a tool call,
 *  a question, an error. What decides, on Escape, between taking the message
 *  back (nothing did) and leaving it in the transcript as interrupted. */
export function answeredSince(entries: Entry[]): boolean {
  const last = entries.findLastIndex((e) => e.kind === 'user')
  return entries
    .slice(last + 1)
    .some((e) => e.kind !== 'user' && (e.kind !== 'assistant' || e.text.trim() !== ''))
}
/** What the reader can still answer, in the order asked: the dock shows the
 *  head of it and the rest queue behind. A card answered here, settled
 *  elsewhere or abandoned by the adapter is not in it. */
export function openRequests(entries: Entry[]): Permission[] {
  return entries.flatMap((e) =>
    e.kind === 'permission' && !e.answer && !e.answeredElsewhere ? [e.request] : []
  )
}
/** The entries with every unanswered request `matches` settled for good: the
 *  adapter no longer holds it, so no later blocked reopens it. The same array
 *  when nothing matches, so a view memoised on it does not rebuild. */
function settle(entries: Entry[], matches: (request: Permission) => boolean): Entry[] {
  const touches = (e: Entry): boolean =>
    e.kind === 'permission' && !e.answer && e.abandoned !== true && matches(e.request)
  return entries.some(touches)
    ? entries.map((e) => (touches(e) ? { ...e, answeredElsewhere: true, abandoned: true } : e))
    : entries
}
export function reduceConversation(state: Conversation, action: Action): Conversation {
  if ('exit' in action) return { ...state, state: 'ended', exitCode: action.exit }
  if ('retire' in action) {
    // The host no longer holds the request this view's answer named: the
    // card leaves the dock with no answer recorded, since nothing ran. The
    // kernel's word stays the state; its next state_change says what is
    // awaited.
    const entries = settle(state.entries, (request) => request.id === action.retire)
    return entries === state.entries ? state : { ...state, entries }
  }
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
    return action.sync.reduce(reduceConversation, { ...state, entries: [], first: 0 })
  }
  if ('prepend' in action) {
    if (!action.prepend.length) return state
    const past = action.prepend.reduce(reduceConversation, emptyConversation).entries
    return { ...state, entries: [...past, ...state.entries], first: state.first - past.length }
  }
  if ('answer' in action) {
    // The answer is this view's own, so it was never answered elsewhere: the
    // adapter leaves blocked as soon as it has the reply, and that
    // state_change can land before the write resolves here and mark the card
    // closed from outside (PermissionRow read "No longer awaiting an answer").
    const entries = state.entries.map((e) =>
      e.kind === 'permission' && e.request.id === action.answer
        ? {
            ...e,
            answer: action.optionId,
            answeredElsewhere: undefined,
            abandoned: undefined,
            ...(action.answers ? { answers: action.answers } : {})
          }
        : e
    )
    const waiting = openRequests(entries).length > 0
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
    // A card the adapter withdrew for good (`permission_withdrawn`), or whose
    // answer the host refused as naming no request, is never restored: back at
    // the head of the queue it hid the live request and took every click
    // (PRDCT-4032).
    const marks = event.state === 'working' || event.state === 'done' || event.state === 'idle'
    const clears = event.state === 'blocked'
    const touches = (e: Entry): boolean =>
      e.kind === 'permission' &&
      !e.answer &&
      !e.abandoned &&
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
  if (event.type === 'permission_withdrawn') {
    // The adapter no longer waits on it: the card is settled for good, as the
    // server's request store settles its record on the same word, and no
    // later blocked reopens it. The kernel's own state_change follows.
    const entries = settle(state.entries, (request) => request.id === event.id)
    return entries === state.entries ? state : { ...state, entries }
  }
  // A subagent's own message, text, call or result (`parent`) is that
  // agent's, read by the view of it (`subagents.ts`), never the
  // conversation's: before this, a subagent's hundred calls were counted into
  // the run the conversation was on, as if the agent had made them itself.
  if ('parent' in event && event.parent) return state
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
    case 'effort':
      return { ...state, effort: event.effort }
    case 'permission_mode':
      return { ...state, permissionMode: { mode: event.mode, modes: event.modes } }
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
  // An answer that was already on its way when the reader took the message
  // back: it answers something, so what it answers shows again.
  const taken = entries.findLastIndex((e) => e.kind === 'user')
  const takenBack = entries[taken]
  if (takenBack?.kind === 'user' && takenBack.withdrawn && answeredSince(entries))
    entries[taken] = { ...takenBack, withdrawn: undefined }
  return { ...state, entries }
}
