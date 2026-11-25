import type {
  AgentState,
  HistoryItem,
  PermissionModeOption,
  SessionEvent,
  WaitingMessage
} from '../../../src/shared/session-model'
import type { Attachment } from '../../../src/shared/attachments'
import { inputRequestMeta } from '@clave/contract/input-kinds'
import { formMessageMarker } from '../../../src/shared/form-message'
import { holdStatusTail, readStatusCard, type StatusCard } from '../../../src/shared/status-card'
import { sameId } from './models'

export type ChatEvent = SessionEvent
export type Permission = Extract<SessionEvent, { type: 'permission_request' }>
const permissionDefinition = (request: Permission): string =>
  JSON.stringify(request, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )
/** What a request does, as the session's host read it (PRDCT-4331). */
export type PermissionReading = Extract<SessionEvent, { type: 'permission_explained' }>
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
      /** The status the message ended on, taken out of `text`
       *  (`readStatusCard`, PRDCT-5166): drawn as a card under the words. */
      card?: StatusCard
      /** The end of a message still being written that may be its status
       *  block, kept out of `text` until the message is final
       *  (`holdStatusTail`), so the block never shows as code on its way in. */
      held?: string
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
      /** What the reader had typed into the open form, as the server holds
       *  it (PRDCT-4210), handed to a view that came late: the card starts
       *  from it, and nothing of it lands or reads as the agent's fill. */
      typed?: Record<string, string | string[]>
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
  /** `quiet`: nothing failed, a plain fact of the turn the adapter said as a
   *  notice (another tab's message left unsent, PRDCT-4566): every view
   *  draws it as a quiet line of the conversation, never in the failure's
   *  red, and it answers nothing. */
  | { kind: 'error'; message: string; at: number; notice?: string; quiet?: boolean }
  /** The permission mode changed (PRDCT-4331): one line, said in the
   *  transcript, never for the first word on the mode nor for a repeat.
   *  `by` is known when this view asked for the switch. */
  | {
      kind: 'mode'
      mode: string
      label: string
      from: string
      fromLabel: string
      by?: 'you'
      at: number
    }
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
  /** The model the reader just picked from the chip, until the provider
   *  confirms it (a `session_meta` naming it clears this) or refuses it (an
   *  `error` clears it, and the chip reads `model` again). The chip and the
   *  effort chip read it over `model` while it is set, so a switch shows the
   *  instant it is made, not one or two seconds later at the CLI's answer
   *  (PRDCT-4273). */
  pendingModel: string | null
  /** The reasoning effort the provider last reported; null while it has not
   *  said, or for a model that runs at none. */
  effort: string | null
  /** The mode the agent asks in and the modes it can switch to; null for a
   *  provider that has none, and the view shows no switch. */
  permissionMode: { mode: string; modes: PermissionModeOption[] } | null
  /** The mode this view asked the provider for, until the provider says it
   *  switched (the mode line then reads who asked). */
  askedMode?: string
  /** The first mode the provider reported: the one the tab was launched in
   *  (PRDCT-4331, the way back is offered only to a tab launched skipping
   *  permissions). */
  launchedMode?: string
  /** What each permission request does, by its id, as the host read it
   *  (`permission_explained`, PRDCT-4331): kept apart from the entries, so a
   *  reading that arrives before its request, or a page of the past without
   *  the request, is not lost. */
  explained: Record<string, PermissionReading>
  exitCode?: number
  /** The messages written that the agent has not taken yet, as the adapter
   *  last listed them (PRDCT-4566): drawn in the stack above the composer,
   *  never in the transcript, until each enters it as the agent takes it. */
  waiting: WaitingMessage[]
  /** When the agent takes one: after the running turn, or at its next step;
   *  null until an adapter has listed what waits. */
  takes: Extract<SessionEvent, { type: 'waiting_messages' }>['takes'] | null
  /** The messages that last left the list unsent, for the composer to take
   *  back: a new value at each return, which the view takes once. */
  returned: NonNullable<Extract<SessionEvent, { type: 'waiting_messages' }>['returned']> | null
}
export const emptyConversation: Conversation = {
  entries: [],
  first: 0,
  state: 'idle',
  run: null,
  model: null,
  pendingModel: null,
  effort: null,
  permissionMode: null,
  explained: {},
  waiting: [],
  takes: null,
  returned: null
}
export type Action =
  | { event: ChatEvent; at?: number; current?: boolean }
  | { answer: string; optionId: string; answers?: Record<string, string | string[]> }
  | { exit: number }
  /** A page of the conversation's past, oldest first, in front of what is here.
   *  Main only cuts a page where nothing pairs across the cut (a tool call and
   *  its result, an interrupt and its message), so it reduces on its own. */
  | { prepend: HistoryItem[] }
  | { sync: HistoryItem[] }
  /** A positioned snapshot is authoritative, including an empty generation. */
  | { snapshot: HistoryItem[]; preserve?: number }
  /** The reader took their last message back before any answer to it. */
  | { withdraw: true }
  /** The reader's typing into an open form was sent to its draft
   *  (PRDCT-4210): the server now holds the reader's value in those fields,
   *  so the agent's earlier fill there is no longer the draft's, and the
   *  agent setting one again lands. */
  | { typedSent: string; answers: Record<string, string | string[]> }
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
  /** The reader picked a model from the chip (PRDCT-4273): shown at once,
   *  confirmed or reverted by the provider's answer. */
  | { pickModel: string }
  /** This view asked the provider for a permission mode (PRDCT-4331). */
  | { askMode: string }

