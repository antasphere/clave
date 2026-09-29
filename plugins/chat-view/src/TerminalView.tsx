/** The Terminal view: a third reading of a session, started as a copy of
 *  `ChatView` and diverging from it on purpose. Shares its props with Chat. */
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUpIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  MapPinIcon,
  PaperClipIcon,
  StopIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type {
  PermissionModeOption,
  SessionEvent,
  SessionInput,
  CommandOption
} from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation, type Entry } from './reducer'
import { PermissionModeMenu } from './PermissionModeMenu'
import { ModelMenu } from './ModelMenu'
import { SenderChip } from './Delivery'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { claudeContextWindow } from '../../../src/shared/claude-models'
import { nextPermissionMode } from './permission-mode'
import { emptyStatus, reduceStatus, relaunchRequest, type TerminalStatus } from './terminal-status'
import { ContextMeter, SubAgentStack } from './TerminalStatus'
import { useQuestionHeight } from './question-height'
import { groupEntries, visibleEntries, type ToolGroup as ToolRun } from './tools'
import { TerminalTools } from './TerminalTools'
import { ToolDisclosure } from './disclosure'
import { PermissionRow, PromptDock } from './PromptDock'
import { continueList } from './lists'
import { ResumePicker } from './ResumePicker'
import { resumeHistoryEntry } from '../../../src/renderer/src/lib/session-history'
import { emitTabClosed } from '../../../src/renderer/src/lib/exchange-capture'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import { endIsCurrent } from '../../../src/renderer/src/views/session-end'
import { acceptAccountProposal } from '../../../src/renderer/src/lib/account-policy'
import type { HistoryListEntry } from '../../../src/preload/index.d'
import { ChatCode } from './code'
import { Attachments } from './Attachments'
import { useComposerFocus } from './focus'
import { useMessageHistory } from './history'
import { useTranscriptEnd } from './transcript'
import { TranscriptRows } from './rows'
import { JumpToEnd } from './JumpToEnd'
import { useEarlier, type EarlierPage } from './earlier'
import { EarlierLoading } from './EarlierLoading'
import {
  attachmentIssue,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type Attachment,
  type AttachmentSource
} from '../../../src/shared/attachments'
import { pathsFromDataTransfer, pathForMessage } from '../../../src/renderer/src/lib/dropped-paths'
import { openLink, wantsExternal } from '../../../src/renderer/src/lib/open-link'
import { ClaudeLogo, CodexLogo, PiLogo } from '../../../src/renderer/src/components/icons/cli-logos'
import type { ChatViewProps } from './ChatView'

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
        data-copied={copied ? 'true' : undefined}
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
/** One turn of the transcript. Memoised on the entry itself, which the
 *  reducer replaces only when that entry changes: a streamed delta re-renders
 *  the answer it grows and nothing above it, and a keystroke in the composer
 *  re-renders no turn at all. A long conversation used to re-parse the
 *  markdown of every answer it held on each of those. */
