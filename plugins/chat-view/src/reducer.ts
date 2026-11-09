import type {
  AgentState,
  HistoryItem,
  PermissionModeOption,
  SessionEvent
} from '../../../src/shared/session-model'
import type { Attachment } from '../../../src/shared/attachments'
import { inputRequestMeta } from '@clave/contract/input-kinds'
import { formMessageMarker } from '../../../src/shared/form-message'

export type ChatEvent = SessionEvent
export type Permission = Extract<SessionEvent, { type: 'permission_request' }>
export type Entry =
  | {
      kind: 'user'
      text: string
      final: boolean
      /** The message arrived while the turn before it was still going, the
       *  agent working or waiting on a permission (Claude takes one mid-turn
       *  and queues it; another tab's message lands the same way): it did not
       *  end that turn. The fold of the agent's working notes reads it
       *  (stretches.ts, PRDCT-4212). */
      midTurn?: boolean
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
  | {
      kind: 'assistant'
      text: string
      final: boolean
      at: number
      /** The turn ended on these words: the kernel went idle, done or ended
       *  with them as the agent's last. The agent may carry on later without
       *  a new message (a background task reporting back), and the fold of
       *  its working notes must not take these words for a note then
       *  (stretches.ts, PRDCT-4212). */
      closes?: boolean
    }
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
      /** What the reader chose, for a request that asked questions: one
       *  string per question, or the labels of a hosted multi-select. */
      answers?: Record<string, string | string[]>
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
      /** A form the agent asked (clave_request_input, PRDCT-4157), still
       *  open: the fields the agent set from what the reader said, which the
       *  card shows as they land. */
      draft?: Record<string, string | string[]>
      /** The form was approved, then a field was set again by the agent. */
      revised?: boolean
      /** The agent's word under a field it could not fill, by key; gone as
       *  the field changes. */
      notes?: Record<string, string>
      /** A form that settled was moved to the end of the conversation, where
       *  it stood while it was open: this is the entry it left behind, kept
       *  for the rows' keys and never drawn. */
      relocated?: boolean
      /** The settled form, where it was moved to: the reader's own doing,
       *  never the agent's answer to what the reader last wrote. */
      moved?: boolean
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
  /** The run of the process whose state this is (`Session.run`), once a
   *  frame or the subscribe answer named one: a `state_change` of an older
   *  run is the old process's word and leaves the state alone
   *  (PRDCT-4191). Null until the host has said. */
  run: number | null
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
  run: null,
  model: null,
  effort: null,
  permissionMode: null
}
export type Action =
  | { event: ChatEvent; at?: number }
  | { answer: string; optionId: string; answers?: Record<string, string | string[]> }
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
  /** The host's own word on the session, as the subscribe answered it
   *  (PRDCT-4191): its state and its run, which win over the seed the pane
   *  took from the list it read at mount. */
  | { session: { state: AgentState; run?: number } }
  /** The connection to the session's server came back (PRDCT-4191): runs
   *  are ordered within one host lifetime only, and a reconnect may be to a
   *  host that counts from 1 again, so the run heard so far is forgotten
   *  and the first word of the new connection is taken whatever its number. */
  | { reconnected: true }

/** Whether anything answers the reader's last message yet: text, a tool call,
 *  a question, an error. What decides, on Escape, between taking the message
 *  back (nothing did) and leaving it in the transcript as interrupted. */
