import type { RoutineRun, RoutineView } from '@clave/contract/routines/model'
import { runTone, type RunTone } from '../../../../../plugins/routine-report/src/run-labels'

/**
 * What a routine's toolbar button says, and the one place that decides it
 * (ADR 0004). The button is the routine's own icon in its colour; one signal
 * at a time on top of it, the way a sidebar row's status slot works
 * (`lib/tab-status.ts`): motion means working, colour means "go look".
 *
 *   working → a ring turns around the icon while a run is in flight
 *   dot     → a still dot in the run's colour while the last run is unseen,
 *             amber while a run waits on the person, red when the
 *             declaration cannot run; none once dismissed or before any run
 *
 * Nothing pulses: a pulse reads as an alarm, and a run that is simply on its
 * way is not one.
 */
export type RoutineBadgeState =
  | 'invalid'
  | 'running'
  | 'waiting'
  | 'ok'
  | 'attention'
  | 'failed'
  | 'seen'
  | 'never'

export type RoutineBadgeTone = Exclude<RunTone, 'none' | 'running'> | 'invalid'

export interface RoutineBadge {
  /** `data-state` on the button: what the tooltip, the tests and a reader of the DOM get. */
  state: RoutineBadgeState
  /** The ring turns around the icon. */
  working: boolean
  /** The still dot on the icon's corner, in this tone; null draws none. */
  dot: RoutineBadgeTone | null
}

type BadgeInput = {
  routine: Pick<RoutineView['routine'], 'invalid'>
  runs: ReadonlyArray<Pick<RoutineRun, 'state' | 'seen'>>
}

export function routineBadge(view: BadgeInput): RoutineBadge {
  if (view.routine.invalid) return { state: 'invalid', working: false, dot: 'invalid' }
  const last = view.runs[0]
  if (!last) return { state: 'never', working: false, dot: null }
  const tone = runTone(last as RoutineRun)
  if (tone === 'running') return { state: 'running', working: true, dot: null }
  if (tone === 'waiting') return { state: 'waiting', working: false, dot: 'waiting' }
  if (last.seen) return { state: 'seen', working: false, dot: null }
  return { state: last.state, working: false, dot: tone === 'none' ? null : tone }
}

/** The terminal palette's hex, taken down to read as an icon's ink on the
 *  toolbar and in the panel's header; undefined leaves the bar's own resting
 *  colour. */
export function routineInk(hex: string | undefined): string | undefined {
  if (!hex) return undefined
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgb(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)})`
}
