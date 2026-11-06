import { useEffect, useMemo, useState } from 'react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import type { Session } from '../../../../shared/session-model'
import { ChatView } from '../../../../../plugins/chat-view/src/ChatView'
import { RoutineReport } from '../../../../../plugins/routine-report/src/RoutineReport'
import {
  TONE_CLASS,
  durationLabel,
  runTone,
  stateLabel,
  whenLabel
} from '../../../../../plugins/routine-report/src/run-labels'
import { useRoutinesStore } from '../../store/routines-store'
import { describeCron } from '../../../../main/routines/cron'

/**
 * The floating panel of a routine (ADR 0004): the routine's name and
 * schedule, the Report / Discussion toggle, the selected run's report (the
 * deck in the page guest, or the envelope card), Run again, Open as a tab,
 * Dismiss, and the history. The discussion is the run's session continued in
 * the chat view inside the panel, re-homed to this window by the server.
 */
export function RoutinePanel({
  view,
  onClose
}: {
  view: RoutineView
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
    if (sessionId) onClose()
  }

  return (
    <div
      className="flex flex-col min-h-0"
      style={{ width: view.routine.report.width, height: view.routine.report.height }}
      data-testid="routine-panel"
      data-routine={view.routine.name}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs text-text-primary truncate" data-testid="routine-panel-name">
            {view.routine.name}
          </span>
          <span
            className="text-[10px] text-text-tertiary truncate"
            data-testid="routine-panel-schedule"
          >
            {describeCron(view.routine.schedule)}
            {next ? ` · next ${next}` : view.routine.invalid ? ' · cannot run' : ''}
            {run?.account ? ` · ${run.account}` : ''}
            {run?.model ? ` · ${run.model}` : ''}
          </span>
        </div>
        <div className="flex items-center rounded-md bg-surface-200 p-0.5" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'report'}
            className={cn(
              'px-2 py-0.5 text-[11px] rounded',
              tab === 'report' && 'bg-surface-0 text-text-primary'
            )}
            data-testid="routine-tab-report"
            onClick={() => setTab('report')}
          >
            Report
          </button>
          <button
            role="tab"
            aria-selected={tab === 'discussion'}
            className={cn(
              'px-2 py-0.5 text-[11px] rounded',
              tab === 'discussion' && 'bg-surface-0 text-text-primary'
            )}
            data-testid="routine-tab-discussion"
            disabled={!run}
            onClick={() => void showDiscussion()}
          >
            Discussion
          </button>
        </div>
        <button onClick={onClose} className="btn-icon btn-icon-xs" aria-label="Close">
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {view.routine.invalid && (
          <p className="px-3 py-2 text-xs text-red-400" data-testid="routine-panel-invalid">
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
          <div className="p-4 text-xs text-text-tertiary" data-testid="routine-discussion-pending">
            {opening ? 'Opening the discussion…' : (error ?? 'No discussion yet.')}
          </div>
        )}
      </div>

      {error && tab === 'report' && (
        <p
          className="px-3 py-1 text-[10px] text-red-400 border-t border-border-subtle"
          data-testid="routine-panel-error"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border-subtle">
        <button
          className="btn-secondary flex items-center gap-1"
          data-testid="routine-run-again"
          disabled={running || !!view.routine.invalid}
          title={running ? 'A run is in flight' : 'Run now, whatever the schedule'}
          onClick={() => void runNow(view.routine.key)}
        >
          <ArrowPathIcon className="w-3 h-3" />
          {view.runs.length ? 'Run again' : 'Run now'}
        </button>
        <button
          className="btn-secondary flex items-center gap-1"
          data-testid="routine-open-tab"
          disabled={!run}
          title="Continue this run's conversation in an ordinary tab"
          onClick={() => void openAsTab()}
        >
          <ArrowTopRightOnSquareIcon className="w-3 h-3" />
          Open as a tab
        </button>
        <button
          className="btn-secondary flex items-center gap-1 ml-auto"
          data-testid="routine-dismiss"
          disabled={!run || run.seen}
          title="Put the badge away"
          onClick={() => run && void dismiss(run.id)}
        >
          <CheckIcon className="w-3 h-3" />
          Dismiss
        </button>
      </div>

      {view.runs.length > 1 && (
        <ul
          className="max-h-28 overflow-auto border-t border-border-subtle"
          data-testid="routine-history"
        >
          {view.runs.map((r) => (
            <li key={r.id}>
              <button
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1 text-left text-[11px] hover:bg-surface-200',
                  r.id === run?.id && 'bg-surface-200'
                )}
                data-testid="routine-history-row"
                data-state={r.state}
                onClick={() => setSelectedId(r.id)}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', TONE_CLASS[runTone(r)])} />
                <span className="truncate flex-1 text-text-primary">
                  {r.headline ?? r.reason ?? stateLabel(r)}
                </span>
                <span className="text-text-tertiary shrink-0">
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
