import './folio.css'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ListBulletIcon,
  PaperClipIcon,
  SpeakerWaveIcon,
  StopIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type { SessionInput } from '../../../../src/shared/session-model'
import { publicQuestionAnswers } from '../../../../src/renderer/src/lib/question-identity'
import { useFleetStore } from '../../../../src/renderer/src/store/fleet-store'
import { parseResourceKey } from '@clave/contract/fleet'
import {
  canOpenRemotePage,
  isRemoteKey,
  ownerOf
} from '../../../../src/renderer/src/lib/fleet-identity'
import {
  failureText,
  pathForMessage,
  pathsFromDataTransfer
} from '../../../../src/renderer/src/lib/dropped-paths'
import { openLink, wantsExternal } from '../../../../src/renderer/src/lib/open-link'
import { claudeContextWindow } from '../../../../src/shared/claude-models'
import {
  attachmentIssue,
  MAX_TOTAL_IMAGE_BYTES,
  type Attachment
} from '../../../../src/shared/attachments'
import { EndedNotice, type ChatViewProps } from '../ChatView'
import { answeredSince, openRequests, type Entry } from '../reducer'
import { createEntryMarkdownPlugins } from '../markdown-append'
import { ChatCode } from '../code'
import { describeToolHead, runTitle, toolHint, toolVerb, type ToolEntry } from '../tools'
import { KIND_ICONS } from '../tool-icons'
import { ToolPanel } from '../ToolGroup'
import { PermissionRow, PromptDock } from '../PromptDock'
import { refusedAnswer } from '../refused-answer'
import { serverDock, withServerPending } from '../server-requests'
import { SenderChip } from '../Delivery'
import { Attachments } from '../Attachments'
import { useComposerAttachments } from '../composer-attachments'
import { useComposerFocus } from '../focus'
import { useMessageHistory } from '../history'
import { usePresentation } from '../presentation'
import { continueList } from '../lists'
import { nextPermissionMode } from '../permission-mode'
import { PermissionModeMenu } from '../PermissionModeMenu'
import { ModelMenu } from '../ModelMenu'
import { EffortMenu } from '../EffortMenu'
import { ContextMeter } from '../TerminalStatus'
import { WorkCards } from '../WorkCards'
import { relaunchRequest, shownWork } from '../terminal-status'
import { DropDrawing } from '../DropDrawing'
import { PastFailed } from '../EarlierLoading'
import { pastHead } from '../past'
import { FolioDrawing } from './FolioDrawing'
import {
  buildPages,
  currentPage,
  STATUS_WORDS,
  turnPage,
  type Note,
  type Page,
  type PageRow
} from './pages'
import { useAutoRead, useReadAloud, type Reading } from './read-aloud'
import { useConversation } from './use-conversation'
import { LAB_VIEW } from './meta'

/* Folio: the conversation as a book of pages, one per question. The reader's
   message is the page's title, the agent's answer is written on it as a
   document, and what the agent did on the way sits in the margin beside the
   paragraph it led to. The spine at the top is the book's index, one tick per
   page, its height the length of the answer; the reader turns pages with it,
   with the arrows, or from the contents. The page being written is followed
   until the reader turns away from it. A finished page can be read aloud. */

const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }
const NOTES_SHOWN = 4

const filesDrag = (dt: DataTransfer): boolean =>
  dt.types.includes('Files') ||
  dt.types.includes('text/uri-list') ||
  dt.types.includes('application/x-clave-files')
const pathsDrag = (dt: DataTransfer): boolean => dt.types.includes('text/plain')
const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

