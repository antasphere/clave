import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowUpIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  PaperClipIcon,
  StopIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type {
  Session,
  SessionInput,
  AgentState,
  ModelOption,
  CommandOption
} from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation, type Entry } from './reducer'
import { groupEntries, visibleEntries } from './tools'
import { ToolGroup } from './ToolGroup'
import { PermissionRow, PromptDock } from './PromptDock'
import { ResumePicker } from './ResumePicker'
import { resumeHistoryEntry } from '../../../src/renderer/src/lib/session-history'
import { emitTabClosed } from '../../../src/renderer/src/lib/exchange-capture'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import type { HistoryListEntry } from '../../../src/preload/index.d'
import { ChatCode } from './code'
import { Attachments } from './Attachments'
import { useComposerFocus } from './focus'
import { useTranscriptEnd } from './transcript'
import { JumpToEnd } from './JumpToEnd'
import {
  attachmentIssue,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type Attachment,
  type AttachmentSource
} from '../../../src/shared/attachments'
import { pathsFromDataTransfer, pathForMessage } from '../../../src/renderer/src/lib/dropped-paths'
import { ClaudeLogo, CodexLogo, PiLogo } from '../../../src/renderer/src/components/icons/cli-logos'

export interface ChatViewProps {
  session: Session
  onState: (state: AgentState, model: string | null) => void
}
/** A file on its way into the composer: named at once, a chip once main has
 *  prepared it, an error in its place when main refused it. */
interface Preparation {
  id: string
  name: string
  error?: string
}
/** What a drag carries: files from a file manager or another app, or the
 *  paths Clave's own file and git panels write as text. */
const filesDrag = (dt: DataTransfer): boolean =>
  dt.types.includes('Files') || dt.types.includes('text/uri-list')
const pathsDrag = (dt: DataTransfer): boolean => dt.types.includes('text/plain')
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
/** The provider's mark at the end of the transcript, breathing while the
 *  agent works — from the moment it starts, before any text — and gone the
 *  moment it stops. A finished answer stands on its own; a logo resting under
 *  every reply read as the transcript's own decoration rather than a sign. */