export type AnswerEntry = Extract<Entry, { kind: 'assistant' }>
/** Whether an answer is something to draw: words, or a status card. A
 *  message that is a card alone has an empty `text` and is still the
 *  agent's message (it is drawn, it closes the turn, it finishes a page):
 *  the one rule every reader of an answer asks, never `text` alone. */
export const hasContent = (entry: AnswerEntry): boolean =>
  entry.text.trim() !== '' || entry.card !== undefined
/** An answer still being written, with `full` its whole text so far: the
 *  words to show now and the tail held back while it may be the status
 *  block. */
function streamAnswer(answer: AnswerEntry, full: string): AnswerEntry {
  const { held: _held, ...rest } = answer
  void _held
  const { body, held } = holdStatusTail(full)
  return { ...rest, text: body, final: false, ...(held ? { held } : {}) }
}
/** An answer once nothing more of it will come, with `full` its whole text:
 *  its card taken out when it ends on one, and otherwise every word it
 *  wrote, what was held included. Nothing an agent wrote is ever lost. */
function settleAnswer(answer: AnswerEntry, full = answer.text + (answer.held ?? '')): AnswerEntry {
  const { held: _held, ...rest } = answer
  void _held
  const { body, card } = readStatusCard(full)
  return card ? { ...rest, text: body, card, final: true } : { ...rest, text: full, final: true }
}
/** The entries with every answer that still holds a tail read as it stands:
 *  the stream ended under it (the turn closed, the process exited) without
 *  the frame that finishes it. The same array when none holds anything. */
function settleHeld(entries: Entry[]): Entry[] {
  if (!entries.some((e) => e.kind === 'assistant' && e.held !== undefined)) return entries
  return entries.map((e) => (e.kind === 'assistant' && e.held !== undefined ? settleAnswer(e) : e))
}
/** Whether anything answers the reader's last message yet: text, a tool call,
 *  a question, an error. What decides, on Escape, between taking the message
 *  back (nothing did) and leaving it in the transcript as interrupted. A
 *  quiet line answers nothing: the one a stop leaves for another tab's
 *  message (PRDCT-4566) would bring back the message Escape just took back. */
