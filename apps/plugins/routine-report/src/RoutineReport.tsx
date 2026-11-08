import { useEffect, useState } from 'react'
import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import { durationLabel, runTone, stateLabel, whenLabel } from './run-labels'
import { RoutineDrawing } from './RoutineDrawing'
import { RunGlyph } from './RunGlyph'
import { TroubleCard } from './RoutineTrouble'
import { failedRunTrouble } from './trouble'
import { PageGuest } from '../../../desktop/src/renderer/src/components/layout/PageGuest'
import { MarkdownRenderer } from '../../../desktop/src/renderer/src/components/files/MarkdownRenderer'

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
  viewerNote,
  ready = true
}: {
  view: RoutineView | undefined
  run: RoutineRun | undefined
  viewerUrl: string | null
  viewerNote: string
  /** Whether the host has settled (its own motion done): the deck's web view
   *  is mounted only then, the veil standing in before. */
  ready?: boolean
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
    return (
      <DeckGuest key={src} src={src} title={run.headline ?? view?.routine.name} ready={ready} />
    )
  }
  const tone = runTone(run)
  const meta = `${whenLabel(run.startedAt)} · ${durationLabel(run)} · ${run.trigger}`
  if (tone === 'running' || tone === 'waiting') {
    return (
      <div className="routine-state" data-testid="routine-report-card" data-tone={tone}>
        <RunGlyph tone={tone} size="lg" />
        <strong data-testid="routine-report-state">{stateLabel(run)}</strong>
        <span>
          {tone === 'running'
            ? 'The report lands here when the agent is done.'
            : 'The agent asked something. Answer it in Discussion.'}
        </span>
        <span className="routine-meta">{meta}</span>
      </div>
    )
  }
  // A run that failed before any report: the trouble card, never red text.
  if (tone === 'failed' && !run.summary) {
    return (
      <TroubleCard
        trouble={failedRunTrouble(run.reason, run.headline)}
        meta={meta}
        testId="routine-report-card"
      />
    )
  }
  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto h-full" data-testid="routine-report-card">
      <div className="flex items-center gap-2">
        {tone !== 'none' && <RunGlyph tone={tone} />}
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
        <details className="routine-details" data-testid="routine-report-reason">
          <summary>Details</summary>
          <pre>{run.reason}</pre>
        </details>
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

/** The deck in the page guest, invisible until it has painted. Seen frame by
 *  frame on 6 November 2026: a web view's guest is composited above every
 *  DOM sibling, so a veil over it hides nothing once the guest has a frame;
 *  and unmounting that veil re-embedded the guest, which dropped a frame
 *  (the deck visible at 604 ms, the body blank at 716 ms, the deck back at
 *  819 ms). So the guest carries its own opacity, 0 until its first load
 *  plus a beat for the first frame to land, then a 200 ms fade; the
 *  placeholder sits UNDER it and stays mounted, hidden once the deck shows,
 *  so the layer tree never changes. The guest is mounted only once the host
 *  has settled (`ready`). Keyed by its source from the caller, so a new
 *  run's deck starts hidden again. */
function DeckGuest({
  src,
  title,
  ready
}: {
  src: string
  title?: string
  ready: boolean
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => setShown(true), 120)
    return () => clearTimeout(t)
  }, [loaded])
  return (
    <div
      className="relative flex-1 min-h-0 h-full"
      data-testid="routine-report-deck"
      data-shown={shown ? 'true' : undefined}
    >
      <div
        className="routine-veil"
        style={{ visibility: shown ? 'hidden' : 'visible' }}
        aria-hidden={shown ? true : undefined}
        data-testid="routine-report-veil"
      >
        <div className="routine-state">
          <RunGlyph tone="running" size="lg" label="Opening the report" />
          <strong>Opening the report</strong>
        </div>
      </div>
      {ready && (
        <PageGuest
          src={src}
          title={title}
          onFirstLoad={() => setLoaded(true)}
          theme
          className={`transition-opacity duration-200 ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  )
}
