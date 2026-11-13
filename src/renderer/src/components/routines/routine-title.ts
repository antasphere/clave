import type { RoutineView } from '@clave/contract/routines/model'
import { latestRun } from '../../store/routines-store'
import { stateLabel, whenLabel } from '../../../../../plugins/routine-report/src/run-labels'
import type { RoutineSurface } from './routine-servers'

/** The badge's tooltip: the name, the server that runs it when it is not
 *  this Mac's own, the last run and the next one. */
export function routineTitle(
  view: RoutineView,
  surface?: Pick<RoutineSurface, 'runsOn' | 'reachable' | 'serverName'>
): string {
  const last = latestRun(view)
  const parts = [view.routine.name]
  if (surface?.runsOn === 'server') {
    parts.push(`runs on ${surface.serverName}`)
    if (!surface.reachable) parts.push('not connected')
  }
  if (last) parts.push(`last run ${whenLabel(last.startedAt)}, ${stateLabel(last).toLowerCase()}`)
  if (view.nextRunAt) parts.push(`next ${whenLabel(view.nextRunAt)}`)
  if (view.routine.invalid) parts.push(`cannot run: ${view.routine.invalid}`)
  return parts.join(' · ')
}
