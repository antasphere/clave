import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import { TONE_CLASS, durationLabel, runTone, stateLabel, whenLabel } from './run-labels'
import { PageGuest } from '../../../src/renderer/src/components/layout/PageGuest'
import { MarkdownRenderer } from '../../../src/renderer/src/components/files/MarkdownRenderer'

/**
 * One run's report: the deck served by the viewer in the hardened page guest,
 * or the envelope as a card when there is no deck yet, no viewer, or the run
 * failed before any report. The same component in the toolbar's panel and in
 * the session view.
 */
export function RoutineReport({
  view,
  run,
  viewerUrl,
  viewerNote
}: {
  view: RoutineView | undefined
  run: RoutineRun | undefined
  viewerUrl: string | null
  viewerNote: string
}): React.JSX.Element {
  if (!run) {
    return (
      <div className="p-4 text-xs text-text-tertiary" data-testid="routine-report-empty">
        {view ? 'No run yet.' : 'This session is not a routine run.'}
      </div>
    )
  }
  if (run.deck && viewerUrl) {
    const src = `${viewerUrl.replace(/\/$/, '')}/${run.deck}`
    return (
      <div className="relative flex-1 min-h-0 h-full" data-testid="routine-report-deck">
        <PageGuest key={src} src={src} title={run.headline ?? view?.routine.name} />
      </div>
    )
  }
  const tone = runTone(run)
  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto h-full" data-testid="routine-report-card">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${TONE_CLASS[tone]}`} />
        <span className="text-xs text-text-secondary" data-testid="routine-report-state">
          {stateLabel(run)}
        </span>
        <span className="text-[10px] text-text-tertiary ml-auto">
          {whenLabel(run.startedAt)} · {durationLabel(run)} · {run.trigger}
        </span>
      </div>
      {run.headline && (
        <p className="text-sm text-text-primary leading-snug" data-testid="routine-report-headline">
          {run.headline}
        </p>
      )}
      {run.reason && (
        <p className="text-xs text-red-400" data-testid="routine-report-reason">
          {run.reason}
        </p>
      )}
      {run.summary && (
        <div className="text-xs">
          <MarkdownRenderer content={run.summary} />
        </div>
      )}
      {run.deck && !viewerUrl && (
        <p className="text-[10px] text-text-tertiary" data-testid="routine-report-viewer-note">
          {viewerNote}
        </p>
      )}
    </div>
  )
}
