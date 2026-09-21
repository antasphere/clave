import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowUpIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ArrowPathIcon,
  ShieldCheckIcon,
  StopIcon
} from '@heroicons/react/24/outline'
import type {
  Session,
  SessionInput,
  AgentState,
  ModelOption,
  CommandOption
} from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation, type Entry } from './reducer'
import { ChatCode } from './code'
import { pathsFromDataTransfer, pathForMessage } from '../../../src/renderer/src/lib/dropped-paths'
import { ClaudeLogo, CodexLogo, PiLogo } from '../../../src/renderer/src/components/icons/cli-logos'

export interface ChatViewProps {
  session: Session
  onState: (state: AgentState, model: string | null) => void
}
const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
/* The one line a closed tool row shows beside its name: the argument a
   human would recognise it by (the command, the path, the query), else the
   first string the input carries, else the input on one line. */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']
function summarize(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const key =
      SUMMARY_KEYS.find((k) => typeof record[k] === 'string' && record[k]) ??
      Object.keys(record).find((k) => typeof record[k] === 'string' && record[k])
    if (key) return String(record[key])
  }
  return JSON.stringify(input) ?? ''
}
/** When a turn happened, the way a reader wants it: relative while fresh,
 *  clock time today, the date once it is older. */
function whenLabel(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const then = new Date(at)
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) return time
  const yesterday = new Date(now - 86_400_000)
  if (then.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
  return `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}
/** The line under a turn that appears on approach: when it was said, and a copy of it. */
function TurnMeta({ at, text }: { at: number; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="chat-turn-meta">
      <span title={new Date(at).toLocaleString()}>{whenLabel(at)}</span>
      <button
        type="button"
        className="chat-turn-copy"
        aria-label="Copy message"
        title="Copy message"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
      </button>
    </div>
  )
}
/** The provider's mark at the end of the transcript: breathing while the agent
 *  works (from the moment it starts, before any text), resting fully opaque
 *  under the finished answer. */
function ProviderMark({ provider, working }: { provider: string; working: boolean }): React.JSX.Element {
  const Logo = provider === 'claude' ? ClaudeLogo : provider === 'codex' ? CodexLogo : provider === 'pi' ? PiLogo : null
  return (
    <div
      className="chat-provider-mark"
      data-provider={provider}
      data-state={working ? 'working' : 'done'}
      role="status"
      aria-label={working ? `${provider} is working` : `${provider} finished`}
    >
      {Logo ? <Logo /> : <span className="chat-provider-mark-dot" />}
    </div>
  )
}
/** The "/" the composer opens on: the draft is a single line starting with a
 *  slash and no space yet — the moment a command is being named. */
const slashQuery = (draft: string): string | null => {
  const m = /^\/([\w:-]*)$/.exec(draft)
  return m ? m[1] : null
}
/** The commands a session offers, listed above the composer while a "/" is
 *  being typed; filtered by what follows the slash, walked with the arrows,
 *  taken with Tab or Enter. */
function SlashMenu({
  sessionId,
  query,
  onPick,
  onClose,
  bind
}: {
  sessionId: string
  query: string
  onPick: (command: CommandOption) => void
  onClose: () => void
  bind: (handler: ((event: React.KeyboardEvent) => boolean) | null) => void
}): React.JSX.Element {
  const [commands, setCommands] = useState<CommandOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.electronAPI.sessionsCommands(sessionId))
      .then((list) => {
        if (live) setCommands(list)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [sessionId])
  const q = query.toLowerCase()
  const shown = (commands ?? []).filter((c) => c.name.toLowerCase().includes(q))
  const index = Math.min(active, Math.max(shown.length - 1, 0))
  // The composer's textarea keeps the focus; it hands its arrow, Tab, Enter
  // and Escape keys here while the menu is open.
  useEffect(() => {
    bind((event) => {
      // A modified key is the composer's (Shift+Enter is a newline), never the menu's.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
      if (event.key === 'ArrowDown') setActive((i) => (i + 1) % Math.max(shown.length, 1))
      else if (event.key === 'ArrowUp')
        setActive((i) => (i - 1 + Math.max(shown.length, 1)) % Math.max(shown.length, 1))
      else if ((event.key === 'Enter' || event.key === 'Tab') && shown[index]) onPick(shown[index])
      else if (event.key === 'Escape') onClose()
      else return false
      return true
    })
    return () => bind(null)
  }, [bind, shown, index, onPick, onClose])
  return (
    <div className="menu-surface menu-pop-mount chat-slash-menu" role="listbox" aria-label="Commands">
      <div className="menu-label">Commands</div>
      {commands === null && !failure && <div className="chat-model-empty">Loading…</div>}
      {failure && <div className="chat-model-empty">Commands unavailable</div>}
      {commands?.length === 0 && (
        <div className="chat-model-empty">Commands load after the first message</div>
      )}
      {commands && commands.length > 0 && shown.length === 0 && (
        <div className="chat-model-empty">No command matches “/{query}”</div>
      )}
      <div className="chat-slash-list">
        {shown.map((command, i) => (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={i === index}
            className="menu-item chat-slash-option"
            data-selected={i === index ? 'true' : undefined}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(command)}
          >
            <span className="chat-slash-name">/{command.name}</span>
            {command.description && (
              <span className="chat-slash-hint">{command.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
// Only keep the transcript pinned to its end while the reader is already
// there; a reader who scrolled up to re-read is never yanked back down.
const STICK_THRESHOLD = 80
// The provider reports a full id (claude-opus-5-20260301); the menu lists the
// family (claude-opus-5). Either being a prefix of the other is the same model.
const sameModel = (reported: string | null, id: string): boolean =>
  reported === null
    ? id === 'default'
    : reported === id || reported.startsWith(id) || id.startsWith(reported)
/** The model chip on the composer's footer and the menu it opens above it. */
function ModelMenu({
  sessionId,
  model,
  disabled,
  onSelect
}: {
  sessionId: string
  model: string | null
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    // A host older than this plugin has no sessionsModels: that is the menu's
    // failure to report, never the pane's to crash on, so the call is made
    // inside the chain where a missing method rejects instead of throwing.
    Promise.resolve()
      .then(() => window.electronAPI.sessionsModels(sessionId))
      .then((list) => {
        if (live) setOptions(list)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [open, sessionId])
  const current = options?.find((option) => sameModel(model, option.id))
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        // Each opening asks the provider again, from a clean slate.
        if (next) setFailure(null)
        setOpen(next)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger"
          aria-label="Model"
          title="Change model"
          disabled={disabled}
        >
          <span className="chat-model-trigger-label">
            {current?.label ?? model ?? 'Default'}
          </span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Models"
        >
          <DropdownMenu.Label className="menu-label">Select model</DropdownMenu.Label>
          {options === null && !failure && <div className="chat-model-empty">Loading…</div>}
          {failure && <div className="chat-model-empty">Models unavailable</div>}
          {options?.length === 0 && !failure && (
            <div className="chat-model-empty">This session offers no other model</div>
          )}
          {options?.map((option) => {
            const selected = sameModel(model, option.id)
            return (
              <DropdownMenu.Item
                key={option.id}
                className="menu-item chat-model-option"
                data-selected={selected ? 'true' : undefined}
                onSelect={() => onSelect(option.id)}
              >
                <span className="chat-model-option-text">
                  <span className="truncate">{option.label}</span>
                  {option.hint && <span className="chat-model-option-hint">{option.hint}</span>}
                </span>
                {selected && <CheckIcon className="select-option-check" />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function ChatView({ session, onState }: ChatViewProps): React.JSX.Element {
  const [conversation, dispatch] = useReducer(reduceConversation, {
    ...emptyConversation,
    state: session.state
  })
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const scroll = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // The last message sent, so Escape can hand it back to the composer.
  const lastSent = useRef<string | null>(null)
  // The slash menu's key handler while it is open; the textarea defers to it.
  const slashKeys = useRef<((event: React.KeyboardEvent) => boolean) | null>(null)
  const bindSlashKeys = useCallback(
    (handler: ((event: React.KeyboardEvent) => boolean) | null): void => {
      slashKeys.current = handler
    },
    []
  )
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null)
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
  /* The pane's state is the kernel's record, the same one the sidebar follows:
     the reducer holds the last state_change the session stream carried, and a
     permission_request puts it on blocked exactly as the adapter does. The view
     never re-derives it from its own answers — a request the adapter abandoned,
     or one another consumer of this window answered, would leave this pane
     blocked with live buttons the adapter would refuse (PRDCT-2549). */
  const state = conversation.state
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  useEffect(() => {
    const el = scroll.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
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
    stuck.current = true
    try {
      await write({ type: 'user_message', text })
      lastSent.current = text
      setDraft((current) => (current === text ? '' : current))
    } catch (error) {
      report(error)
    } finally {
      setSending(false)
      textarea.current?.focus()
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
  const renderEntry = (entry: Entry, index: number): React.JSX.Element | null => {
    if (entry.kind === 'user')
      return (
        <div key={index} className="chat-turn-wrap" data-side="end">
          <article className="chat-turn" data-role="user">
            {entry.text.replace(/\s+$/, '')}
          </article>
          <TurnMeta at={entry.at} text={entry.text} />
        </div>
      )
    if (entry.kind === 'assistant')
      return (
        <div key={index} className="chat-turn-wrap" data-side="start">
        <article className="chat-turn chat-prose" data-role="assistant">
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
          <TurnMeta at={entry.at} text={entry.text} />
        </div>
      )
    if (entry.kind === 'tool')
      return (
        <details key={index} className="chat-tool-card" data-complete={entry.complete}>
          <summary>
            <ChevronRightIcon className="chat-tool-chevron" />
            <span className="chat-tool-name">{entry.name ?? 'Tool'}</span>
            <span className="chat-tool-summary">{summarize(entry.input)}</span>
            {entry.complete ? (
              <CheckIcon className="chat-tool-status" aria-label="Complete" />
            ) : (
              <ArrowPathIcon className="chat-tool-status" data-running="true" aria-label="Running" />
            )}
          </summary>
          <div className="chat-card-body">
            <div className="chat-card-label">Input</div>
            <pre>{stringify(entry.input)}</pre>
            {entry.complete && (
              <>
                <div className="chat-card-label">Result</div>
                <pre>{stringify(entry.output)}</pre>
              </>
            )}
          </div>
        </details>
      )
    if (entry.kind === 'permission') {
      const chosen = entry.answer
        ? (entry.request.options.find((option) => option.id === entry.answer)?.label ??
          entry.answer)
        : null
      const elsewhere = !chosen && entry.answeredElsewhere === true
      return (
        <section key={index} className="chat-permission-card" aria-label="Permission request">
          <div className="chat-permission-title">
            <ShieldCheckIcon />
            <span>Permission</span>
            {entry.request.toolName && <span className="badge">{entry.request.toolName}</span>}
          </div>
          <p>{entry.request.description}</p>
          {entry.request.input !== undefined && (
            <details className="chat-permission-input">
              <summary>
                <ChevronRightIcon className="chat-tool-chevron" />
                Input
              </summary>
              <pre>{stringify(entry.request.input)}</pre>
            </details>
          )}
          {chosen ? (
            <p className="chat-permission-answer" role="status">
              <CheckIcon />
              {chosen}
            </p>
          ) : (
            <>
              {elsewhere && (
                <p className="chat-permission-answer" role="status" data-answered="elsewhere">
                  <CheckIcon />
                  No longer awaiting an answer
                </p>
              )}
              <div className="chat-actions">
                {entry.request.options.map((option, i) => (
                  <button
                    key={option.id}
                    className={i === 0 ? 'btn-primary' : 'btn-secondary'}
                    disabled={
                      !ready || pending.includes(entry.request.id) || state === 'ended' || elsewhere
                    }
                    onClick={() => void answer(entry.request.id, option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )
    }
    if (entry.kind === 'error')
      return (
        <div key={index} className="chat-notice" data-tone="error" role="alert">
          {entry.message}
        </div>
      )
    return null
  }
  // Escape while the agent works is the TUI's gesture: stop the turn and hand
  // the message back to the composer to edit and resend, unless something
  // new is already being typed there.
  const takeBack = (): void => {
    void write({ type: 'interrupt' }).catch(report)
    const text = lastSent.current
    if (text) setDraft((current) => (current.trim() ? current : text))
    textarea.current?.focus()
  }
  // A dropped file lands as its path at the caret, the way the TUI pastes it:
  // quoted only when needed, a space after, transient sources persisted first
  // (a macOS screenshot preview is gone before the agent reads it).
  const dropPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    const stable = (
      await Promise.all(paths.map((p) => window.electronAPI.persistDroppedFile(p)))
    ).filter((p): p is string => Boolean(p))
    if (!stable.length) return
    const insert = stable.map(pathForMessage).join(' ') + ' '
    const el = textarea.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    setDraft((current) => current.slice(0, start) + insert + current.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + insert.length, start + insert.length)
    })
  }
  const closed = !ready || state === 'ended'
  const query = closed ? null : slashQuery(draft)
  const slashOpen = query !== null && slashDismissed !== draft
  const pickCommand = useCallback((command: CommandOption): void => {
    setDraft(command.insert)
    setSlashDismissed(command.insert)
    textarea.current?.focus()
  }, [])
  const closeSlash = useCallback((): void => setSlashDismissed(draft), [draft])
  // Empty assistant turns (a closing frame that opened nothing) do not render;
  // consecutive tool calls fold into one tight group.
  const visible = conversation.entries.filter((e) => e.kind !== 'assistant' || e.text.trim())
  const blocks: (Entry | Entry[])[] = []
  for (const entry of visible) {
    const last = blocks.at(-1)
    if (entry.kind === 'tool' && Array.isArray(last)) last.push(entry)
    else if (entry.kind === 'tool') blocks.push([entry])
    else blocks.push(entry)
  }
  const lastVisible = visible.at(-1)
  const showMark = state === 'working' || (!!lastVisible && lastVisible.kind !== 'user')
  return (
    <div
      className="chat-view"
      data-testid="chat-view"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state === 'working') {
          event.preventDefault()
          takeBack()
        }
      }}
    >
      <div
        ref={scroll}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
        }}
      >
        <div className="chat-column" role="log" aria-label="Conversation">
          {conversation.entries.length === 0 && state !== 'ended' && (
            <div className="chat-empty">
              <div className="chat-empty-icon">
                <ChatBubbleLeftRightIcon />
              </div>
              <div>
                <h2>Start a conversation</h2>
                <p>Ask a question or describe what you want to build.</p>
              </div>
            </div>
          )}
          {blocks.map((block, i) =>
            Array.isArray(block) ? (
              <div key={`tools-${i}`} className="chat-tool-group">
                {block.map((entry) => renderEntry(entry, conversation.entries.indexOf(entry)))}
              </div>
            ) : (
              renderEntry(block, conversation.entries.indexOf(block))
            )
          )}
          {showMark && <ProviderMark provider={session.provider} working={state === 'working'} />}
          {state === 'ended' && (
            <div className="chat-notice" role="status">
              Session ended
              {conversation.exitCode !== undefined ? ` (exit ${conversation.exitCode})` : ''}
            </div>
          )}
        </div>
      </div>
      <div className="chat-composer-wrap">
        {slashOpen && (
          <div className="chat-slash-anchor">
            <SlashMenu
              sessionId={session.id}
              query={query}
              onPick={pickCommand}
              onClose={closeSlash}
              bind={bindSlashKeys}
            />
          </div>
        )}
        <form
          className="chat-composer"
          data-dragging={dragging}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void dropPaths(pathsFromDataTransfer(event.dataTransfer))
          }}
        >
          <textarea
            ref={textarea}
            rows={1}
            aria-label="Message"
            placeholder={state === 'ended' ? 'This session has ended' : 'Write a message…'}
            value={draft}
            disabled={closed}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (slashOpen && slashKeys.current?.(event)) {
                event.preventDefault()
                event.stopPropagation()
                return
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          {state === 'working' ? (
            <button
              type="button"
              className="chat-send"
              data-kind="stop"
              aria-label="Interrupt"
              title="Interrupt"
              onClick={() => void write({ type: 'interrupt' }).catch(report)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              aria-label="Send message"
              title="Send (Enter)"
              disabled={closed || sending || !draft.trim()}
            >
              <ArrowUpIcon />
            </button>
          )}
        </form>
        <div className="chat-composer-footer">
          <span>
            {state === 'working'
              ? 'Esc to interrupt and take the message back'
              : 'Enter to send · Shift+Enter for a new line'}
          </span>
          <ModelMenu
            sessionId={session.id}
            model={conversation.model}
            disabled={closed}
            onSelect={(id) => void write({ type: 'set_model', model: id }).catch(report)}
          />
        </div>
      </div>
    </div>
  )
}
