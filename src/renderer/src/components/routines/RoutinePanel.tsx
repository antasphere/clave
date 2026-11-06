import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  DocumentChartBarIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { IconButton } from '@clave/ui/components'
import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import type { Session } from '../../../../shared/session-model'
import { ChatView } from '../../../../../plugins/chat-view/src/ChatView'
import { RoutineReport } from '../../../../../plugins/routine-report/src/RoutineReport'
import {
  durationLabel,
  runTone,
  stateLabel,
  whenLabel
} from '../../../../../plugins/routine-report/src/run-labels'
import { useRoutinesStore } from '../../store/routines-store'
import { adoptServerStartedSessions } from '../../lib/adopt-record'
import { describeCron } from '../../../../main/routines/cron'

/**
 * The floating panel of a routine (ADR 0004), built from the side panel's
 * own parts so it reads as one of its bars at every density: a pane header
 * (the routine's icon in its colour, its name, the schedule in words), the
 * Report / Discussion switch as a `panel-tabs` frame, the actions as a
 * `panel-bar` of `panel-icon-btn`s with the run's state in words between
 * them (Run again, Open as a tab, Dismiss), and the history as menu rows.
 * The discussion is the run's session continued in the chat view inside the
 * panel, re-homed to this window by the server.
 */
export function RoutinePanel({
  view,
  icon,
  color,
  onClose
}: {
  view: RoutineView
  /** The routine's toolbar glyph, drawn again in the header. */
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
  const [tab, setTab] = useState<'report' | 'discussion'>('report')
  const [discussion, setDiscussion] = useState<Session | null>(null)
  const [opening, setOpening] = useState(false)
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
    setTab('report')
  }, [run?.id])

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
    if (!run) return
    const sessionId = await openDiscussion(run.id, 'tab')
    if (!sessionId) return
    // The server started the session on this window; the window takes it in
    // as a focused tab, the way it takes in a tab an agent opened through the
    // server (round 1, F3: nothing placed it before).
    await adoptServerStartedSessions([sessionId], { focus: true })
    onClose()
  }

  const status = run
    ? `${stateLabel(run)} · ${whenLabel(run.startedAt)} · ${durationLabel(run)} · ${run.trigger}`
    : view.routine.invalid
      ? 'Cannot run'
      : 'No run yet'

  return (
    <div
      className="flex flex-col min-h-0"
      style={{ width: view.routine.report.width, height: view.routine.report.height }}
      data-testid="routine-panel"
      data-routine={view.routine.name}
    >
      <div className="pane-header" data-testid="routine-panel-header">
        <div className="pane-header-lead">
          {icon && (
            <span className="routine-panel-icon" style={{ color }} aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="flex flex-col min-w-0">
            <span className="pane-header-title" data-testid="routine-panel-name">
              {view.routine.name}
            </span>
            <span className="pane-header-meta" data-testid="routine-panel-schedule">
              {describeCron(view.routine.schedule)}
              {next ? ` · next ${next}` : view.routine.invalid ? ' · cannot run' : ''}
              {run?.account ? ` · ${run.account}` : ''}
              {run?.model ? ` · ${run.model}` : ''}
            </span>
          </div>
        </div>
        <div className="pane-header-actions">
          <div className="panel-tabs" role="tablist" data-panel-bar="routine-tabs">
            <button
              role="tab"
              className="panel-tab"
              aria-selected={tab === 'report'}
              data-selected={tab === 'report' ? 'true' : undefined}
              data-testid="routine-tab-report"
              onClick={() => setTab('report')}
            >
              <DocumentChartBarIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Report</span>
            </button>
            <button
              role="tab"
              className="panel-tab"
              aria-selected={tab === 'discussion'}
              data-selected={tab === 'discussion' ? 'true' : undefined}
              data-testid="routine-tab-discussion"
              disabled={!run}
              onClick={() => void showDiscussion()}
            >
              <ChatBubbleLeftRightIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Discussion</span>
            </button>
          </div>
          <IconButton
            onClick={onClose}
            className="panel-icon-btn"
            aria-label="Close"
            tooltip="Close"
          >
            <XMarkIcon className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {view.routine.invalid && (
          <p className="px-3 py-2 text-xs text-destructive" data-testid="routine-panel-invalid">
            {view.routine.invalid}
          </p>
        )}
        {tab === 'report' ? (
          <RoutineReport view={view} run={run} viewerUrl={viewer.url} viewerNote={viewer.note} />
        ) : discussion ? (
          <div className="chat-host flex-1 min-h-0" data-testid="routine-discussion">
            <ChatView session={discussion} onState={() => {}} visible />
          </div>
        ) : (
          <div className="routine-state" data-testid="routine-discussion-pending">
            {opening && (
              <span className="routine-spinner" aria-hidden="true">
                <span className="sidebar-tab-spinner" />
              </span>
            )}
            <strong>{opening ? 'Opening the discussion' : (error ?? 'No discussion yet')}</strong>
            {opening && (
              <span>The conversation of the run is picked up where the agent left it.</span>
            )}
          </div>
        )}
      </div>

      {error && tab === 'report' && (
        <p
          className="px-3 py-1 text-xs text-destructive border-t border-border-subtle"
          data-testid="routine-panel-error"
        >
          {error}
        </p>
      )}

      <div className="routine-panel-foot">
        <div className="panel-bar panel-bar--nowrap" data-panel-bar="routine">
          <IconButton
            className="panel-icon-btn"
            data-testid="routine-run-again"
            aria-label={view.runs.length ? 'Run again' : 'Run now'}
            disabled={running || !!view.routine.invalid}
            tooltip={
              running
                ? 'A run is in flight'
                : view.runs.length
                  ? 'Run again, whatever the schedule'
                  : 'Run now, whatever the schedule'
            }
            onClick={() => void runNow(view.routine.key)}
          >
            <ArrowPathIcon className="w-4 h-4" />
          </IconButton>
          <IconButton
            className="panel-icon-btn"
            data-testid="routine-open-tab"
            aria-label="Open as a tab"
            disabled={!run}
            tooltip="Continue this run's conversation in an ordinary tab"
            onClick={() => void openAsTab()}
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          </IconButton>
          <span className="panel-sep" aria-hidden="true" />
          <span className="panel-bar-label routine-bar-status" data-testid="routine-bar-status">
            {status}
          </span>
          <IconButton
            className="panel-icon-btn"
            data-testid="routine-dismiss"
            aria-label="Dismiss"
            disabled={!run || run.seen}
            tooltip="Dismiss: put the badge away"
            onClick={() => run && void dismiss(run.id)}
          >
            <CheckIcon className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {view.runs.length > 1 && (
        <ul className="routine-history" data-testid="routine-history">
          {view.runs.map((r) => (
            <li key={r.id}>
              <button
                className="menu-item"
                data-selected={r.id === run?.id ? 'true' : undefined}
                data-testid="routine-history-row"
                data-state={r.state}
                onClick={() => setSelectedId(r.id)}
              >
                <span className="routine-dot" data-tone={runTone(r)} aria-hidden="true" />
                <span className="truncate flex-1">{r.headline ?? r.reason ?? stateLabel(r)}</span>
                <span className="routine-meta">
                  {whenLabel(r.startedAt)} · {durationLabel(r)} · {r.trigger}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