const EntryRow = memo(function EntryRow({
  entry,
  onError
}: {
  entry: Entry
  onError: (error: unknown) => void
}): React.JSX.Element | null {
  if (entry.kind === 'user') {
    // A message another tab sent: its sender in a chip, its words without
    // the bracketed header, in the delivery's own tint.
    const delivery = parseDelivery(entry.text)
    const text = delivery ? delivery.body : entry.text
    return (
      <div
        className="chat-turn-wrap"
        data-side="end"
        data-interrupted={entry.interrupted ? 'true' : undefined}
      >
        <Attachments files={entry.attachments ?? []} />
        {text.trim() !== '' && (
          // The message is capped in height and scrolls inside past it; the
          // grip on its bottom edge moves the cap (question-height.ts).
          <div className="term-question">
            <article
              className="chat-turn"
              data-role="user"
              data-from={delivery ? 'tab' : undefined}
              data-interrupted={entry.interrupted ? 'true' : undefined}
            >
              {delivery && <SenderChip sender={delivery.sender} />}
              {text.replace(/\s+$/, '')}
            </article>
            <div
              className="term-question-grip"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize long messages"
              title="Drag to show more or less of long messages · double-click to reset"
            />
          </div>
        )}
        {entry.interrupted && <span className="chat-turn-note">Interrupted</span>}
        <TurnMeta at={entry.at} text={text} />
      </div>
    )
  }
  if (entry.kind === 'assistant')
    return (
      <div className="chat-turn-wrap" data-side="start">
        <article className="chat-turn chat-prose" data-role="assistant">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ChatCode,
              table: ({ children }) => (
                <div className="chat-table-scroll">
                  <table>{children}</table>
                </div>
              ),
              a: ({ href, children }) =>
                href && /^(https?:|mailto:)/i.test(href) ? (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault()
                      void openLink(href, { external: wantsExternal(event) }).catch(onError)
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
  if (entry.kind === 'permission') return <PermissionRow entry={entry} />
  if (entry.kind === 'error')
    return (
      <div className="chat-notice" data-tone="error" role="alert">
        {entry.message}
      </div>
    )
  return null
})
/** A run of tools, re-rendered only when one of its calls changed or it
 *  stops or starts being the run in flight: the run is rebuilt by
 *  `groupEntries` on every render, its calls are not. */
const ToolRow = memo(
  TerminalTools,
  (a: { group: ToolRun; live: boolean }, b: { group: ToolRun; live: boolean }) =>
    a.live === b.live &&
    a.group.id === b.group.id &&
    a.group.tools.length === b.group.tools.length &&
    a.group.tools.every((tool, i) => tool === b.group.tools[i])
)
/** The Terminal view's names for the permission modes where they differ
 *  from the provider's: bypass is YOLO here, short and unmistakable. */
const terminalModeLabel = (option: PermissionModeOption): string =>
  option.id === 'bypassPermissions' ? 'YOLO' : option.label
/** Where the reader's choice to pin questions is kept, across sessions. */
const PIN_KEY = 'clave-terminal-pin-questions'
/** What a click lands on when it means something other than "type here". */
const INTERACTIVE =
  'a, button, input, textarea, select, summary, label, [role="button"], [role="menuitem"], [role="menu"], [role="dialog"], [role="separator"], [contenteditable="true"]'
type TurnRows = { key: string; block: Entry | ToolRun }[]
/** One exchange as the virtualiser mounts it: the section stays whole inside
 *  its row, so the pinned question stays sticky within its own exchange. An
 *  exchange the column gained at its end arrives (`TranscriptRows`), and so
 *  does every block that joins it while it stays mounted. */
function TerminalTurn({
  rows,
  first,
  arriving,
  liveRun,
  onError
}: {
  rows: TurnRows
  first: boolean
  arriving: boolean
  /** The key of the run in flight, if it is in this exchange (`TerminalTools`). */
  liveRun: string | undefined
  onError: (error: unknown) => void
}): React.JSX.Element {
  const [arrive] = useState(arriving)
  return (
    <div
      className="chat-row"
      data-first={first ? 'true' : undefined}
      data-arrive={arrive ? 'true' : undefined}
    >
      <section className="term-turn">
        {rows.map(({ block, key }) =>
          block.kind === 'tool-group' ? (
            <ToolRow key={key} group={block} live={key === liveRun} />
          ) : (
            <EntryRow key={key} entry={block} onError={onError} />
          )
        )}
      </section>
    </div>
  )
}
export function TerminalView({ session, onState }: ChatViewProps): React.JSX.Element {
  const [conversation, dispatch] = useReducer(reduceConversation, {
    ...emptyConversation,
    state: session.state
  })
  // The status line's own reading of the same stream: context and subagents.
  const [status, dispatchStatus] = useReducer(
    (current: TerminalStatus, event: SessionEvent) => reduceStatus(current, event),
    emptyStatus
  )
  const [ready, setReady] = useState(false)
  // A resumed conversation's past lives in main and arrives a page at a time,
  // the newest first: `before` is what to ask for next, null once nothing is
  // older; `pastRead` holds the empty state back until the first answer, so a
  // long conversation never flashes "Start a conversation" on its way in.
  const [before, setBefore] = useState<number | null>(null)
  const [pastRead, setPastRead] = useState(false)
  // The draft is the host's, per session, so it survives this view being
  // unmounted and mounted again (PRDCT-2620); the attachments stay here.
  const { draft, setDraft, recall } = useMessageHistory(session.id, conversation.entries)
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
    // An end is taken only once the record confirms it: after a move to
    // another account the old process's end can arrive after this pane has
    // remounted on the new one, and closed it over a live agent.
    const confirmed = (then: () => void): void =>
      void endIsCurrent(session.id)
        .then((current) => {
          if (current && live) then()
        })
        .catch(console.error)
    const stop = window.electronAPI.onSessionStream(session.id, (value) => {
      if (value.kind !== 'event') return
      const event = value.event
      const take = (): void => {
        dispatch({ event })
        dispatchStatus(event)
      }
      if (event.type === 'state_change' && event.state === 'ended') confirmed(take)
      else take()
    })
    const stopExit = window.electronAPI.onSessionStreamExit(session.id, (code) =>
      confirmed(() => dispatch({ exit: code }))
    )
    void window.electronAPI
      .sessionsSubscribe(session.id)
      .then(() => {
        if (live) setReady(true)
        // Asked once subscribed, when the adapter has read the transcript;
        // whatever streamed meanwhile is newer and stays after it. A host
        // without the call rejects inside the chain and shows no past.
        return Promise.resolve()
          .then(() => window.electronAPI.sessionsHistory(session.id))
          .then((page) => {
            if (!live) return
            dispatch({ prepend: page.items })
            setBefore(page.before)
            // The newest page holds the context as the conversation left it.
            const usage = page.items.findLast((item) => item.event.type === 'context_usage')
            if (usage) dispatchStatus(usage.event)
          })
          .catch(() => {})
          .finally(() => {
            if (live) setPastRead(true)
          })
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
  const fetchEarlier = useCallback<EarlierPage>(async () => {
    if (before === null) return null
    const page = await window.electronAPI.sessionsHistory(session.id, before)
    return () => {
      dispatch({ prepend: page.items })
      setBefore(page.before)
    }
  }, [session.id, before])
  const earlier = useEarlier(transcript, before !== null, fetchEarlier, conversation.entries)
  const write = async (input: SessionInput): Promise<void> => {
    await window.electronAPI.sessionsWrite(session.id, input)
  }
  const report = useCallback(
    (error: unknown): void =>
      dispatch({ event: { type: 'error', message: String(error), fatal: false } }),
    []
  )
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
    [canResume, setDraft]
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
  // Keyed by each entry's ordinal (`Conversation.first`), never by position:
  // a page of the past arriving in front must not shift a key, or every turn
  // below it would render as another and the column's arrival would replay on
  // the ones at the end. Memoised, so a keystroke rebuilds none of it.
  const blocks = useMemo(() => {
    const ordinal = new Map<Entry, number>()
    conversation.entries.forEach((entry, i) => ordinal.set(entry, conversation.first + i))
    return groupEntries(visibleEntries(conversation.entries)).map((block) => ({
      block,
      key: block.kind === 'tool-group' ? `tools-${block.id}` : `entry-${ordinal.get(block)}`
    }))
  }, [conversation.entries, conversation.first])
  // One section per exchange: the reader's message and everything answering
  // it, so a pinned question is carried off by its own section's end.
  const turns = useMemo(() => {
    const out: { key: string; rows: typeof blocks }[] = []
    for (const row of blocks) {
      if (row.block.kind === 'user' || !out.length) out.push({ key: row.key, rows: [] })
      out[out.length - 1].rows.push(row)
    }
    return out
  }, [blocks])
  // The reader's open tool rows, kept across the rows' unmounts (`ToolDisclosure`).
  const [disclosure] = useState(() => new Map<string, boolean>())
  const [pinQuestions, setPinQuestions] = useState(() => localStorage.getItem(PIN_KEY) !== 'off')
  const togglePin = (): void =>
    setPinQuestions((value) => {
      localStorage.setItem(PIN_KEY, value ? 'off' : 'on')
      return !value
    })
  useQuestionHeight(transcript.scroll)
  // The mark is the agent at work, nothing else: it leaves with the state.
  const showMark = state === 'working'
  // The run in flight: the last one, while the turn it belongs to still runs
  // (a permission it waits on included). Every other run is finished, result
  // or not.
  const liveRun =
    state === 'working' || state === 'blocked'
      ? blocks.findLast(({ block }) => block.kind === 'tool-group' || block.kind === 'user')?.key
      : undefined
  return (
    <div
      className="chat-view terminal-view"
      data-testid="terminal-view"
      data-pin={pinQuestions || undefined}
      onClick={(event) => {
        // A click on nothing in particular goes to the prompt; one on anything
        // that does something, or one that ends a text selection, does not.
        if (closed || window.getSelection()?.toString()) return
        // Nor one in the question dock: its keys (1-9, Enter, Esc) are the
        // dock's while it is up, and a click on its words must not hand them
        // to the prompt.
        if ((event.target as Element).closest(`${INTERACTIVE}, .chat-prompt`)) return
        textarea.current?.focus()
      }}
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
            {pastRead && conversation.entries.length === 0 && state !== 'ended' && (
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
            {/* Mounted from the start, empty or not: what it gains is told apart
                from what it opened on by the rows it rendered before. */}
            <ToolDisclosure.Provider value={disclosure}>
              <TranscriptRows
                rows={turns}
                settled={pastRead}
                scroll={transcript.scroll}
                holdAbove={pinQuestions}
              >
                {(turn, index, arriving) => (
                  <TerminalTurn
                    key={turn.key}
                    rows={turn.rows}
                    first={index === 0}
                    arriving={arriving}
                    liveRun={liveRun}
                    onError={report}
                  />
                )}
              </TranscriptRows>
            </ToolDisclosure.Provider>
            {showMark && <ProviderMark provider={session.provider} />}
            {state === 'ended' && (
              <EndedNotice sessionId={session.id} exitCode={conversation.exitCode} />
            )}
          </div>
        </div>
        {earlier.loading && <EarlierLoading />}
        {transcript.away && <JumpToEnd onClick={transcript.jump} />}
      </div>
      <div className="chat-composer-wrap term-composer-wrap">
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
        {(attachments.length > 0 || preparations.length > 0) && (
          <div className="chat-composer-files term-files">
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
        <form
          className="term-prompt"
          data-dragging={dragging === 'paths' ? 'true' : undefined}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <span className="term-caret" aria-hidden="true">
            ❯
          </span>
          <textarea
            ref={textarea}
            rows={1}
            aria-label="Message"
            placeholder={
              state === 'ended' ? 'This session has ended' : 'Try "fix typecheck errors"'
            }
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
              const recalled = recall(event)
              if (recalled !== null) {
                setSlashDismissed(recalled)
                return
              }
              // Shift+Tab cycles the permission mode, as it does in the TUI.
              if (event.key === 'Tab' && event.shiftKey && conversation.permissionMode) {
                event.preventDefault()
                const next = nextPermissionMode(
                  conversation.permissionMode.mode,
                  conversation.permissionMode.modes
                )
                if (next) void write({ type: 'set_permission_mode', mode: next }).catch(report)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              } else if (
                event.key === 'Enter' &&
                event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                // A new line inside a list item carries the list on.
                const el = event.currentTarget
                const next = continueList(el.value, el.selectionStart, el.selectionEnd)
                if (!next) return
                event.preventDefault()
                // The DOM first, caret included, so the next keystroke lands
                // in the right place even before React has re-rendered; the
                // draft then matches the field and React leaves it alone.
                el.value = next.text
                el.setSelectionRange(next.caret, next.caret)
                setDraft(next.text)
              }
            }}
          />
          {/* One button that turns from send to stop and back, never two
              swapped: the same element keeps its place and its transitions,
              so the change of kind is a crossfade, not a pop. Both glyphs are
              in it; the stylesheet shows the one the kind calls for. */}
          <button
            type={state === 'working' ? 'button' : 'submit'}
            className="chat-send"
            data-kind={state === 'working' ? 'stop' : 'send'}
            aria-label={state === 'working' ? 'Interrupt' : 'Send message'}
            title={state === 'working' ? 'Interrupt' : 'Send (Enter)'}
            disabled={state !== 'working' && (closed || sending || !hasDraft || filesBlocked)}
            onClick={
              state === 'working'
                ? () => void write({ type: 'interrupt' }).catch(report)
                : undefined
            }
          >
            <ArrowUpIcon data-glyph="send" />
            <StopIcon data-glyph="stop" />
          </button>
        </form>
        <div className="term-status">
          <span className="term-cwd" title={session.cwd}>
            {session.cwd.split('/').filter(Boolean).pop() ?? session.cwd}
          </span>
          <span className="term-model">
            <ModelMenu
              sessionId={session.id}
              model={conversation.model}
              disabled={closed}
              onSelect={(id) => void write({ type: 'set_model', model: id }).catch(report)}
            />
          </span>
          {conversation.permissionMode && (
            <span className="term-mode" data-mode={conversation.permissionMode.mode}>
              <PermissionModeMenu
                mode={conversation.permissionMode.mode}
                modes={conversation.permissionMode.modes}
                disabled={closed}
                label={terminalModeLabel}
                onSelect={(id) =>
                  void write({ type: 'set_permission_mode', mode: id }).catch(report)
                }
              />
            </span>
          )}
          <ContextMeter
            used={status.contextUsed}
            window={
              status.contextWindow ??
              // The window is named by a turn's result; until one has come,
              // the model says it (a resumed conversation's replay never does).
              claudeContextWindow(conversation.model)
            }
          />
          {status.agents.length > 0 && (
            <span className="term-dim">
              · {status.agents.length} agent{status.agents.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="term-status-end">
            <button
              type="button"
              className="chat-composer-tool"
              aria-label="Pin the question while its answer scrolls"
              aria-pressed={pinQuestions}
              title={pinQuestions ? 'Questions pinned while their answer scrolls' : 'Pin questions'}
              data-active={pinQuestions || undefined}
              onClick={() => togglePin()}
            >
              <MapPinIcon />
            </button>
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
          </span>
        </div>
        <SubAgentStack
          agents={status.agents}
          onRelaunch={(agent, alias) => {
            if (!agent.taskId) return
            // Stopped first, then asked for again: the conversation made the
            // agent, and it alone holds the prompt it was given.
            void write({ type: 'stop_task', taskId: agent.taskId })
              .then(() =>
                write({
                  type: 'user_message',
                  text: relaunchRequest(agent, alias)
                })
              )
              .catch(report)
          }}
        />
      </div>
    </div>
  )
}

/**
 * Why the conversation stopped, and the way on. The CLI ends its process
 * right after an "out of credits" reply (ADR 0002): that end is the account's,
 * not the session's, so the notice names the account and the move — made
 * already in automatic mode, one click away in propose mode, or nowhere to
 * go — and never reads as a crash. Any other end is the plain exit.
 */
function EndedNotice({
  sessionId,
  exitCode
}: {
  sessionId: string
  exitCode?: number
}): React.JSX.Element {
  const host = useViewSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const limit = host?.limitReported === true
  const proposal = host?.accountProposal ?? null
  const account = host?.claudeProfileLabel ?? host?.codexAccountLabel ?? 'This account'
  if (host?.restarting) {
    return (
      <div className="chat-notice" role="status" data-chat-ended="moving">
        {proposal ? `Moving to ${proposal.label}…` : 'Moving to another account…'}
      </div>
    )
  }
  if (limit && proposal) {
    return (
      <div className="chat-notice" role="status" data-chat-ended="limit">
        {account} is out of usage credits.{' '}
        <button
          type="button"
          className="chat-notice-action"
          onClick={() => void acceptAccountProposal(sessionId)}
          data-chat-continue-on={proposal.accountId}
        >
          Continue on {proposal.label}
        </button>
      </div>
    )
  }
  if (limit) {
    return (
      <div className="chat-notice" role="status" data-chat-ended="limit">
        {account} is out of usage credits, and no other account has headroom. Add one in Settings →
        Accounts to continue.
      </div>
    )
  }
  return (
    <div className="chat-notice" role="status" data-chat-ended="exit">
      Session ended
      {exitCode !== undefined ? ` (exit ${exitCode})` : ''}
    </div>
  )
}
