import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import { durationLabel, runTone, stateLabel, whenLabel } from './run-labels'
import { RoutineDrawing } from './RoutineDrawing'
import { PageGuest } from '../../../src/renderer/src/components/layout/PageGuest'
import { MarkdownRenderer } from '../../../src/renderer/src/components/files/MarkdownRenderer'

/**
 * One run's report: the deck served by the viewer in the hardened page guest;
 * a state view while the run is in flight or waits on the person (the
 * sidebar's spinner, never a pulse); the envelope as a card when a finished
 * run has no deck (no viewer, or failed before any report); and the drawing
 * when nothing ran yet. The same component in the toolbar's panel and in the
 * session view.
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
      <div className="routine-state" data-testid="routine-report-empty">
        {view && <RoutineDrawing />}
        <strong>{view ? 'No run yet' : 'This session is not a routine run'}</strong>
        <span>
          {view
            ? 'The first run lands its report here, on the schedule or on Run now.'
            : 'Only a run a routine started reads as a report.'}
        </span>
      </div>
    )
  }
  if (run.deck && viewerUrl) {
    const src = `${viewerUrl.replace(/\/$/, '')}/${run.deck}`
    return <DeckGuest key={src} src={src} title={run.headline ?? view?.routine.name} />
  }
  const tone = runTone(run)
  const meta = `${whenLabel(run.startedAt)} · ${durationLabel(run)} · ${run.trigger}`
  if (tone === 'running' || tone === 'waiting') {
    return (
      <div className="routine-state" data-testid="routine-report-card" data-tone={tone}>
        {tone === 'running' ? (
          <span className="routine-spinner" aria-hidden="true">
            <span className="sidebar-tab-spinner" />
          </span>
        ) : (
          <span className="routine-dot" data-tone={tone} aria-hidden="true" />
        )}
        <strong data-testid="routine-report-state">{stateLabel(run)}</strong>
        <span>
          {tone === 'running'
            ? 'The agent is on the job; the report lands here when it reports.'
            : 'The agent asked something. Answer it in the discussion, or the run times out.'}
        </span>
        <span className="routine-meta">{meta}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto h-full" data-testid="routine-report-card">
      <div className="flex items-center gap-2">
        <span className="routine-dot" data-tone={tone} aria-hidden="true" />
        <span className="text-xs text-text-secondary" data-testid="routine-report-state">
          {stateLabel(run)}
        </span>
        <span className="routine-meta ml-auto">{meta}</span>
      </div>
      {run.headline && (
        <p className="text-sm text-text-primary leading-snug" data-testid="routine-report-headline">
          {run.headline}
        </p>
      )}
      {run.reason && (
        <p className="text-xs text-destructive" data-testid="routine-report-reason">
          {run.reason}
        </p>
      )}
      {run.summary && (
        <div className="text-xs">
          <MarkdownRenderer content={run.summary} />
        </div>
      )}
      {run.deck && !viewerUrl && (
        <p className="text-xs text-text-tertiary" data-testid="routine-report-viewer-note">
          {viewerNote}
        </p>
      )}
    </div>
  )
}

/** The deck in the page guest, veiled until its first paint: the guest is
 *  blank while the viewer answers, and a blank frame popping into a filled
 *  one is the jolt the veil removes (the way `WebViewPane` holds its notice
 *  over a served page). Keyed by its source from the caller, so a new run's
 *  deck starts veiled again. */
function DeckGuest({ src, title }: { src: string; title?: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative flex-1 min-h-0 h-full" data-testid="routine-report-deck">
      <PageGuest src={src} title={title} onFirstLoad={() => setLoaded(true)} />
      <AnimatePresence>
        {!loaded && (
          <motion.div
            key="veil"
            className="routine-veil"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            data-testid="routine-report-veil"
          >
            <div className="routine-state">
              <span className="routine-spinner" aria-hidden="true">
                <span className="sidebar-tab-spinner" />
              </span>
              <strong>Opening the report</strong>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
