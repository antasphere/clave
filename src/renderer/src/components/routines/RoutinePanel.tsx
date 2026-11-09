import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  DocumentChartBarIcon,
  EllipsisHorizontalIcon,
  PauseIcon,
  PencilSquareIcon,
  PlayIcon,
  QueueListIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import { IconButton } from '@clave/ui/components'
import { AnimatePresence, motion } from 'framer-motion'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import type { Session } from '../../../../shared/session-model'
import { ChatView } from '../../../../../plugins/chat-view/src/ChatView'
import { RoutineReport } from '../../../../../plugins/routine-report/src/RoutineReport'
import {
  DiscussionDrawing,
  RoutineDrawing
} from '../../../../../plugins/routine-report/src/RoutineDrawing'
import {
  durationLabel,
  runTone,
  stateLabel,
  whenLabel
} from '../../../../../plugins/routine-report/src/run-labels'
import { RunGlyph } from '../../../../../plugins/routine-report/src/RunGlyph'
import { TroubleNote } from '../../../../../plugins/routine-report/src/RoutineTrouble'
import { invalidTrouble, storeTrouble } from '../../../../../plugins/routine-report/src/trouble'
import { claudeModelName } from '../../../../shared/claude-models'
import { useRoutinesStore } from '../../store/routines-store'
import { useSessionStore } from '../../store/session-store'
import type { RoutineSurface } from './routine-servers'
import { rememberTab, rememberedTab, type PanelTab } from './panel-tab'
import { adoptServerStartedSessions } from '../../lib/adopt-record'
import { describeCron } from '../../../../main/routines/cron'

type Tab = PanelTab

/**
 * The floating panel of a routine (ADR 0004). Three things a reader asks of
 * a routine, one tab each, so the panel shows one at a time and breathes:
 *
 *   Report      the selected run's deck (the latest by default)
 *   Discussion  that run's conversation, continued in the chat view
 *   Runs        the facts (schedule, next run, model, account) and the history
 *
 * Above them a title in the menu's manner (the routine's icon on a tile, its
 * name, the schedule in words) and one row: the tabs, Run now, and a small
 * menu for the two rarer acts (Open as a tab, Dismiss). Nothing repeats what
 * the deck already says.
 *
 * A routine a connected server runs (PRDCT-4149) is the same panel over that
 * server's view: every act goes to that server, the deck is read over its API
 * and cached on this Mac (its loopback viewer is not reachable from here), and
 * the discussion is a session of that server, listed in this window once its
 * snapshot is read.
 */
