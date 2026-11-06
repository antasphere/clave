import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  DocumentChartBarIcon,
  EllipsisHorizontalIcon,
  QueueListIcon
} from '@heroicons/react/24/outline'
import { IconButton } from '@clave/ui/components'
import { AnimatePresence, motion } from 'framer-motion'
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
import { adoptServerStartedSessions } from '../../lib/adopt-record'
import { describeCron } from '../../../../main/routines/cron'

type Tab = 'report' | 'discussion' | 'runs'

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
 */
export function RoutinePanel({
  view,
  icon,
  color,
  onClose
}: {
  view: RoutineView
  /** The routine's toolbar glyph, drawn again on the title's tile. */
  icon?: ReactNode
  /** The ink the toolbar draws the glyph in. */
  color?: string
  onClose: () => void
}): React.JSX.Element {
  const viewer = useRoutinesStore((s) => s.viewer)
  const error = useRoutinesStore((s) => s.error)
  const runNow = useRoutinesStore((s) => s.runNow)
  const dismiss = useRoutinesStore((s) => s.dismiss)
  const openDiscussion = useRoutinesStore((s) => s.openDiscussion)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('report')
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

  const showDiscussion = async (): Promise<void> => {
    if (!run) return
    setTab('discussion')
    if (discussion) return
    setOpening(true)
    try {
      const sessionId = await openDiscussion(run.id, 'panel')
      if (!sessionId) return
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

  const openAsTab = async (): Promise<void> => {
    setMenuOpen(false)
    if (!run) return
    const sessionId = await openDiscussion(run.id, 'tab')
    if (!sessionId) return
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
              : `${describeCron(view.routine.schedule)}${next ? ` · next ${next}` : ''}`}
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
            disabled={running || !!view.routine.invalid}
            tooltip={running ? 'A run is in flight' : 'Run now'}
            onClick={() => void runNow(view.routine.key)}
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
                  if (run) void dismiss(run.id)
                }}
              >
                <CheckIcon className="menu-glyph" />
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>

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
                viewerUrl={viewer.url}
                viewerNote={viewer.note}
                ready={settled}
              />
            </motion.div>
          </AnimatePresence>
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