export function answeredSince(entries: Entry[]): boolean {
  const last = entries.findLastIndex((e) => e.kind === 'user')
  return entries
    .slice(last + 1)
    .some(
      (e) =>
        e.kind !== 'user' &&
        (e.kind !== 'assistant' || e.text.trim() !== '') &&
        !(e.kind === 'permission' && e.moved)
    )
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
/** The entries with the agent's last words marked as the ones the turn
 *  ended on (`closes`), when they are not yet; the same array otherwise. */
function closeTurn(entries: Entry[]): Entry[] {
  // Words, never an empty entry (a closing frame that opened nothing): the
  // views filter those out, and a mark on one would cut the turn nowhere.
  const index = entries.findLastIndex((e) => e.kind === 'assistant' && e.text.trim() !== '')
  const last = entries[index]
  if (last?.kind !== 'assistant' || last.closes) return entries
  const next = [...entries]
  next[index] = { ...last, closes: true }
  return next
}
const isSettled = (e: Extract<Entry, { kind: 'permission' }>): boolean =>
  e.answer !== undefined || e.answeredElsewhere === true
/** A form the agent asked floats at the end of the conversation while it is
 *  open (the view draws it after the rows), and stays where it closed: the
 *  moment the form of `id` leaves live, its settled entry is appended at the
 *  end and the one it left behind is kept for the rows' keys, undrawn. Once,
 *  for that id: a later correction, or a second word that it settled, moves
 *  nothing, and no other form is touched. */
function relocateSettled(entries: Entry[], id: string, wasLive: boolean, at: number): Entry[] {
  if (!wasLive) return entries
  const index = entries.findLastIndex(
    (e) => e.kind === 'permission' && e.request.id === id && !e.relocated
  )
  const entry = entries[index]
  if (
    entry?.kind !== 'permission' ||
    !isSettled(entry) ||
    inputRequestMeta(entry.request.input) === null ||
    index === entries.length - 1
  )
    return entries
  const next = [...entries]
  next[index] = { ...entry, relocated: true }
  next.push({ ...entry, moved: true, at })
  return next
}
/** Whether the form of `id` is still live in `entries`: its latest entry
 *  not settled. What `relocateSettled` is told before an event lands. */
function liveBefore(entries: Entry[], id: string): boolean {
  const entry = entries.findLast(
    (e) => e.kind === 'permission' && e.request.id === id && !e.relocated
  )
  return entry?.kind === 'permission' && !isSettled(entry)
}
export function reduceConversation(state: Conversation, action: Action): Conversation {
  if ('exit' in action) return { ...state, state: 'ended', exitCode: action.exit }
  if ('reconnected' in action) return state.run === null ? state : { ...state, run: null }
  if ('session' in action) {
    // The subscribe's answer is the host's current word AT THE TIME IT WAS
    // TAKEN: a run older than one already heard is a stale answer, and so
    // is an answer of the very run the stream has already spoken for (an
    // invoke reply is not ordered against the frames sent meanwhile: a
    // `working` heard first must not fall back to the reply's `idle`,
    // round 1, C3). Only a run the pane has not heard of applies.
    const run = action.session.run
    if (run !== undefined && state.run !== null && run <= state.run) return state
    const ended = action.session.state === 'ended'
    return {
      ...state,
      state: action.session.state,
      // An `ended` with no run is a host that runs nothing under this id (a
      // stopped record, after the server restarted): the runs start again
      // from the next process, whatever number the old host had reached.
      run: run ?? (ended ? null : state.run),
      // A live word clears the exit code a dead run left on the pane.
      ...(ended ? {} : { exitCode: undefined })
    }
  }
  if ('retire' in action) {
    // The host no longer holds the request this view's answer named: the
    // card leaves the dock with no answer recorded, since nothing ran. The
    // kernel's word stays the state; its next state_change says what is
    // awaited.
    const wasLive = liveBefore(state.entries, action.retire)
    const entries = settle(state.entries, (request) => request.id === action.retire)
    return entries === state.entries
      ? state
      : { ...state, entries: relocateSettled(entries, action.retire, wasLive, Date.now()) }
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
    // The past rebuilds the entries, never the state: the state is the
    // kernel's word on the stream (and the subscribe's answer), and a
    // replayed page may hold a fatal error or a blocked request of a process
    // that is no longer the one running (PRDCT-4191).
    // Replayed from rest: a transcript carries no state changes, and a replay
    // read under the live `working` would mark every message as mid-turn.
    const synced = action.sync.reduce(reduceConversation, {
      ...state,
      entries: [],
      first: 0,
      state: 'idle'
    })
    return { ...synced, state: state.state, run: state.run, exitCode: state.exitCode }
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
    const wasLive = liveBefore(state.entries, action.answer)
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
      entries: relocateSettled(entries, action.answer, wasLive, Date.now()),
      state: state.state === 'blocked' && !waiting ? 'working' : state.state
    }
  }
  const { event } = action
  const at = action.at ?? Date.now()
  if (event.type === 'state_change') {
    // A frame of an older run is the old process's word (its `ended` after
    // the new process's `idle`, heard out of order): it leaves the state
    // alone. A frame naming a newer run moves the pane to that run.
    if (event.run !== undefined && state.run !== null && event.run < state.run) return state
    // An `ended` with no run is the host's word that nothing runs under the
    // id any more (a stopped record told at bind, after a server restart):
    // the next process's run, whatever its number, is taken.
    const run = event.run ?? (event.state === 'ended' ? null : state.run)
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
    // A form the agent asked (PRDCT-4157) lives across the agent's turns: no
    // state of the kernel closes it; the server's own word does
    // (`permission_withdrawn`), or the reader's answer.
    const marks = event.state === 'working' || event.state === 'done' || event.state === 'idle'
    const clears = event.state === 'blocked'
    const touches = (e: Entry): boolean =>
      e.kind === 'permission' &&
      !e.answer &&
      !e.abandoned &&
      inputRequestMeta(e.request.input) === null &&
      (marks ? e.answeredElsewhere !== true : clears && e.answeredElsewhere === true)
    // A live word clears the exit code a dead run left on the pane, as the
    // subscribe's answer does: a process that ended with (exit 1) and came
    // back must not show that code again when the new run ends.
    const exitCode = event.state === 'ended' ? state.exitCode : undefined
    // The turn ended: its last words are marked as the ones it ended on.
    const closed =
      event.state === 'idle' || event.state === 'done' || event.state === 'ended'
        ? closeTurn(state.entries)
        : state.entries
    if (!closed.some(touches))
      return { ...state, entries: closed, state: event.state, run, exitCode }
    return {
      ...state,
      entries: closed.map((e) =>
        touches(e) ? { ...e, answeredElsewhere: marks ? true : undefined } : e
      ),
      state: event.state,
      run,
      exitCode
    }
  }
  if (event.type === 'permission_withdrawn') {
    // The adapter no longer waits on it: the card is settled for good, as the
    // server's request store settles its record on the same word, and no
    // later blocked reopens it. The kernel's own state_change follows.
    const wasLive = liveBefore(state.entries, event.id)
    const entries = settle(state.entries, (request) => request.id === event.id)
    return entries === state.entries
      ? state
      : { ...state, entries: relocateSettled(entries, event.id, wasLive, at) }
  }
  if (event.type === 'permission_updated') {
    // A form's answers changed under its card (PRDCT-4157): the agent set
    // fields on the open form (its draft, which the card shows landing), or
    // the form was approved (`sent`: every answer, for the views that did not
    // send them) or revised after its approval. The latest entry under the
    // id is the one that speaks for it.
    const index = state.entries.findLastIndex(
      (e) => e.kind === 'permission' && e.request.id === event.id
    )
    const entry = state.entries[index]
    if (entry?.kind !== 'permission') return state
    const entries = [...state.entries]
    if (event.sent || entry.answer) {
      // An empty value clears the answer, as the server dropped it.
      const answers = { ...entry.answers }
      for (const [key, value] of Object.entries(event.answers)) {
        if (value === '' || (Array.isArray(value) && value.length === 0)) delete answers[key]
        else answers[key] = value
      }
      const changed =
        entry.answer !== undefined &&
        Object.entries(event.answers).some(
          (pair) => JSON.stringify(entry.answers?.[pair[0]]) !== JSON.stringify(pair[1])
        )
      const wasLive = !isSettled(entry)
      entries[index] = {
        ...entry,
        answer: entry.answer ?? 'answer',
        answers,
        answeredElsewhere: undefined,
        abandoned: undefined,
        ...(changed && { revised: true })
      }
      return { ...state, entries: relocateSettled(entries, event.id, wasLive, at) }
    }
    // A note stands under its field until the field changes.
    const notes = { ...entry.notes, ...event.notes }
    for (const key of Object.keys(event.answers)) if (!event.notes?.[key]) delete notes[key]
    const { notes: _gone, ...rest } = entry
    void _gone
    entries[index] = {
      ...rest,
      draft: { ...entry.draft, ...event.answers },
      ...(Object.keys(notes).length ? { notes } : {})
    }
    return { ...state, entries }
  }
  // A subagent's own message, text, call or result (`parent`) is that
  // agent's, read by the view of it (`subagents.ts`), never the
  // conversation's: before this, a subagent's hundred calls were counted into
  // the run the conversation was on, as if the agent had made them itself.
  if ('parent' in event && event.parent) return state
  const entries = [...state.entries]
  switch (event.type) {
    case 'user_message':
      // A form's approve or skip, written to the agent as the reader's message
      // (PRDCT-4157): the form's record row already says it; no bubble. The
      // text has to say so itself, so nothing hides a bubble by the flag alone.
      if (event.form && formMessageMarker(event.text) === event.form) break
      entries.push({
        kind: 'user',
        text: event.text,
        final: true,
        at,
        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
        // Sent while the turn before was still going: it did not end it.
        ...(state.state === 'working' || state.state === 'blocked' ? { midTurn: true } : {})
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