export function RoutinePanel({
  surface,
  icon,
  color,
  onClose,
  onBack,
  onEdit
}: {
  surface: RoutineSurface
  /** The routine's toolbar glyph, drawn again on the title's tile. */
  icon?: ReactNode
  /** The ink the toolbar draws the glyph in. */
  color?: string
  onClose: () => void
  /** Back to the list the panel replaced (PRDCT-4244); absent, no chevron. */
  onBack?: () => void
  /** Edit a created routine (PRDCT-4242): the form the list opened it with. */
  onEdit?: () => void
}): React.JSX.Element {
  const view = surface.view
  const remote = surface.serverId !== LOCAL_SERVER_ID
  const created = view.routine.origin === 'created'
  const viewer = useRoutinesStore((s) => s.viewer)
  const error = useRoutinesStore((s) => s.error)
  const runNow = useRoutinesStore((s) => s.runNow)
  const dismiss = useRoutinesStore((s) => s.dismiss)
  const pause = useRoutinesStore((s) => s.pause)
  const remove = useRoutinesStore((s) => s.remove)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const openDiscussion = useRoutinesStore((s) => s.openDiscussion)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The tab the panel was left on, per routine: a message just sent in
  // Discussion is where the panel reopens, not back on Report.
  const [tab, setTabState] = useState<Tab>(() => rememberedTab(view.routine.key))
  const setTab = (next: Tab): void => {
    setTabState(next)
    rememberTab(view.routine.key, next)
  }
  const [discussion, setDiscussion] = useState<Session | null>(null)
  const [opening, setOpening] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // The popover's rise is done: the deck's web view may mount (RoutineReport).
  // A timer, not the motion's callback: the first body does not animate.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 200)
    return () => clearTimeout(t)
  }, [])
  const menuRef = useRef<HTMLDivElement | null>(null)
  const run: RoutineRun | undefined = useMemo(
    () => view.runs.find((r) => r.id === selectedId) ?? view.runs[0],
    [view.runs, selectedId]
  )
  // A new run arriving while the panel shows the latest follows it.
  useEffect(() => {
    if (selectedId && !view.runs.some((r) => r.id === selectedId)) setSelectedId(null)
  }, [view.runs, selectedId])
  // Switching runs leaves the discussion of the previous one.
  useEffect(() => {
    setDiscussion(null)
  }, [run?.id])
  // The small menu closes on a click anywhere else in the panel.
  useEffect(() => {
    if (!menuOpen) return
    const away = (e: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [menuOpen])

  const running = view.runs.some((r) => r.state === 'running' || r.state === 'waiting')
  const next = view.nextRunAt ? whenLabel(view.nextRunAt) : null

  // A server's run deck: read once per run over the server's API, written
  // under this Mac's user data and served by the preview protocol. While it
  // loads, or when it could not be read, the report shows its envelope with a
  // note in the viewer's place.
  const [deckUrls, setDeckUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [deckErrors, setDeckErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const deckAsked = useRef(new Set<string>())
  useEffect(() => {
    if (!remote || !run?.deck || deckAsked.current.has(run.id)) return
    deckAsked.current.add(run.id)
    const runId = run.id
    const serverId = surface.serverId
    void (async () => {
      try {
        const { html } = await window.electronAPI.fleetRoutineDeck(serverId, runId)
        const { url } = await window.electronAPI.routinesCacheRemoteDeck(serverId, runId, html)
        setDeckUrls((m) => new Map(m).set(runId, url))
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        setDeckErrors((m) => new Map(m).set(runId, why))
      }
    })()
  }, [remote, run?.id, run?.deck, surface.serverId])
  const deckUrl = remote ? ((run && deckUrls.get(run.id)) ?? null) : undefined
  const deckError = remote && run ? deckErrors.get(run.id) : undefined
  const reportNote = !remote
    ? viewer.note
    : deckError
      ? `The report could not be read from ${surface.serverName}: ${deckError}`
      : `Reading the report from ${surface.serverName}…`

  // A server's session reaches this window's list with that server's next
  // snapshot: read it now rather than wait for the push.
  const readServer = async (): Promise<void> => {
    if (!remote) return
    try {
      await window.electronAPI.fleetSnapshot(surface.serverId)
    } catch {
      /* the push brings it */
    }
  }

  const showDiscussion = async (): Promise<void> => {
    if (!run) return
    setTab('discussion')
    if (discussion) return
    setOpening(true)
    try {
      const sessionId = await openDiscussion(surface, run.id, 'panel')
      if (!sessionId) return
      await readServer()
      // The server re-homed the session to this window: it is listed here now.
      const session = (await window.electronAPI.sessionsList()).find((s) => s.id === sessionId)
      if (session) setDiscussion(session)
      else
        useRoutinesStore.setState({
          error: 'The discussion session is not listed in this window yet'
        })
    } finally {
      setOpening(false)
    }
  }

  // Reopened on Discussion (the tab it was left on): bring the conversation
  // back at once, as a click on the tab would, once per run so a failed open
  // shows its note instead of being asked again in a loop. Without a run there
  // is nothing to discuss, and the panel shows Report.
  const autoOpened = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'discussion' || discussion || opening) return
    if (!run) {
      setTabState('report')
      return
    }
    if (autoOpened.current === run.id) return
    autoOpened.current = run.id
    void showDiscussion()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showDiscussion reads the same state
  }, [tab, run?.id, discussion, opening])

  const openAsTab = async (): Promise<void> => {
    setMenuOpen(false)
    if (!run) return
    const sessionId = await openDiscussion(surface, run.id, 'tab')
    if (!sessionId) return
    if (remote) {
      // A server's session is placed by its snapshot, as a tab started on a
      // server is (`launch-session.ts`): read it, then focus the tab.
      await readServer()
      useSessionStore.setState({
        selectedSessionIds: [sessionId],
        focusedSessionId: sessionId,
        activeView: 'terminals'
      })
      onClose()
      return
    }
    // The server started the session on this window; the window takes it in
    // as a focused tab, the way it takes in a tab an agent opened through the
    // server (round 1, F3: nothing placed it before).
    await adoptServerStartedSessions([sessionId], { focus: true })
    onClose()
  }

  const pickRun = (id: string): void => {
    setSelectedId(id)
    setTab('report')
  }

  const tabButton = (id: Tab, label: string, Glyph: typeof DocumentChartBarIcon): ReactNode => (
    <button
      role="tab"
      className="panel-tab"
      aria-selected={tab === id}
      data-selected={tab === id ? 'true' : undefined}
      data-testid={`routine-tab-${id}`}
      disabled={id === 'discussion' && !run}
      onClick={() => (id === 'discussion' ? void showDiscussion() : setTab(id))}
    >
      <Glyph className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{label}</span>
    </button>
  )

  return (
    <div
      className="routine-panel"
      // The declared size is the size it wants, never more than the window
      // gives: the popover's available room below the button and across, less
      // a margin, so a short or narrow window shrinks the panel (its body
      // flexes and scrolls) instead of running it off the edge.
      style={{
        width: view.routine.report.width,
        height: view.routine.report.height,
        maxWidth: 'calc(var(--radix-popover-content-available-width, 100vw) - 12px)',
        maxHeight: 'calc(var(--radix-popover-content-available-height, 100vh) - 12px)'
      }}
      data-testid="routine-panel"
      data-routine={view.routine.name}
      tabIndex={-1}
    >
      <div className="routine-head" data-testid="routine-panel-header">
        {onBack && (
          <IconButton
            className="panel-icon-btn routine-back"
            data-testid="routine-back"
            aria-label="Back to the routines"
            tooltip="Back"
            onClick={onBack}
          >
            <ChevronLeftIcon className="w-4 h-4" />
          </IconButton>
        )}
        <span className="routine-mark" style={{ color }} aria-hidden="true">
          {icon}
        </span>
        <div className="routine-head-text">
          <span className="routine-head-title" data-testid="routine-panel-name">
            {view.routine.name}
          </span>
          <span className="routine-head-sub" data-testid="routine-panel-schedule">
            {view.routine.invalid
              ? 'Cannot run'
              : view.routine.paused
                ? 'Paused'
                : `${describeCron(view.routine.schedule)}${next ? ` · next ${next}` : ''}`}
            {surface.runsOn === 'server' ? ` · on ${surface.serverName}` : ''}
            {created ? ' · created here' : ''}
          </span>
        </div>
      </div>

      <div className="routine-nav">
        <div className="panel-tabs" role="tablist" data-panel-bar="routine-tabs">
          {tabButton('report', 'Report', DocumentChartBarIcon)}
          {tabButton('discussion', 'Discussion', ChatBubbleLeftRightIcon)}
          {tabButton('runs', 'Runs', QueueListIcon)}
        </div>
        <div className="routine-nav-actions" ref={menuRef}>
          <IconButton
            className="panel-icon-btn"
            data-testid="routine-run-again"
            aria-label="Run now"
            disabled={
              running || !!view.routine.invalid || !surface.reachable || !!view.routine.paused
            }
            tooltip={
              !surface.reachable
                ? `Runs on ${surface.serverName}, not connected`
                : view.routine.paused
                  ? 'Paused: resume it to run it'
                  : running
                    ? 'A run is in flight'
                    : 'Run now'
            }
            onClick={() => void runNow(surface, view.routine.key)}
          >
            <ArrowPathIcon className="w-4 h-4" />
          </IconButton>
          <IconButton
            className="panel-icon-btn"
            data-testid="routine-more"
            aria-label="More"
            aria-expanded={menuOpen}
            data-active={menuOpen ? 'true' : undefined}
            tooltip="More"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <EllipsisHorizontalIcon className="w-4 h-4" />
          </IconButton>
          {menuOpen && (
            <div className="routine-menu menu-surface menu-pop-mount" role="menu">
              <button
                role="menuitem"
                className="menu-item"
                data-testid="routine-open-tab"
                disabled={!run}
                onClick={() => void openAsTab()}
              >
                <ArrowTopRightOnSquareIcon className="menu-glyph" />
                Open as a tab
              </button>
              <button
                role="menuitem"
                className="menu-item"
                data-testid="routine-dismiss"
                disabled={!run || run.seen}
                onClick={() => {
                  setMenuOpen(false)
                  if (run) void dismiss(surface, run.id)
                }}
              >
                <CheckIcon className="menu-glyph" />
                Dismiss
              </button>
              {created && (
                <>
                  <div className="menu-sep" />
                  {onEdit && (
                    <button
                      role="menuitem"
                      className="menu-item"
                      data-testid="routine-edit"
                      onClick={() => {
                        setMenuOpen(false)
                        onEdit()
                      }}
                    >
                      <PencilSquareIcon className="menu-glyph" />
                      Edit
                    </button>
                  )}
                  <button
                    role="menuitem"
                    className="menu-item"
                    data-testid="routine-pause"
                    onClick={() => {
                      setMenuOpen(false)
                      void pause(surface, view.routine.key, !view.routine.paused)
                    }}
                  >
                    {view.routine.paused ? (
                      <PlayIcon className="menu-glyph" />
                    ) : (
                      <PauseIcon className="menu-glyph" />
                    )}
                    {view.routine.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    role="menuitem"
                    className="menu-item menu-item--danger"
                    data-testid="routine-delete"
                    onClick={() => {
                      setMenuOpen(false)
                      setConfirmDelete(true)
                    }}
                  >
                    <TrashIcon className="menu-glyph" />
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="routine-note" data-tone="failed" data-testid="routine-delete-confirm">
          <div className="routine-note-text">
            <span>Delete “{view.routine.name}” and its run history?</span>
          </div>
          <button className="btn-secondary btn-compact" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
          <button
            className="btn-primary btn-compact"
            data-testid="routine-delete-confirm-yes"
            onClick={() => {
              setConfirmDelete(false)
              void remove(surface, view.routine.key).then(() => (onBack ?? onClose)())
            }}
          >
            Delete
          </button>
        </div>
      )}

      {/* What went wrong, if anything, in words and a glyph, the raw message
          folded under Details; a window still reaching its server says it is
          connecting, which is not trouble at all. */}
      {view.routine.invalid ? (
        <TroubleNote
          trouble={invalidTrouble(view.routine.invalid)}
          testId="routine-panel-invalid"
        />
      ) : error ? (
        (() => {
          const trouble = storeTrouble(error)
          return trouble ? (
            <TroubleNote trouble={trouble} testId="routine-panel-error" />
          ) : (
            <div
              className="routine-note"
              data-tone="running"
              data-testid="routine-panel-connecting"
            >
              <RunGlyph tone="running" label="Connecting" />
              <div className="routine-note-text">
                <span>Connecting to Clave&rsquo;s server…</span>
              </div>
            </div>
          )
        })()
      ) : null}

      {/* Three bodies on one stage, every one mounted, the active one shown:
          a tab switch is a cross-fade between painted bodies (the deck stays
          loaded, the discussion stays open), never a blink to the ground and
          a reload (seen frame by frame on 6 November 2026: the old content
          dropped at once and the new one faded in from nothing). A web view
          follows its parent's opacity, measured, so the deck fades with its
          body. Inside the report body a change of run cross-fades too. */}
      <div className="routine-stage">
        <Body active={tab === 'report'} kind="report">
          <div className="relative flex-1 min-h-0">
            <AnimatePresence initial={false}>
              <motion.div
                key={run?.id ?? 'none'}
                className="routine-body"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: 'easeOut' } }}
                transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
              >
                <RoutineReport
                  view={view}
                  run={run}
                  viewerUrl={remote ? null : viewer.url}
                  viewerNote={reportNote}
                  deckUrl={deckUrl}
                  ready={settled}
                />
              </motion.div>
            </AnimatePresence>
          </div>
          {run && (run.published?.url || run.publishError) && <PublishedRow run={run} />}
        </Body>
        <Body active={tab === 'discussion'} kind="discussion">
          {discussion ? (
            <div className="chat-host flex-1 min-h-0" data-testid="routine-discussion">
              <ChatView session={discussion} onState={() => {}} visible={tab === 'discussion'} />
            </div>
          ) : (
            <div className="routine-state" data-testid="routine-discussion-pending">
              <DiscussionDrawing />
              <strong>{opening ? 'Opening the conversation' : 'No conversation yet'}</strong>
              <span>
                {opening
                  ? 'Picked up where the agent left it.'
                  : 'Each run keeps its conversation; pick a run to continue it.'}
              </span>
            </div>
          )}
        </Body>
        <Body active={tab === 'runs'} kind="runs">
          <RunsTab view={view} selected={run} onPick={pickRun} />
        </Body>
      </div>
    </div>
  )
}

