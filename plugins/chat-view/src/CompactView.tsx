import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import type { SessionInput } from '../../../src/shared/session-model'
import {
  useSessionLogValue,
  type LoggedEvent
} from '../../../src/renderer/src/views/conversation-store'
import { emptyConversation, reduceConversation, type Conversation } from './reducer'
import {
  failureCount,
  groupEntries,
  groupStatus,
  toolGroupSummary,
  visibleEntries,
  type Block
} from './tools'
import type { ChatViewProps } from './ChatView'

/** The same events the chat view reads, read as a list: one line per turn, no
 *  markdown, no tool bodies. The second view this plugin contributes, and the
 *  proof that two views of one plugin read one session — the host keeps the
 *  log, each view reduces it its own way. */
function reduceLog(events: LoggedEvent[], initialState: Conversation['state']): Conversation {
  return events.reduce(reduceConversation, { ...emptyConversation, state: initialState })
}
/** What a row says about a turn, in the fewest words that still identify it.
 *  A run of tools is ONE row here as it is in the conversation view — the same
 *  `groupEntries`, so the two views break a run in the same place — but it never
 *  expands: this view's whole contract is one line per turn and no tool bodies,
 *  and the summary is what that run looks like at this altitude. */
function lineOf(entry: Exclude<Block, { kind: 'tool-group' }>): { role: string; text: string } {
  switch (entry.kind) {
    case 'user':
      return {
        role: 'You',
        text: entry.attachments?.length
          ? `${entry.text} [${entry.attachments.map((f) => f.name).join(', ')}]`.trim()
          : entry.text
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
export function CompactView({ session, onState }: ChatViewProps): React.JSX.Element {
  const log = useSessionLogValue(session.id)
  const conversation = useMemo(
    () => reduceLog(log.events, session.state),
    [log.events, session.state]
  )
  const waiting = conversation.entries.some((e) => e.kind === 'permission' && !e.answer)
  const exited = log.exitCode !== undefined
  const state =
    exited || conversation.state === 'ended' ? 'ended' : waiting ? 'blocked' : conversation.state
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    const el = scroll.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [conversation.entries])
  const send = async (): Promise<void> => {
    if (!log.ready || sending || state === 'ended' || !draft.trim()) return
    const text = draft
    setSending(true)
    stuck.current = true
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
      <div
        ref={scroll}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight
        }}
      >
        {conversation.entries.length === 0 ? (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <ChatBubbleLeftRightIcon />
            </span>
            <h2>Nothing yet</h2>
            <p>This session has said nothing so far.</p>
          </div>
        ) : (
          <ol className="chat-column" aria-label="Conversation, compact">
            {groupEntries(visibleEntries(conversation.entries)).map((block, index) => {
              const line = block.kind === 'tool-group' ? toolLine(block.tools) : lineOf(block)
              return (
                <li
                  key={block.kind === 'tool-group' ? `tools-${block.id}` : index}
                  className="flex items-baseline gap-2 min-w-0"
                  data-kind={block.kind}
                  data-state={block.kind === 'tool-group' ? groupStatus(block.tools) : undefined}
                  data-failures={
                    block.kind === 'tool-group' ? failureCount(block.tools) : undefined
                  }
                >
                  <span className="text-text-tertiary text-xs shrink-0">{line.role}</span>
                  <span className="truncate" title={line.text}>
                    {line.text.replace(/\s+/g, ' ').trim()}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </div>
      <div className="chat-composer-wrap">
        {failure && <p className="text-text-tertiary text-xs">{failure}</p>}
        {/* Not `chat-composer`: that class is the conversation view's own box,
            and both views are mounted at once — one class on two elements is a
            strict locator resolving to two, which is how the chat view's own
            end-to-end spec went red. The field carries its own frame. */}
        <div className="flex items-center gap-2">
          <input
            className="input-field"
            value={draft}
            placeholder={state === 'ended' ? 'Session ended' : 'Message'}
            disabled={state === 'ended' || !log.ready}
            aria-label="Message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
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
