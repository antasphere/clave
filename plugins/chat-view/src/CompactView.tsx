import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CustomContainerComponentProps, CustomItemComponentProps } from 'virtua'
import { ArrowUpIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import type { SessionInput } from '../../../src/shared/session-model'
import {
  loadEarlierLog,
  useSessionLogValue,
  type LoggedEvent
} from '../../../src/renderer/src/views/conversation-store'
import type { HistoryItem } from '../../../src/shared/session-model'
import { type Conversation } from './reducer'
import { foldLog, reducePast, withPast } from './fold-log'
import {
  failureCount,
  groupEntries,
  groupStatus,
  toolGroupSummary,
  visibleEntries,
  type Block
} from './tools'
import type { ChatViewProps } from './ChatView'
import { useComposerFocus } from './focus'
import { useMessageHistory } from './history'
import { useTranscriptEnd } from './transcript'
import { JumpToEnd } from './JumpToEnd'
import { useEarlier } from './earlier'
import { EarlierLoading } from './EarlierLoading'
import { TranscriptRows } from './rows'
import { parseDelivery } from '../../../src/shared/exchange-provenance'

/** The same events the chat view reads, read as a list: one line per turn, no
 *  markdown, no tool bodies. The second view this plugin contributes, and the
 *  proof that two views of one plugin read one session — the host keeps the
 *  log, each view reduces it its own way: this one folds it as it grows
 *  (`foldLog`), never replaying it. */
function useFoldedLog(
  past: HistoryItem[],
  events: LoggedEvent[],
  initial: Conversation['state']
): Conversation {
  // What the last render folded, kept the way React keeps it: in state,
  // advanced during render when the log has grown.
  const [folded, setFolded] = useState(() => foldLog(null, events, initial))
  let current = folded
  if (folded.events !== events || folded.initial !== initial) {
    current = foldLog(folded, events, initial)
    setFolded(current)
  }
  const before = useMemo(() => reducePast(past), [past])
  const live = current.live
  return useMemo(() => withPast(live, before), [live, before])
}
/** What a row says about a turn, in the fewest words that still identify it.
 *  A run of tools is ONE row here as it is in the conversation view — the same
 *  `groupEntries`, so the two views break a run in the same place — but it never
 *  expands: this view's whole contract is one line per turn and no tool bodies,
 *  and the summary is what that run looks like at this altitude. */
function lineOf(entry: Exclude<Block, { kind: 'tool-group' }>): { role: string; text: string } {
  switch (entry.kind) {
    case 'user': {
      const delivery = parseDelivery(entry.text)
      if (delivery)
        return { role: `From ${delivery.sender?.name ?? 'another agent'}`, text: delivery.body }
      return {
        role: entry.interrupted ? 'You · interrupted' : 'You',
        text: entry.attachments?.length
          ? `${entry.text} [${entry.attachments.map((f) => f.name).join(', ')}]`.trim()
          : entry.text
      }
    }
    case 'assistant':
      return { role: 'Agent', text: entry.text }
    case 'permission':
      return {
        role: 'Permission',
        text: entry.answer ? `${entry.request.description} — answered` : entry.request.description
      }
    case 'error':
      return { role: 'Error', text: entry.message }
  }
}
function toolLine(tools: Extract<Block, { kind: 'tool-group' }>['tools']): {
  role: string
  text: string
} {
  const status = groupStatus(tools)
  const failures = failureCount(tools)
  const summary = toolGroupSummary(tools)
  const suffix = status === 'running' ? ' — running…' : failures > 0 ? ` — ${failures} failed` : ''
  return { role: 'Tools', text: `${summary}${suffix}` }
}
interface Row {
  key: string
  block: Block
  line: { role: string; text: string }
}
/** The rows the list shows, for its items: the virtualiser hands an item only
 *  its index, and the item is the `<li>` that carries the row's kind and state. */
const CompactRowsContext = createContext<readonly Row[]>([])
function CompactList({ style, children, ref }: CustomContainerComponentProps): React.JSX.Element {
  return (
    <ol ref={ref} className="chat-rows" aria-label="Conversation, compact" style={style}>
      {children}
    </ol>
  )
}
function CompactItem({ style, index, children, ref }: CustomItemComponentProps): React.JSX.Element {
  const block = useContext(CompactRowsContext)[index]?.block
  const tools = block?.kind === 'tool-group' ? block.tools : undefined
  return (
    <li
      ref={ref}
      style={style}
      data-kind={block?.kind}
      data-state={tools ? groupStatus(tools) : undefined}
      data-failures={tools ? failureCount(tools) : undefined}
    >
      {children}
    </li>
  )
}
/** A line's own box inside its item: the virtualiser measures the item's
 *  content, so the column's rhythm is this box's padding, never the item's. */
function CompactLine({
  row,
  first,
  arriving
}: {
  row: Row
  first: boolean
  arriving: boolean
}): React.JSX.Element {
  const [arrive] = useState(arriving)
  return (
    <div
      className="chat-row flex items-baseline gap-2 min-w-0"
      data-first={first ? 'true' : undefined}
      data-arrive={arrive ? 'true' : undefined}
    >
      <span className="text-text-tertiary text-xs shrink-0">{row.line.role}</span>
      <span className="truncate" title={row.line.text}>
        {row.line.text.replace(/\s+/g, ' ').trim()}
      </span>
    </div>
  )
}
// A reader less than a screen from the end is still following the stream.
const screenSlack = (el: HTMLElement): number => el.clientHeight

export function CompactView({ session, onState }: ChatViewProps): React.JSX.Element {
  const log = useSessionLogValue(session.id)
  const conversation = useFoldedLog(log.past, log.events, session.state)
  // Each row keyed by its entry's ordinal, as in the conversation view, so a
  // page of the past arriving in front shifts no key.
  const ordinal = useMemo(() => {
    const map = new Map<unknown, number>()
    conversation.entries.forEach((entry, i) => map.set(entry, conversation.first + i))
    return map
  }, [conversation])
  const rows = useMemo(
    () =>
      groupEntries(visibleEntries(conversation.entries)).map(
        (block): Row => ({
          key: block.kind === 'tool-group' ? `tools-${block.id}` : `entry-${ordinal.get(block)}`,
          block,
          line: block.kind === 'tool-group' ? toolLine(block.tools) : lineOf(block)
        })
      ),
    [conversation.entries, ordinal]
  )
  const waiting = conversation.entries.some((e) => e.kind === 'permission' && !e.answer)
  const exited = log.exitCode !== undefined
  const state =
    exited || conversation.state === 'ended' ? 'ended' : waiting ? 'blocked' : conversation.state
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  const { draft, setDraft, recall } = useMessageHistory(session.id, conversation.entries)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState('')
  const transcript = useTranscriptEnd(conversation.entries, screenSlack)
  const fetchEarlier = useCallback(() => loadEarlierLog(session.id), [session.id])
  const earlier = useEarlier(transcript, !!log.before, fetchEarlier, conversation.entries)
  const field = useRef<HTMLInputElement>(null)
  useComposerFocus(session.id, log.ready && state !== 'ended', field)
  const send = async (): Promise<void> => {
    if (!log.ready || sending || state === 'ended' || !draft.trim()) return
    const text = draft
    setSending(true)
    transcript.stick()
    try {
      const input: SessionInput = { type: 'user_message', text }
      await window.electronAPI.sessionsWrite(session.id, input)
      setDraft((current) => (current === text ? '' : current))
      setFailure('')
    } catch (error) {
      setFailure(String(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="chat-view" data-view="compact">
      <div className="chat-transcript">
        <div ref={transcript.scroll} className="chat-scroll">
          <div className="chat-column">
            {/* Nothing is said to be empty before the past has been read. */}
            {conversation.entries.length === 0 && log.before !== undefined && (
              <div className="chat-empty">
                <span className="chat-empty-icon">
                  <ChatBubbleLeftRightIcon />
                </span>
                <h2>Nothing yet</h2>
                <p>This session has said nothing so far.</p>
              </div>
            )}
            {/* Mounted from the start, empty or not: what it gains is told apart
                from what it opened on by the rows it rendered before. */}
            <CompactRowsContext.Provider value={rows}>
              <TranscriptRows
                rows={rows}
                settled={log.before !== undefined}
                scroll={transcript.scroll}
                as={CompactList}
                item={CompactItem}
              >
                {(row, index, arriving) => (
                  <CompactLine key={row.key} row={row} first={index === 0} arriving={arriving} />
                )}
              </TranscriptRows>
            </CompactRowsContext.Provider>
          </div>
        </div>
        {earlier.loading && <EarlierLoading />}
        {transcript.away && <JumpToEnd onClick={transcript.jump} />}
      </div>
      <div className="chat-composer-wrap">
        {failure && <p className="text-text-tertiary text-xs">{failure}</p>}
        {/* Not `chat-composer`: that class is the conversation view's own box,
            and both views are mounted at once — one class on two elements is a
            strict locator resolving to two, which is how the chat view's own
            end-to-end spec went red. The field carries its own frame. */}
        <div className="flex items-center gap-2">
          <input
            ref={field}
            className="input-field"
            value={draft}
            placeholder={state === 'ended' ? 'Session ended' : 'Message'}
            disabled={state === 'ended' || !log.ready}
            aria-label="Message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (recall(event) !== null) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            className="panel-icon-btn"
            aria-label="Send"
            title="Send"
            disabled={state === 'ended' || !log.ready || sending || !draft.trim()}
            onClick={() => void send()}
          >
            <ArrowUpIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
