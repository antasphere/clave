import { useEffect, useReducer, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUpIcon, StopIcon } from '@heroicons/react/24/outline'
import type { Session, SessionInput, AgentState } from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation } from './reducer'
import { ChatCode } from './code'

export interface ChatViewProps {
  session: Session
  onState: (state: AgentState, model: string | null) => void
}
const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
export function ChatView({ session, onState }: ChatViewProps): React.JSX.Element {
  const [conversation, dispatch] = useReducer(reduceConversation, {
    ...emptyConversation,
    state: session.state
  })
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const stop = window.electronAPI.onSessionStream(session.id, (value) => {
      if (value.kind === 'event') dispatch({ event: value.event })
    })
    const stopExit = window.electronAPI.onSessionStreamExit(session.id, (code) =>
      dispatch({ exit: code })
    )
    void window.electronAPI
      .sessionsSubscribe(session.id)
      .then(() => {
        if (live) setReady(true)
      })
      .catch((error) => dispatch({ event: { type: 'error', message: String(error), fatal: true } }))
    return () => {
      live = false
      stop()
      stopExit()
      void window.electronAPI.sessionsUnsubscribe(session.id)
    }
  }, [session.id])
  const waiting = conversation.entries.some((e) => e.kind === 'permission' && !e.answer)
  const state = conversation.state === 'ended' ? 'ended' : waiting ? 'blocked' : conversation.state
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [conversation.entries])
  const write = async (input: SessionInput): Promise<void> => {
    await window.electronAPI.sessionsWrite(session.id, input)
  }
  const report = (error: unknown): void =>
    dispatch({ event: { type: 'error', message: String(error), fatal: false } })
  const send = async (): Promise<void> => {
    if (!ready || sending || state === 'ended' || !draft.trim()) return
    const text = draft
    setSending(true)
    try {
      await write({ type: 'user_message', text })
      setDraft((current) => (current === text ? '' : current))
    } catch (error) {
      report(error)
    } finally {
      setSending(false)
    }
  }
  const answer = async (id: string, optionId: string): Promise<void> => {
    setPending((current) => [...current, id])
    try {
      await write({ type: 'permission_response', id, optionId })
      dispatch({ answer: id, optionId })
    } catch (error) {
      report(error)
    } finally {
      setPending((current) => current.filter((value) => value !== id))
    }
  }
  return (
    <div className="chat-view" data-testid="chat-view">
      <div className="chat-turn-list" role="log" aria-label="Conversation">
        {conversation.entries.length === 0 && state !== 'ended' && (
          <div className="chat-empty">
            <h2>Start a conversation</h2>
            <p>Ask a question or describe what you want to build.</p>
          </div>
        )}
        {conversation.entries.map((entry, index) => {
          if (entry.kind === 'user' || entry.kind === 'assistant')
            return (
              <article
                key={index}
                className="chat-turn"
                data-role={entry.kind}
                title={new Date(entry.at).toLocaleTimeString()}
              >
                <div className="chat-turn-label">
                  {entry.kind === 'user' ? 'You' : session.provider}
                </div>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code: ChatCode,
                    a: ({ href, children }) =>
                      href && /^(https?:|mailto:)/i.test(href) ? (
                        <a
                          href={href}
                          onClick={(event) => {
                            event.preventDefault()
                            void window.electronAPI.openExternal(href).catch(report)
                          }}
                        >
                          {children}
                        </a>
                      ) : (
                        <span>{children}</span>
                      )
                  }}
                >
                  {entry.text}
                </ReactMarkdown>
              </article>
            )
          if (entry.kind === 'tool')
            return (
              <details key={index} className="chat-tool-card">
                <summary>
                  {entry.name ?? 'Tool result'}{' '}
                  <span>{entry.complete ? 'Complete' : 'Running'}</span>
                </summary>
                <div className="chat-card-body">
                  <div>Input</div>
                  <pre>{stringify(entry.input)}</pre>
                  {entry.complete && (
                    <>
                      <div>Result</div>
                      <pre>{stringify(entry.output)}</pre>
                    </>
                  )}
                </div>
              </details>
            )
          if (entry.kind === 'permission')
            return (
              <section key={index} className="chat-permission-card" aria-label="Permission request">
                <p>{entry.request.description}</p>
                {entry.request.toolName && <div>{entry.request.toolName}</div>}
                {entry.request.input !== undefined && (
                  <details>
                    <summary>Input</summary>
                    <pre>{stringify(entry.request.input)}</pre>
                  </details>
                )}
                <div className="chat-actions">
                  {entry.request.options.map((option, i) => (
                    <button
                      key={option.id}
                      className={i === 0 ? 'btn-primary' : 'btn-secondary'}
                      disabled={
                        !ready ||
                        !!entry.answer ||
                        pending.includes(entry.request.id) ||
                        state === 'ended'
                      }
                      onClick={() => void answer(entry.request.id, option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {entry.answer && (
                  <p role="status">
                    Answered:{' '}
                    {entry.request.options.find((option) => option.id === entry.answer)?.label ??
                      entry.answer}
                  </p>
                )}
              </section>
            )
          if (entry.kind === 'error')
            return (
              <div key={index} className="chat-notice" role="alert">
                {entry.message}
              </div>
            )
          if (entry.kind === 'raw' && import.meta.env.DEV)
            return (
              <details key={index} className="chat-tool-card">
                <summary>Raw event</summary>
                <pre>{stringify(entry.event)}</pre>
              </details>
            )
          return null
        })}
        {state === 'ended' && (
          <div className="chat-notice" role="status">
            Session ended
            {conversation.exitCode !== undefined ? ` (exit ${conversation.exitCode})` : ''}
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const paths = Array.from(event.dataTransfer.files)
            .map((file) => window.electronAPI.getPathForFile(file))
            .filter(Boolean)
          if (paths.length) setDraft((current) => [current, ...paths].filter(Boolean).join('\n'))
        }}
      >
        <textarea
          className="textarea-field"
          aria-label="Message"
          placeholder="Message…"
          value={draft}
          disabled={!ready || state === 'ended'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="chat-composer-footer">
          <span>Enter to send · Shift+Enter for a new line</span>
          {state === 'working' ? (
            <button
              type="button"
              className="panel-icon-btn"
              aria-label="Interrupt"
              onClick={() => void write({ type: 'interrupt' }).catch(report)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="panel-icon-btn"
              aria-label="Send message"
              disabled={!ready || sending || !draft.trim() || state === 'ended'}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