function ProviderMark({ provider }: { provider: string }): React.JSX.Element {
  const Logo =
    provider === 'claude'
      ? ClaudeLogo
      : provider === 'codex'
        ? CodexLogo
        : provider === 'pi'
          ? PiLogo
          : null
  return (
    <div
      className="chat-provider-mark"
      data-provider={provider}
      data-state="working"
      role="status"
      aria-label={`${provider} is working`}
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
    <div
      className="menu-surface menu-pop-mount chat-slash-menu"
      role="listbox"
      aria-label="Commands"
    >
      <div className="menu-label">Commands</div>
      {commands === null && !failure && <div className="chat-model-empty">Loading…</div>}
      {failure && <div className="chat-model-empty">Commands unavailable</div>}
      {commands?.length === 0 && (
        <div className="chat-model-empty">This session offers no commands</div>
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
            {command.description && <span className="chat-slash-hint">{command.description}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
// Only keep the transcript pinned to its end while the reader is already
// there; a reader who scrolled up to re-read is never yanked back down
// (`useTranscriptEnd`).
const STICK_THRESHOLD = 80
const stickSlack = (): number => STICK_THRESHOLD
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }
// The provider reports a full id (claude-opus-5-20260301); the menu lists the
// family (claude-opus-5). Either being a prefix of the other is the same model.
const sameId = (reported: string, id: string): boolean =>
  reported === id || reported.startsWith(id) || id.startsWith(reported)
const sameModel = (reported: string | null, option: ModelOption): boolean =>
  reported === null
    ? option.id === 'default'
    : sameId(reported, option.id) ||
      (option.resolved !== undefined && sameId(reported, option.resolved))
// An alias may stand for the same model as another ("default" and "opus[1m]"):
// the option named exactly wins, then the first whose model it resolves to.
const currentOption = (
  reported: string | null,
  options: ModelOption[] | null
): ModelOption | undefined =>
  options?.find((option) => option.id === reported) ??
  options?.find((option) => sameModel(reported, option))
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
  const current = currentOption(model, options)
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
          <span className="chat-model-trigger-label">{current?.label ?? model ?? 'Default'}</span>
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
            const selected = option === current
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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [preparations, setPreparations] = useState<Preparation[]>([])
  const [imagesSupported, setImagesSupported] = useState(false)
  const [sending, setSending] = useState(false)
  // A files drag over the pane, for the overlay; a paths drag over the composer.
  const [dragging, setDragging] = useState<'files' | 'paths' | null>(null)
  const dragDepth = useRef(0)
  // Preparations the reader removed before main answered; their file is dropped on arrival.
  const withdrawn = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([])
  // The /resume picker, open in the dock above the composer.
  const [resuming, setResuming] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // The last message sent, so Escape can hand it back to the composer.
  const lastSent = useRef<{ text: string; attachments: Attachment[] } | null>(null)
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
    // Whether an attached image can go as image content is the adapter's
    // word; until it arrives the composer assumes not, which only ever asks
    // the reader one more question, never sends a byte the adapter refuses.
    void window.electronAPI
      .sessionsCapabilities(session.id)
      .then((capabilities) => {
        if (live) setImagesSupported(capabilities.images)
      })
      .catch(() => {})
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
  const closed = !ready || state === 'ended'
  useComposerFocus(session.id, !closed, textarea)
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  const transcript = useTranscriptEnd(conversation.entries, stickSlack)
  const write = async (input: SessionInput): Promise<void> => {
    await window.electronAPI.sessionsWrite(session.id, input)
  }
  const report = (error: unknown): void =>
    dispatch({ event: { type: 'error', message: String(error), fatal: false } })
  // /resume is the host's, as in the TUI: it opens the picker rather than
  // reaching the agent, typed whole or taken from the slash menu.
  const canResume = session.provider === 'claude'
  const openResume = (): void => {
    setDraft('')
    setResuming(true)
  }
  // A message can go while files are still being prepared or one still
  // needs the reader's call on how to send it: neither, until they are settled.
  const filesBlocked =
    preparations.length > 0 || attachments.some((file) => attachmentIssue(file, imagesSupported))
  const hasDraft = !!draft.trim() || attachments.length > 0
  const send = async (): Promise<void> => {
    if (!ready || sending || state === 'ended' || !hasDraft || filesBlocked) return
    if (canResume && /^\/resume\s*$/.test(draft.trim())) return openResume()
    const imageBytes = attachments
      .filter((file) => file.delivery === 'image')
      .reduce((sum, file) => sum + file.size, 0)
    if (imageBytes > MAX_TOTAL_IMAGE_BYTES)
      return report('Images in one message must total 20 MiB or less.')
    const text = draft
    const files = attachments
    setSending(true)
    transcript.stick()
    try {
      await write({
        type: 'user_message',
        text,
        ...(files.length ? { attachments: files } : {})
      })
      lastSent.current = { text, attachments: files }
      setDraft((current) => (current === text ? '' : current))
      setAttachments((current) => (current === files ? [] : current))
    } catch (error) {
      report(error)
    } finally {
      setSending(false)
      textarea.current?.focus()
    }
  }
  const answer = async (
    id: string,
    optionId: string,
    answers?: Record<string, string>
  ): Promise<void> => {
    setPending((current) => [...current, id])
    try {
      await write({ type: 'permission_response', id, optionId, ...(answers ? { answers } : {}) })
      dispatch({ answer: id, optionId, answers })
      textarea.current?.focus()
    } catch (error) {
      report(error)
    } finally {
      setPending((current) => current.filter((value) => value !== id))
    }
  }
  const renderEntry = (entry: Entry, index: number): React.JSX.Element | null => {
    if (entry.kind === 'user')
      return (
        <div
          key={index}
          className="chat-turn-wrap"
          data-side="end"
          data-interrupted={entry.interrupted ? 'true' : undefined}
        >
          <Attachments files={entry.attachments ?? []} />
          {entry.text.trim() !== '' && (
            <article
              className="chat-turn"
              data-role="user"
              data-interrupted={entry.interrupted ? 'true' : undefined}
            >
              {entry.text.replace(/\s+$/, '')}
            </article>
          )}
          {entry.interrupted && <span className="chat-turn-note">Interrupted</span>}
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
    if (entry.kind === 'permission') return <PermissionRow key={index} entry={entry} />
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
    const last = lastSent.current
    if (last && !draft.trim() && !attachments.length) {
      setDraft(last.text)
      setAttachments(last.attachments)
    }
    textarea.current?.focus()
  }
  /* Files into the composer, from a drop, a paste or the picker. Each is
     named at once as a chip in preparation, then handed to main to validate,
     copy out of a temp folder if it lives in one, and type; the record main
     returns becomes the attachment. A file the renderer holds only as bytes
     (a pasted screenshot has no path) is sent as bytes and written by main. */
  const addFiles = async (sources: (File | string)[]): Promise<void> => {
    if (closed) return
    const queued: { source: File | string; key: string }[] = []
    let room = MAX_ATTACHMENTS - attachments.length - preparations.length
    for (const source of sources) {
      if (room-- <= 0) {
        report(`Attach up to ${MAX_ATTACHMENTS} files per message.`)
        break
      }
      const name =
        (typeof source === 'string' ? source.split(/[\\/]/).pop() : source.name) || 'Pasted image'
      queued.push({ source, key: crypto.randomUUID() })
      setPreparations((current) => [...current, { id: queued.at(-1)!.key, name }])
    }
    for (const { source, key } of queued) {
      if (withdrawn.current.has(key)) continue
      try {
        let value: AttachmentSource
        if (typeof source === 'string') value = { path: source }
        else {
          const path = window.electronAPI.getPathForFile(source)
          if (path) value = { path }
          else {
            if (source.size > MAX_IMAGE_BYTES)
              throw new Error('Pasted images must be 5 MiB or smaller.')
            value = {
              name: source.name || 'Pasted image.png',
              bytes: new Uint8Array(await source.arrayBuffer())
            }
          }
        }
        const file = await window.electronAPI.sessionsFiles.prepare(session.id, value)
        if (withdrawn.current.has(key)) continue
        setAttachments((current) =>
          current.some((f) => f.path === file.path) ? current : [...current, file]
        )
        setPreparations((current) => current.filter((p) => p.id !== key))
      } catch (failure) {
        if (withdrawn.current.has(key)) continue
        setPreparations((current) =>
          current.map((p) => (p.id === key ? { ...p, error: String(failure) } : p))
        )
      }
    }
    for (const { key } of queued) withdrawn.current.delete(key)
    textarea.current?.focus({ preventScroll: true })
  }
  const withdraw = (key: string): void => {
    withdrawn.current.add(key)
    setPreparations((current) => current.filter((p) => p.id !== key))
  }
  /* A drop on the pane. Files and file URLs become attachments; the paths
     Clave's own file and git panels drag as text land at the caret, the way
     the TUI pastes them (quoted only when needed, a space after), because a
     dragged folder is a path to talk about, not a file to attach. */
  const drop = (dt: DataTransfer): void => {
    if (filesDrag(dt)) {
      const files = Array.from(dt.files)
      void addFiles(files.length ? files : pathsFromDataTransfer(dt))
    } else if (pathsDrag(dt)) void dropPaths(pathsFromDataTransfer(dt))
  }
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
  // What the agent waits on, oldest first: the dock shows the head of it.
  const waitingOn = conversation.entries.flatMap((e) =>
    e.kind === 'permission' && !e.answer && !e.answeredElsewhere ? [e.request] : []
  )
  const query = closed ? null : slashQuery(draft)
  const slashOpen = query !== null && slashDismissed !== draft
  const pickCommand = useCallback(
    (command: CommandOption): void => {
      if (canResume && command.name === 'resume') {
        setSlashDismissed('')
        setDraft('')
        setResuming(true)
        return
      }
      setDraft(command.insert)
      setSlashDismissed(command.insert)
      textarea.current?.focus()
    },
    [canResume]
  )
  /* A picked conversation opens as a chat tab of its own, on this tab's launch
     profile and beside it; a tab that has said nothing yet gives its place to
     it (closed the way the header's Close does), so a /resume in a fresh tab
     reads as resuming right here. */
  const resumeConversation = async (entry: HistoryListEntry): Promise<void> => {
    const store = useViewSessionStore.getState()
    const me = store.sessions.find((s) => s.id === session.id)
    const group = store.groups.find((g) => g.sessionIds.includes(session.id))
    const opened = await resumeHistoryEntry(entry, {
      groupId: group?.id ?? null,
      dangerousMode: me?.dangerousMode ?? false,
      launchProfileId: me?.launchProfileId
    })
    setResuming(false)
    if (!opened) return report('Could not resume that conversation')
    if (opened === session.id || conversation.entries.length > 0) return
    const current = useViewSessionStore.getState()
    const closing = current.sessions.find((s) => s.id === session.id)
    if (closing) emitTabClosed(closing, current.groups, 'user', null)
    await window.electronAPI.killSession(session.id).catch(() => {})
    useViewSessionStore.getState().removeSession(session.id)
  }
  const closeSlash = useCallback((): void => setSlashDismissed(draft), [draft])
  // Empty assistant turns (a closing frame that opened nothing) do not render;
  // consecutive tool calls fold into one row. Both views filter and group
  // through the same two functions, so a run breaks in the same place in each.
  const visible = visibleEntries(conversation.entries)
  const blocks = groupEntries(visible)
  // The mark is the agent at work, nothing else: it leaves with the state.
  const showMark = state === 'working'
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
      onDragEnter={(event) => {
        if (closed || !(filesDrag(event.dataTransfer) || pathsDrag(event.dataTransfer))) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(filesDrag(event.dataTransfer) ? 'files' : 'paths')
      }}
      onDragOver={(event) => {
        if (!(filesDrag(event.dataTransfer) || pathsDrag(event.dataTransfer))) return
        event.preventDefault()
        event.dataTransfer.dropEffect = closed ? 'none' : 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        dragDepth.current = 0
        setDragging(null)
        if (!closed) drop(event.dataTransfer)
      }}
    >
      {dragging === 'files' && (
        <div className="chat-drop-overlay" role="status">
          <PaperClipIcon />
          <strong>Add files to the message</strong>
          <span>They stay in the composer to review before you send.</span>
        </div>
      )}
      <div className="chat-transcript">
        <div ref={transcript.scroll} className="chat-scroll">
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
            {/* The index is the block's own, not a lookup: indexOf inside a map is
              quadratic, and a long transcript pays it on every stream event. */}
            {blocks.map((block, index) =>
              block.kind === 'tool-group' ? (
                <ToolGroup key={`tools-${block.id}`} group={block} />
              ) : (
                renderEntry(block, index)
              )
            )}
            {showMark && <ProviderMark provider={session.provider} />}
            {state === 'ended' && (
              <div className="chat-notice" role="status">
                Session ended
                {conversation.exitCode !== undefined ? ` (exit ${conversation.exitCode})` : ''}
              </div>
            )}
          </div>
        </div>
        {transcript.away && <JumpToEnd onClick={transcript.jump} />}
      </div>
      <div className="chat-composer-wrap">
        {resuming && (
          <ResumePicker
            cwd={session.cwd}
            exclude={
              useViewSessionStore.getState().sessions.find((s) => s.id === session.id)
                ?.claudeSessionId ?? null
            }
            onPick={(entry) => void resumeConversation(entry)}
            onClose={() => {
              setResuming(false)
              textarea.current?.focus()
            }}
          />
        )}
        <PromptDock
          requests={resuming ? [] : waitingOn}
          agent={AGENT_NAMES[session.provider] ?? 'the agent'}
          busy={(id) => !ready || state === 'ended' || pending.includes(id)}
          onAnswer={(id, optionId, answers) => void answer(id, optionId, answers)}
        />
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
          data-dragging={dragging === 'paths' ? 'true' : undefined}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          {(attachments.length > 0 || preparations.length > 0) && (
            <div className="chat-composer-files">
              <Attachments
                files={attachments}
                imagesSupported={imagesSupported}
                onChange={setAttachments}
              />
              {preparations.length > 0 && (
                <ul className="chat-attachments" aria-label="Preparing files">
                  {preparations.map((item) => (
                    <li
                      key={item.id}
                      className="chat-attachment"
                      data-issue={item.error ? 'true' : undefined}
                    >
                      <span className="chat-attachment-text" role={item.error ? 'alert' : 'status'}>
                        <span className="chat-attachment-name">{item.name}</span>
                        <span className="chat-attachment-hint">{item.error ?? 'Preparing…'}</span>
                      </span>
                      <button
                        type="button"
                        className="chat-turn-copy"
                        aria-label={`Remove ${item.name}`}
                        title="Remove"
                        onClick={() => withdraw(item.id)}
                      >
                        <XMarkIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <textarea
            ref={textarea}
            rows={1}
            aria-label="Message"
            placeholder={state === 'ended' ? 'This session has ended' : 'Write a message…'}
            value={draft}
            disabled={closed}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              // A pasted screenshot is a file on the clipboard; text pastes as text.
              const files = Array.from(event.clipboardData.files)
              if (!files.length) return
              event.preventDefault()
              void addFiles(files)
            }}
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
              disabled={closed || sending || !hasDraft || filesBlocked}
            >
              <ArrowUpIcon />
            </button>
          )}
        </form>
        <div className="chat-composer-footer">
          <span className="chat-composer-hint">
            <button
              type="button"
              className="chat-composer-tool"
              aria-label="Add files"
              title="Add files"
              disabled={closed}
              onClick={() =>
                void window.electronAPI.sessionsFiles
                  .pick()
                  .then((paths) => addFiles(paths))
                  .catch(report)
              }
            >
              <PaperClipIcon />
            </button>
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
