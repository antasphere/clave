/** The routines group of the HTTP API implemented (ADR 0004), every endpoint
 *  of `@clave/contract/routines` through the CQRS bridge. */
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import * as R from '@clave/contract/routines'

export const RoutinesLive = HttpApiBuilder.group(ClaveApi, 'routines', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(R.ListRoutines))
    .handle('deck', HttpCqrs.query(R.GetRoutineDeck))
    .handle('runNow', HttpCqrs.command(R.RunRoutineNow))
    .handle('dismiss', HttpCqrs.command(R.DismissRoutineRun))
    .handle('report', HttpCqrs.command(R.ReportRoutineRun))
    .handle('discussion', HttpCqrs.command(R.OpenRoutineDiscussion))
    .handle('create', HttpCqrs.command(R.CreateRoutine))
    .handle('update', HttpCqrs.command(R.UpdateRoutine))
    .handle('delete', HttpCqrs.command(R.DeleteRoutine))
    .handle('pause', HttpCqrs.command(R.PauseRoutine))
    .handle('moveToFile', HttpCqrs.command(R.MoveRoutineToFile))
)