/** One body on the stage: shown or hidden by a fade, hidden ones kept
 *  mounted but out of the way (no pointer, no reading order, no paint once
 *  the fade is done). */
function Body({
  active,
  kind,
  children
}: {
  active: boolean
  kind: Tab
  children: ReactNode
}): React.JSX.Element {
  return (
    <motion.div
      className="routine-body"
      data-testid={`routine-body-${kind}`}
      data-active={active ? 'true' : undefined}
      initial={false}
      // Visible from the first frame of a fade-in, hidden only once a fade-out
      // has ended (a value set at the end stays until the next end, so a body
      // fading in stayed hidden and popped at the end, seen 6 November 2026).
      animate={
        active
          ? { opacity: 1, visibility: 'visible' }
          : { opacity: 0, transitionEnd: { visibility: 'hidden' } }
      }
      style={{ pointerEvents: active ? 'auto' : 'none' }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
      aria-hidden={active ? undefined : true}
    >
      {children}
    </motion.div>
  )
}

/** Under the report: the run's deck on Slideless when the routine publishes,
 *  or why it was not published; the run itself stands either way. */
function PublishedRow({ run }: { run: RoutineRun }): React.JSX.Element {
  const url = run.published?.url
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-border-subtle flex-shrink-0">
      {url ? (
        <button
          className="btn-secondary btn-compact"
          data-testid="routine-open-slideless"
          onClick={() => void window.electronAPI.openExternal(url)}
        >
          <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
          Open on Slideless
        </button>
      ) : (
        <span className="text-xs text-text-tertiary truncate" data-testid="routine-publish-error">
          Not published to Slideless: {run.publishError}
        </span>
      )}
    </div>
  )
}