export function answeredSince(entries: Entry[]): boolean {
  const last = entries.findLastIndex((e) => e.kind === 'user')
  return entries
    .slice(last + 1)
    .some(
      (e) =>
        e.kind !== 'user' &&
        (e.kind !== 'assistant' || hasContent(e)) &&
        !(e.kind === 'permission' && e.moved) &&
        !(e.kind === 'error' && e.quiet)
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
  // Words or a card, never an empty entry (a closing frame that opened
  // nothing): the views filter those out, and a mark on one would cut the
  // turn nowhere.
  const index = entries.findLastIndex((e) => e.kind === 'assistant' && hasContent(e))
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
  if ('exit' in action)
    return {
      ...state,
      entries: settleHeld(state.entries),
      state: 'ended',
      exitCode: action.exit,
      pendingModel: null,
      waiting: []
    }
  if ('pickModel' in action) return { ...state, pendingModel: action.pickModel }
  if ('askMode' in action) return { ...state, askedMode: action.askMode }
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
  if ('typedSent' in action) {
    const index = state.entries.findLastIndex(
      (e) => e.kind === 'permission' && e.request.id === action.typedSent
    )
    const entry = state.entries[index]
    if (entry?.kind !== 'permission' || entry.answer || entry.answeredElsewhere) return state
    const draft = { ...entry.draft }
    const typed = { ...entry.typed }
    for (const [key, value] of Object.entries(action.answers)) {
      delete draft[key]
      if (value === '' || (Array.isArray(value) && value.length === 0)) delete typed[key]
      else typed[key] = value
    }
    const entries = [...state.entries]
    entries[index] = { ...entry, draft, typed }
    return { ...state, entries }
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
  if ('sync' in action || 'snapshot' in action) {
    const items = 'snapshot' in action ? action.snapshot : action.sync
    if ('sync' in action && !items.length) return state
    // The past rebuilds the entries, never the state: the state is the
    // kernel's word on the stream (and the subscribe's answer), and a
    // replayed page may hold a fatal error or a blocked request of a process
    // that is no longer the one running (PRDCT-4191).
    // Replayed from rest: a transcript carries no state changes, and a replay
    // read under the live `working` would mark every message as mid-turn.
    // The mode is replayed from no mode, so the past's first word on it is
    // no change; the live word stands when the past says none.
    const boundary = 'snapshot' in action ? action.preserve : undefined
    let synced = items.slice(0, boundary).reduce(reduceConversation, {
      ...state,
      entries: [],
      first: 0,
      state: 'idle',
      permissionMode: null,
      launchedMode: undefined
    })
    if (boundary !== undefined) {
      // Same-generation history cannot recover private typing or fields the
      // person cleared. Keep the view's current open hosted form at its last
      // applied position, then replay genuinely newer events over it.
      synced.entries = synced.entries.map((entry) => {
        if (
          entry.kind !== 'permission' ||
          isSettled(entry) ||
          !inputRequestMeta(entry.request.input)
        )
          return entry
        const previous = state.entries.findLast(
          (old) => old.kind === 'permission' && old.request.id === entry.request.id
        )
        if (
          previous?.kind !== 'permission' ||
          isSettled(previous) ||
          permissionDefinition(previous.request) !== permissionDefinition(entry.request)
        )
          return entry
        return { ...entry, draft: previous.draft, typed: previous.typed, notes: previous.notes }
      })
      synced = items.slice(boundary).reduce(reduceConversation, synced)
    }
    return {
      ...synced,
      state: state.state,
      run: state.run,
      exitCode: state.exitCode,
      permissionMode: synced.permissionMode ?? state.permissionMode,
      launchedMode: synced.launchedMode ?? state.launchedMode,
      // What waits for the agent is the live word, never the past's: a page
      // that held a list or a return would show or hand back again what is
      // gone (PRDCT-4566).
      waiting: state.waiting,
      takes: state.takes,
      returned: state.returned
    }
  }
  if ('prepend' in action) {
    // A notice the adapter keeps in the past AND said live (a Pi or OpenCode
    // chat refused at start, PRDCT-4427) is shown once: the past's copy of a
    // notice this pane already heard live is dropped.
    const heard = new Set(state.entries.flatMap((e) => (e.kind === 'error' ? [e.message] : [])))
    const items = heard.size
      ? action.prepend.filter(
          (item) => item.event.type !== 'error' || !heard.has(item.event.message)
        )
      : action.prepend
    if (!items.length) return state
    const earlier = items.reduce(reduceConversation, emptyConversation)
    const past = earlier.entries
    return {
      ...state,
      entries: [...past, ...state.entries],
      first: state.first - past.length,
      explained: { ...earlier.explained, ...state.explained },
      // The past's word on the model stands until the live one says its own
      // (PRDCT-4427): an OpenCode or Pi tab says it once.
      model: state.model ?? earlier.model
    }
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
    // The turn ended: its last words are marked as the ones it ended on,
    // after an answer the stream left holding a tail is read as it stands.
    const closed =
      event.state === 'idle' || event.state === 'done' || event.state === 'ended'
        ? closeTurn(settleHeld(state.entries))
        : state.entries
    // Nothing waits for a process that is gone (PRDCT-4566).
    const waiting = event.state === 'ended' ? [] : state.waiting
    if (!closed.some(touches))
      return { ...state, entries: closed, state: event.state, run, exitCode, waiting }
    return {
      ...state,
      entries: closed.map((e) =>
        touches(e) ? { ...e, answeredElsewhere: marks ? true : undefined } : e
      ),
      state: event.state,
      run,
      exitCode,
      waiting
    }
  }
  if (event.type === 'waiting_messages')
    // What waits for the agent is the stack's, never the transcript's: a
    // message enters the conversation as its own `user_message`, the moment
    // the agent takes it (PRDCT-4566).
    return {
      ...state,
      waiting: event.messages,
      takes: event.takes,
      ...(event.returned ? { returned: { ...event.returned } } : {})
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
    if (event.typed) {
      // The reader's own typing, kept by the server for this view: only an
      // open form takes it, and never into the agent's draft (PRDCT-4210).
      if (event.sent || entry.answer || entry.answeredElsewhere) return state
      // Replaying the server's typing retires the earlier agent fill just
      // as typedSent does, so a remounted card cannot land that old fill.
      const draft = { ...entry.draft }
      for (const key of Object.keys(event.answers)) delete draft[key]
      entries[index] = { ...entry, draft, typed: { ...entry.typed, ...event.answers } }
      return { ...state, entries }
    }
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
    // A field the agent set speaks for the agent again, as on the server.
    const typed = { ...entry.typed }
    for (const key of Object.keys(event.answers)) delete typed[key]
    entries[index] = {
      ...rest,
      draft: { ...entry.draft, ...event.answers },
      ...(entry.typed ? { typed } : {}),
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
      // The status block (PRDCT-5166) is taken out here and nowhere else, so
      // every reader of an answer reads its words alone: while the message
      // is written its possible block is held back, and once it is final the
      // block it ends on becomes its card.
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && !last.final) {
        const full = last.text + (last.held ?? '') + event.delta
        entries[entries.length - 1] = event.final
          ? settleAnswer(last, full)
          : streamAnswer(last, full)
      } else if (event.delta === '' && event.final) {
        // The turn's closing frame after a tool call: it closes the last open
        // answer and never opens an empty one of its own.
        const open = entries.findLastIndex((e) => e.kind === 'assistant' && !e.final)
        const answer = open >= 0 ? entries[open] : undefined
        if (answer?.kind === 'assistant') entries[open] = settleAnswer(answer)
      } else {
        const answer: AnswerEntry = { kind: 'assistant', text: '', final: false, at }
        entries.push(
          event.final ? settleAnswer(answer, event.delta) : streamAnswer(answer, event.delta)
        )
      }
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
    case 'permission_request': {
      const index = entries.findLastIndex(
        (e) => e.kind === 'permission' && e.request.id === event.id
      )
      const previous = entries[index]
      if (previous?.kind !== 'permission') entries.push({ kind: 'permission', request: event, at })
      // A restarted provider can reuse an id for a different question. Its
      // current definition and masking must not inherit the older card's
      // answers or typing. An identical repeat keeps the current draft.
      else if (permissionDefinition(previous.request) !== permissionDefinition(event))
        entries[index] = { kind: 'permission', request: event, at }
      // The unpositioned subscribe reply begins a complete current hosted
      // draft, including an empty one. This also applies when it arrives
      // after the HTTP snapshot. Settled cards cannot be reopened by it.
      else if (action.current && !isSettled(previous) && inputRequestMeta(event.input))
        entries[index] = { ...previous, draft: undefined, typed: undefined, notes: undefined }
      return { ...state, entries, state: 'blocked' }
    }
    case 'session_meta': {
      // The provider's word on the model. A pick is confirmed by the word
      // that names it (the switch's own echo, or the settings read after it
      // naming its resolution); any other word is kept as the model and the
      // pick stays shown, since a settings read answered out of order can
      // still carry the model from before the switch (round 2 of PRDCT-4256).
      const confirmed =
        state.pendingModel !== null &&
        event.model !== null &&
        sameId(event.model, state.pendingModel)
      return { ...state, model: event.model, ...(confirmed ? { pendingModel: null } : {}) }
    }
    case 'effort':
      return { ...state, effort: event.effort }
    case 'permission_mode': {
      // A change is said once in the transcript: not the first word on the
      // mode (the launch's), not a repeat (a switch this view asked for comes
      // back twice, the switch's answer and the CLI's own report).
      const before = state.permissionMode
      const askedMode = state.askedMode === event.mode ? undefined : state.askedMode
      if (before && before.mode !== event.mode) {
        const label = (id: string, modes: PermissionModeOption[]): string =>
          modes.find((m) => m.id === id)?.label ?? id
        entries.push({
          kind: 'mode',
          mode: event.mode,
          label: label(event.mode, event.modes),
          from: before.mode,
          fromLabel: label(before.mode, before.modes.length ? before.modes : event.modes),
          ...(state.askedMode === event.mode && { by: 'you' as const }),
          at
        })
      }
      return {
        ...state,
        entries,
        askedMode,
        launchedMode: state.launchedMode ?? event.mode,
        permissionMode: { mode: event.mode, modes: event.modes }
      }
    }
    case 'permission_explained':
      return { ...state, explained: { ...state.explained, [event.id]: event } }
    case 'error': {
      // A named notice stands for the latest of its kind (an OpenCode retry,
      // PRDCT-4427): the one before under that name gives way to it.
      const before = event.notice
        ? entries.findLastIndex((e) => e.kind === 'error' && e.notice === event.notice)
        : -1
      if (before >= 0) entries.splice(before, 1)
      entries.push({
        kind: 'error',
        message: event.message,
        at,
        ...(event.notice ? { notice: event.notice } : {}),
        ...(event.quiet ? { quiet: true } : {})
      })
      // A refused switch comes back as an error (the CLI's reason, or the
      // adapter's refusal of the write): the chip reads the model it is still
      // on. Any other error in that window reverts it the same way, and the
      // switch's own confirmation, when it comes, names the model again. A
      // named notice or a quiet line refuses nothing: the pick stands.
      return {
        ...state,
        entries,
        state: event.fatal ? 'ended' : state.state,
        pendingModel: event.notice || event.quiet ? state.pendingModel : null
      }
    }
    case 'turn_interrupted': {
      // The message that started the turn is the last one the reader sent;
      // an answer still streaming when the stop landed is closed as it stands.
      const started = entries.findLastIndex((e) => e.kind === 'user')
      const message = started >= 0 ? entries[started] : undefined
      if (message?.kind === 'user') entries[started] = { ...message, interrupted: true }
      const open = entries.findLastIndex((e) => e.kind === 'assistant' && !e.final)
      const answer = open >= 0 ? entries[open] : undefined
      if (answer?.kind === 'assistant') entries[open] = settleAnswer(answer)
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