function clock(at: number): string {
  const then = new Date(at)
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return then.toDateString() === new Date().toDateString()
    ? time
    : `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** The answer's prose, memoised on its entry: a streamed delta re-renders the
 *  paragraph it grows and nothing else on the page. */
const Prose = memo(function Prose({
  entry,
  onError
}: {
  entry: Extract<Entry, { kind: 'assistant' }>
  onError: (error: unknown) => void
}): React.JSX.Element {
  const streaming = !entry.final
  const remarkPlugins = useMemo(() => createEntryMarkdownPlugins(streaming), [streaming])
  const components = useMemo<Components>(
    () => ({
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
    }),
    [onError]
  )
  return (
    <div className="chat-prose folio-prose" data-streaming={streaming ? 'true' : undefined}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {entry.text}
      </ReactMarkdown>
    </div>
  )
})

/** One call in the margin: its glyph, its verb and what it acted on. A click
 *  opens what it did, under the line, across the page. */
function ToolNote({
  tool,
  open,
  onToggle
}: {
  tool: ToolEntry
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { kind, label, target } = describeToolHead(tool)
  const Icon = KIND_ICONS[kind]
  const state = !tool.complete ? 'running' : tool.failed ? 'failed' : 'complete'
  return (
    <button
      type="button"
      className="folio-note"
      data-state={state}
      aria-expanded={open}
      title={`${toolHint(tool)}${target ? ` · ${target.split('\n')[0]}` : ''}`}
      onClick={onToggle}
    >
      <Icon className="folio-note-icon" aria-hidden="true" />
      <span className="folio-note-verb">{toolVerb(kind, label)}</span>
      {target && <span className="folio-note-target">{target.split('\n')[0]}</span>}
      {state === 'failed' && <span className="folio-note-flag">failed</span>}
    </button>
  )
}

/** A line of the page: what was written, and in its margin what was done
 *  before it. */
function Line({
  row,
  pen,
  onError
}: {
  row: PageRow
  pen: boolean
  onError: (error: unknown) => void
}): React.JSX.Element {
  const [opened, setOpened] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const tools = row.notes.filter((n): n is ToolEntry => n.kind === 'tool')
  const shown: Note[] =
    all || row.notes.length <= NOTES_SHOWN + 1 ? row.notes : row.notes.slice(-NOTES_SHOWN)
  const hidden = row.notes.length - shown.length
  const open = tools.find((t) => t.id === opened)
  return (
    <div className="folio-line" data-notes={row.notes.length > 0 ? 'true' : undefined}>
      <div className="folio-text">
        {row.prose && <Prose entry={row.prose} onError={onError} />}
        {row.error && (
          <div className="chat-notice" data-tone="error" role="alert">
            {row.error.message}
          </div>
        )}
        {pen && <span className="folio-pen" role="status" aria-label="The agent is writing" />}
      </div>
      {row.notes.length > 0 && (
        <aside className="folio-margin" aria-label="What the agent did">
          {tools.length > NOTES_SHOWN && <p className="folio-margin-head">{runTitle(tools)}</p>}
          {hidden > 0 && (
            <button type="button" className="folio-margin-more" onClick={() => setAll(true)}>
              {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </button>
          )}
          {shown.map((note) =>
            note.kind === 'tool' ? (
              <ToolNote
                key={note.id}
                tool={note}
                open={opened === note.id}
                onToggle={() => setOpened((now) => (now === note.id ? null : note.id))}
              />
            ) : (
              <div key={note.request.id} className="folio-note-permission">
                <PermissionRow entry={note} />
              </div>
            )
          )}
        </aside>
      )}
      {open && (
        <div className="folio-opened">
          <ToolPanel tool={open} />
        </div>
      )}
    </div>
  )
}

/** The question at the head of a page: who asked when it was another tab, the
 *  title, and the whole message under it when it says more than the title. */
function PageHead({ page, of }: { page: Page; of: number }): React.JSX.Element {
  const [whole, setWhole] = useState(false)
  const files = page.question.flatMap((q) => q.attachments ?? [])
  const status = STATUS_WORDS[page.status]
  return (
    <header className="folio-head">
      <p className="folio-eyebrow">
        <span>
          Page {page.number} of {of}
        </span>
        <span title={new Date(page.at).toLocaleString()}>{clock(page.at)}</span>
        {status && (
          <span className="folio-status" data-status={page.status}>
            {status}
          </span>
        )}
      </p>
      {page.from !== undefined && <SenderChip sender={page.from} />}
      <h2 className="folio-title">{page.title}</h2>
      {page.brief && (
        <div className="folio-brief" data-whole={whole ? 'true' : undefined}>
          <p>{page.brief}</p>
          {page.brief.length > 280 && (
            <button type="button" className="folio-link" onClick={() => setWhole((w) => !w)}>
              {whole ? 'Show less' : 'Show the whole message'}
            </button>
          )}
        </div>
      )}
      <Attachments files={files} />
    </header>
  )
}

function CopyAnswer({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="folio-action"
      data-copied={copied ? 'true' : undefined}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <ClipboardDocumentIcon aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy the answer'}
    </button>
  )
}

/** The page on screen. Keyed by its page by the caller, so turning to another
 *  plays the turn once; growing in place plays nothing. */
function PageView({
  page,
  of,
  direction,
  voice,
  onError
}: {
  page: Page
  of: number
  direction: number
  voice: {
    supported: boolean
    reading: Reading | null
    read: (key: string, markdown: string) => void
    stop: () => void
  }
  onError: (error: unknown) => void
}): React.JSX.Element {
  const live = page.status === 'writing' || page.status === 'working'
  const lastRow = page.rows.at(-1)
  const penOnLast = live && !!lastRow
  const reading = voice.reading?.key === page.key ? voice.reading : null
  return (
    <article
      className="folio-page"
      data-direction={direction < 0 ? 'back' : 'forward'}
      data-status={page.status}
      aria-label={`Page ${page.number}: ${page.title}`}
    >
      <PageHead page={page} of={of} />
      <div className="folio-body">
        {page.rows.map((row) => (
          <Line key={row.key} row={row} pen={penOnLast && row === lastRow} onError={onError} />
        ))}
        {live && !lastRow && (
          <div className="folio-line">
            <div className="folio-text">
              <span className="folio-pen" role="status" aria-label="The agent is working" />
            </div>
          </div>
        )}
        {page.status === 'interrupted' && (
          <p className="folio-aside">Stopped before it finished.</p>
        )}
      </div>
      {!live && page.answer && (
        <footer className="folio-foot">
          {voice.supported &&
            (reading ? (
              <button type="button" className="folio-action" data-on="true" onClick={voice.stop}>
                <StopIcon aria-hidden="true" />
                Stop reading
                <span className="folio-action-count">
                  {reading.at + 1}/{reading.of}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="folio-action"
                onClick={() => voice.read(page.key, page.answer)}
              >
                <SpeakerWaveIcon aria-hidden="true" />
                Read it to me
              </button>
            ))}
          <CopyAnswer text={page.answer} />
          {page.tools > 0 && (
            <span className="folio-tally">
              {page.tools} {page.tools === 1 ? 'step' : 'steps'}
              {page.failed > 0 ? ` · ${page.failed} failed` : ''}
            </span>
          )}
        </footer>
      )}
    </article>
  )
}

/** Answer length as a tick's height: a log scale, so a one-line answer and
 *  a long report both read, between a floor and the spine's height. */
const tickHeight = (page: Page): number =>
  Math.round(25 + Math.min(75, Math.log10(1 + page.answer.length + page.tools * 40) * 22))

/** The book's spine: one tick per page, the way to turn, and the contents. */
function Spine({
  pages,
  current,
  more,
  onTurn,
  onEarlier
}: {
  pages: Page[]
  current: Page
  more: boolean
  onTurn: (key: string) => void
  onEarlier: () => void
}): React.JSX.Element {
  const [contents, setContents] = useState(false)
  const strip = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const at = pages.indexOf(current)
  // The contents open on the page the reader is on, and close on a click
  // anywhere else.
  useEffect(() => {
    if (!contents) return
    list.current?.querySelector<HTMLElement>('[data-current="true"]')?.focus()
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !list.current?.parentElement?.contains(target)) setContents(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [contents])
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current.key])
  return (
    <nav className="folio-spine" aria-label="Pages">
      <button
        type="button"
        className="folio-turn"
        aria-label="Previous page"
        title="Previous page (←)"
        disabled={at <= 0 && !more}
        onClick={() => (at > 0 ? onTurn(pages[at - 1].key) : onEarlier())}
      >
        <ChevronLeftIcon />
      </button>
      <div className="folio-ticks" ref={strip}>
        {more && (
          <button
            type="button"
            className="folio-tick-more"
            title="Load earlier pages"
            aria-label="Load earlier pages"
            onClick={onEarlier}
          >
            …
          </button>
        )}
        {pages.map((page) => (
          <button
            key={page.key}
            type="button"
            className="folio-tick"
            data-status={page.status}
            aria-current={page === current ? 'page' : undefined}
            aria-label={`Page ${page.number}: ${page.title}`}
            title={`${page.number}. ${page.title}`}
            style={{ '--tick': `${tickHeight(page)}%` } as React.CSSProperties}
            onClick={() => onTurn(page.key)}
          >
            <span />
          </button>
        ))}
      </div>
      <span className="folio-count">
        {current.number}
        <span>/{pages.length}</span>
      </span>
      <button
        type="button"
        className="folio-turn"
        aria-label="Next page"
        title="Next page (→)"
        disabled={at >= pages.length - 1}
        onClick={() => onTurn(pages[at + 1].key)}
      >
        <ChevronRightIcon />
      </button>
      <button
        type="button"
        className="folio-turn"
        aria-label="Contents"
        title="Contents"
        aria-expanded={contents}
        data-on={contents ? 'true' : undefined}
        onClick={() => setContents((c) => !c)}
      >
        <ListBulletIcon />
      </button>
      {contents && (
        <div
          ref={list}
          className="menu-surface folio-contents p-1"
          role="menu"
          aria-label="Contents"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setContents(false)
            }
            // The arrows move in the list; they never reach the pane, which
            // would turn the page under the open menu.
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation()
          }}
        >
          <div className="menu-label">Contents</div>
          <ol>
            {pages.map((page) => (
              <li key={page.key}>
                <button
                  type="button"
                  role="menuitem"
                  className="folio-contents-item"
                  data-current={page === current ? 'true' : undefined}
                  onClick={() => {
                    setContents(false)
                    onTurn(page.key)
                  }}
                >
                  <span className="folio-contents-number">{page.number}</span>
                  <span className="folio-contents-title">{page.title}</span>
                  {STATUS_WORDS[page.status] && (
                    <span className="folio-status" data-status={page.status}>
                      {STATUS_WORDS[page.status]}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </nav>
  )
}

/** The page's scroller follows what is being written while the reader is at
 *  its foot, and a page turned to opens at its head, or at its foot when it is
 *  the page still being written. */
function usePageScroll(
  key: string | null,
  live: boolean,
  content: unknown,
  visible: boolean
): React.RefObject<HTMLDivElement | null> {
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || !visible) return
    el.scrollTop = live ? el.scrollHeight : 0
    following.current = live
    // Turning the page is the only thing that moves the reader here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useLayoutEffect(() => {
    const el = scroll.current
    if (el && visible && following.current) el.scrollTop = el.scrollHeight
  }, [content, visible])
  useEffect(() => {
    const el = scroll.current
    if (!el || !visible) return
    const onScroll = (): void => {
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight
    })
    el.addEventListener('scroll', onScroll)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [visible, key])
  return scroll
}

export function FolioView({ session, onState, visible = true }: ChatViewProps): React.JSX.Element {
  const {
    conversation,
    dispatch,
    status,
    subagents,
    ready,
    past,
    retryPast,
    earlier,
    imagesSupported
  } = useConversation(session.id, session.state)
  const presentation = usePresentation(conversation, visible)
  const work = useMemo(() => shownWork(status.agents), [status.agents])
  const { draft, setDraft, recall } = useMessageHistory(session.id, conversation.entries)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState<'files' | 'paths' | null>(null)
  const dragDepth = useRef(0)
  const [pending, setPending] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const lastSent = useRef<{ text: string; attachments: Attachment[] } | null>(null)
  const state = conversation.state
  const closed = !ready || state === 'ended'
  useComposerFocus(session.id, visible && !closed, textarea)
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  const report = useCallback(
    (error: unknown): void =>
      dispatch({ event: { type: 'error', message: String(error), fatal: false } }),
    [dispatch]
  )
  const write = async (input: SessionInput): Promise<void> => {
    await window.electronAPI.sessionsWrite(session.id, input)
  }
  const remotePending = useFleetStore((s) => s.requests[ownerOf(session.id)])

  // The book. Built from what is presented, so a hidden Folio rebuilds
  // nothing while another view is on screen.
  const pages = useMemo(() => {
    const entries = withServerPending(presentation.entries, remotePending, session.id)
    const ordinal = new Map<Entry, number>()
    entries.forEach((entry, i) => ordinal.set(entry, presentation.first + i))
    return buildPages(entries, (entry) => ordinal.get(entry), presentation.state)
  }, [presentation.entries, presentation.first, presentation.state, remotePending, session.id])
  // The page the reader holds; null follows the last page, the one being written.
  const [held, setHeld] = useState<string | null>(null)
  const page = currentPage(pages, held)
  const turn = useCallback(
    (key: string | null): void => setHeld(key === pages.at(-1)?.key ? null : key),
    [pages]
  )
  // Which way the page turned, for the motion: read off the page numbers.
  const [turned, setTurned] = useState<{ key: string | null; number: number; direction: number }>({
    key: null,
    number: 0,
    direction: 1
  })
  if (page && page.key !== turned.key)
    setTurned({
      key: page.key,
      number: page.number,
      direction: page.number >= turned.number ? 1 : -1
    })
  // On the first page with more of the past to read: read it.
  const atFirst = !!page && pages[0] === page
  useEffect(() => {
    if (visible && atFirst && earlier) void earlier().catch(report)
  }, [visible, atFirst, earlier, report])
  const live = page?.status === 'writing' || page?.status === 'working'
  const scroll = usePageScroll(page?.key ?? null, live, page, visible)

  // Reading aloud: on the reader's ask, and, when they asked for it, each new
  // answer as it is finished while this pane is on screen.
  const voice = useReadAloud()
  const [autoRead, setAutoRead] = useAutoRead()
  // Switched to another view, the pane stops reading: a voice nobody can see
  // the source of, or stop, is not a reading.
  const stopVoice = voice.stop
  useEffect(() => {
    if (!visible) stopVoice()
  }, [visible, stopVoice])
  const latest = pages.at(-1)
  const writing = useRef<string | null>(null)
  const { read } = voice
  useEffect(() => {
    if (!latest) return
    if (latest.status === 'writing' || latest.status === 'working') {
      writing.current = latest.key
      return
    }
    if (writing.current !== latest.key) return
    writing.current = null
    if (latest.status === 'done' && autoRead && visible && latest.answer)
      read(latest.key, latest.answer)
  }, [latest, autoRead, visible, read])

  const pane = useRef<HTMLDivElement>(null)
  const {
    attachments,
    preparations,
    sessionsOver,
    addFiles,
    insertAtCaret,
    withdraw,
    changeAttachments,
    onDraftChange,
    clearSent,
    restore
  } = useComposerAttachments({ sessionId: session.id, closed, setDraft, textarea, pane, report })
  const filesBlocked =
    preparations.length > 0 || attachments.some((file) => attachmentIssue(file, imagesSupported))
  const hasDraft = !!draft.trim() || attachments.length > 0
  const showInterrupt = state === 'working' && !(session.provider === 'codex' && hasDraft)
  const send = async (): Promise<void> => {
    if (!ready || sending || state === 'ended' || !hasDraft || filesBlocked) return
    const imageBytes = attachments.reduce(
      (sum, file) => sum + (file.delivery === 'image' ? file.size : 0),
      0
    )
    if (imageBytes > MAX_TOTAL_IMAGE_BYTES)
      return report('Images in one message must total 20 MiB or less.')
    const text = draft
    const files = attachments
    setSending(true)
    // A question asked turns to its page: the new one, about to be written.
    setHeld(null)
    try {
      await write({ type: 'user_message', text, ...(files.length ? { attachments: files } : {}) })
      lastSent.current = { text, attachments: files }
      setDraft((current) => (current === text ? '' : current))
      clearSent(files)
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
    answers?: Record<string, string | string[]>
  ): Promise<void> => {
    setPending((current) => [...current, id])
    try {
      if (isRemoteKey(session.id)) {
        const request = remotePending?.find((r) => r.id === id)
        if (!request?.providerRequestId) throw new Error('This request is no longer waiting.')
        const { accepted } = await window.electronAPI.fleetResolve(id, {
          type: 'permission',
          optionId,
          ...(answers ? { answers } : {})
        })
        if (!accepted) throw new Error('This request was already answered.')
        dispatch({
          answer: request.providerRequestId,
          optionId,
          answers: publicQuestionAnswers(request.questions, request.input, answers)
        })
        textarea.current?.focus()
        return
      }
      await write({ type: 'permission_response', id, optionId, ...(answers ? { answers } : {}) })
      const permission = conversation.entries.find(
        (entry) => entry.kind === 'permission' && entry.request.id === id
      )
      const shown =
        permission?.kind === 'permission'
          ? publicQuestionAnswers(permission.request.questions, permission.request.input, answers)
          : undefined
      dispatch({ answer: id, optionId, answers: shown })
      textarea.current?.focus()
    } catch (error) {
      report(isRemoteKey(session.id) ? error : refusedAnswer(error, id, dispatch))
    } finally {
      setPending((current) => current.filter((value) => value !== id))
    }
  }
  // Escape while the agent works stops the turn; before any answer, the
  // message comes back to the composer, as in the Chat view.
  const takeBack = (): void => {
    void write({ type: 'interrupt' }).catch(report)
    const last = lastSent.current
    if (!answeredSince(conversation.entries)) {
      dispatch({ withdraw: true })
      if (last && !draft.trim() && !attachments.length) {
        setDraft(last.text)
        restore(last.attachments)
      }
    }
    textarea.current?.focus()
  }
  const drop = (dt: DataTransfer): void => {
    if (filesDrag(dt)) {
      const files = Array.from(dt.files)
      void addFiles(files.length ? files : pathsFromDataTransfer(dt))
    } else if (pathsDrag(dt)) void dropPaths(pathsFromDataTransfer(dt))
  }
  const dropPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    const stable = await Promise.all(
      paths.map((p) =>
        stablePath(p).catch((failure: unknown) => {
          const path = isRemoteKey(p) ? parseResourceKey('file', p).id : p
          const name = path.split(/[\\/]/).pop() || path
          report(`${failureText(failure)} ${name} is in the message as a path.`)
          return path
        })
      )
    )
    insertAtCaret(stable.map(pathForMessage).join(' ') + ' ')
  }
  const stablePath = async (p: string): Promise<string> => {
    if (!isRemoteKey(session.id)) {
      if (isRemoteKey(p)) throw new Error('This file belongs to another server.')
      return (await window.electronAPI.persistDroppedFile(p)) ?? p
    }
    if (isRemoteKey(p)) {
      const file = parseResourceKey('file', p)
      if (file.serverId !== ownerOf(session.id))
        throw new Error('This file belongs to another server.')
      return file.id
    }
    const file = await window.electronAPI.sessionsFiles.prepare(session.id, { path: p })
    return parseResourceKey('file', file.path).id
  }
  const waitingOn = isRemoteKey(session.id)
    ? serverDock(remotePending, session.id)
    : openRequests(conversation.entries)
  const head = pastHead(past, conversation.entries.length, state === 'ended')
  const step = (by: number): void => {
    const next = turnPage(pages, page?.key ?? null, by)
    if (next && next !== page) turn(next.key)
    else if (by < 0 && earlier) void earlier().catch(report)
  }
  const onLatest = !page || page === latest

  return (
    <div
      ref={pane}
      className="chat-view folio-view"
      data-testid="folio-view"
      onClickCapture={(event) => {
        const href = (event.target as Element).closest('a')?.getAttribute('href')
        if (isRemoteKey(session.id) && href && /^https?:/i.test(href) && !canOpenRemotePage(href)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state === 'working') {
          event.preventDefault()
          takeBack()
          return
        }
        const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
        if (!arrow || event.metaKey || event.ctrlKey || event.shiftKey) return
        // The arrows turn pages from anywhere but a field; Option and the
        // arrows turn them from the composer while it is empty.
        const inField = editable(event.target)
        if ((inField && !(event.altKey && !draft)) || (!inField && event.altKey)) return
        event.preventDefault()
        step(arrow)
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
      {(dragging === 'files' || sessionsOver) && (
        <div className="chat-drop-overlay" role="status">
          <div className="chat-drop-card">
            <DropDrawing kind={sessionsOver ? 'sessions' : 'files'} />
            <p className="chat-drop-eyebrow">{sessionsOver ? 'Session' : 'Files'}</p>
            <strong>
              {sessionsOver ? 'Add the session to the message' : 'Add files to the message'}
            </strong>
            <span>
              {sessionsOver
                ? 'The agent gets its id, to read it or message it.'
                : 'Files and folders, reviewed in the composer before they go.'}
            </span>
          </div>
        </div>
      )}
      {page && (
        <Spine
          pages={pages}
          current={page}
          more={!!earlier}
          onTurn={turn}
          onEarlier={() => void earlier?.().catch(report)}
        />
      )}
      <div className="folio-desk">
        <div ref={scroll} className="folio-scroll">
          <div className="folio-sheet" role="document" aria-label="Conversation">
            {head === 'failed' && <PastFailed onRetry={retryPast} />}
            {head === 'empty' && !page && (
              <div className="folio-empty">
                <FolioDrawing />
                <p className="chat-drop-eyebrow">{LAB_VIEW.title}</p>
                <strong>A fresh page</strong>
                <span>{LAB_VIEW.tagline}</span>
              </div>
            )}
            {page && (
              <PageView
                key={page.key}
                page={page}
                of={pages.length}
                direction={turned.direction}
                voice={voice}
                onError={report}
              />
            )}
            {state === 'ended' && onLatest && (
              <EndedNotice sessionId={session.id} exitCode={conversation.exitCode} />
            )}
          </div>
        </div>
        {!onLatest && latest && (
          <button
            type="button"
            className="folio-back"
            data-status={latest.status}
            onClick={() => turn(null)}
          >
            {STATUS_WORDS[latest.status] ? `${STATUS_WORDS[latest.status]} on` : 'Back to'} page{' '}
            {latest.number}
            <ChevronRightIcon aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="chat-composer-wrap folio-composer">
        <PromptDock
          requests={waitingOn}
          agent={AGENT_NAMES[session.provider] ?? 'the agent'}
          busy={(id) => !ready || state === 'ended' || pending.includes(id)}
          onAnswer={(id, optionId, answers) => void answer(id, optionId, answers)}
        />
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
                onChange={changeAttachments}
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
                        className="chat-turn-copy chat-attachment-remove"
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
            placeholder={
              state === 'ended'
                ? 'This session has ended'
                : page
                  ? 'Ask the next question…'
                  : 'Ask the first question…'
            }
            value={draft}
            disabled={closed}
            onChange={(event) => onDraftChange(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (!files.length) return
              event.preventDefault()
              void addFiles(files)
            }}
            onKeyDown={(event) => {
              if (recall(event) !== null) return
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
                const el = event.currentTarget
                const next = continueList(el.value, el.selectionStart, el.selectionEnd)
                if (!next) return
                event.preventDefault()
                el.value = next.text
                el.setSelectionRange(next.caret, next.caret)
                setDraft(next.text)
              }
            }}
          />
          <button
            type={showInterrupt ? 'button' : 'submit'}
            className="chat-send"
            data-kind={showInterrupt ? 'stop' : 'send'}
            aria-label={showInterrupt ? 'Interrupt' : 'Send message'}
            title={showInterrupt ? 'Interrupt (Esc)' : 'Send (Enter)'}
            disabled={!showInterrupt && (closed || sending || !hasDraft || filesBlocked)}
            onClick={
              showInterrupt ? () => void write({ type: 'interrupt' }).catch(report) : undefined
            }
          >
            <ArrowUpIcon data-glyph="send" />
            <StopIcon data-glyph="stop" />
          </button>
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
            {voice.supported && (
              <button
                type="button"
                className="chat-composer-tool folio-voice-toggle"
                aria-pressed={autoRead}
                aria-label="Read new answers aloud"
                title={autoRead ? 'New answers are read aloud' : 'Read new answers aloud'}
                data-on={autoRead ? 'true' : undefined}
                onClick={() => {
                  if (autoRead) voice.stop()
                  setAutoRead(!autoRead)
                }}
              >
                <SpeakerWaveIcon />
              </button>
            )}
            <ContextMeter
              variant="chat"
              used={status.contextUsed}
              window={status.contextWindow ?? claudeContextWindow(conversation.model)}
            />
          </span>
          <div className="chat-composer-controls">
            {conversation.permissionMode && (
              <PermissionModeMenu
                mode={conversation.permissionMode.mode}
                modes={conversation.permissionMode.modes}
                disabled={closed}
                onSelect={(id) =>
                  void write({ type: 'set_permission_mode', mode: id }).catch(report)
                }
              />
            )}
            <ModelMenu
              sessionId={session.id}
              model={conversation.pendingModel ?? conversation.model}
              pending={conversation.pendingModel !== null}
              disabled={closed}
              onSelect={(id) => {
                // Shown the instant it is picked (PRDCT-4273); the provider's
                // answer confirms it or, refusing, reverts the chip.
                dispatch({ pickModel: id })
                void write({ type: 'set_model', model: id }).catch(report)
              }}
              provider={session.provider}
              adapterId={session.adapterId}
              cwd={session.cwd}
            />
            <EffortMenu
              sessionId={session.id}
              model={conversation.pendingModel ?? conversation.model}
              effort={conversation.effort}
              disabled={closed}
              onSelect={(id) => void write({ type: 'set_effort', effort: id }).catch(report)}
            />
          </div>
        </div>
        <WorkCards
          agents={work}
          logs={subagents}
          canRelaunch={(agent) => agent.fromAgentTool || session.provider === 'claude'}
          onRelaunch={(agent, alias) => {
            if (!agent.taskId) return
            void write({ type: 'stop_task', taskId: agent.taskId })
              .then(() => write({ type: 'user_message', text: relaunchRequest(agent, alias) }))
              .catch(report)
          }}
        />
      </div>
    </div>
  )
}