/** The Runs tab: the routine's facts, then its runs, newest first. */
function RunsTab({
  view,
  selected,
  onPick
}: {
  view: RoutineView
  selected: RoutineRun | undefined
  onPick: (id: string) => void
}): React.JSX.Element {
  const last = view.runs[0]
  const facts: Array<[string, string]> = [
    ['Schedule', view.routine.schedule],
    ['Next run', view.nextRunAt ? whenLabel(view.nextRunAt) : '—'],
    ['Model', claudeModelName(last?.model) ?? 'Workspace default'],
    ['Account', last?.account ?? 'From the pool']
  ]
  return (
    <div className="routine-runs">
      <dl className="routine-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {view.runs.length === 0 ? (
        <div className="routine-state">
          <RoutineDrawing />
          <strong>No run yet</strong>
          <span>The first one lands here, on the schedule or on Run now.</span>
        </div>
      ) : (
        <ul className="routine-history" data-testid="routine-history">
          {view.runs.map((r) => (
            <li key={r.id}>
              <button
                className="menu-item"
                data-selected={r.id === selected?.id ? 'true' : undefined}
                data-testid="routine-history-row"
                data-run-state={r.state}
                title={`${stateLabel(r)} · ${durationLabel(r)} · ${r.trigger}`}
                onClick={() => onPick(r.id)}
              >
                {runTone(r) !== 'none' && (
                  <RunGlyph
                    tone={runTone(r) as Exclude<ReturnType<typeof runTone>, 'none'>}
                    label={stateLabel(r)}
                  />
                )}
                <span className="truncate flex-1">{r.headline ?? r.reason ?? stateLabel(r)}</span>
                <span className="routine-meta">{whenLabel(r.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
