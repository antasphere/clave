import type { RoutineView } from '@clave/contract/routines/model'
import { latestRun } from '../../store/routines-store'
import { stateLabel, whenLabel } from '../../../../../plugins/routine-report/src/run-labels'

/** The badge's tooltip: the name, the last run and the next one. */
export function routineTitle(view: RoutineView): string {
  const last = latestRun(view)
  const parts = [view.routine.name]
  if (last) parts.push(`last run ${whenLabel(last.startedAt)}, ${stateLabel(last).toLowerCase()}`)
  if (view.nextRunAt) parts.push(`next ${whenLabel(view.nextRunAt)}`)
  if (view.routine.invalid) parts.push(`cannot run: ${view.routine.invalid}`)
  return parts.join(' · ')
}
