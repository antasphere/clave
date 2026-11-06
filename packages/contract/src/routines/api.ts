/** The routines group of the HTTP API (ADR 0004): apart from the model so a
 *  renderer that reads the types never pulls the HTTP framework's sources. */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  DismissRoutineRun,
  ListRoutines,
  OpenRoutineDiscussion,
  ReportRoutineRun,
  RunRoutineNow
} from './model'

export const routinesGroup = ApiGroup.make('routines')
  .add(HttpCqrs.queryEndpoint('list', '/routines', ListRoutines))
  .add(HttpCqrs.commandEndpoint('runNow', '/routines/run-now', RunRoutineNow))
  .add(HttpCqrs.commandEndpoint('dismiss', '/routines/dismiss', DismissRoutineRun))
  .add(HttpCqrs.commandEndpoint('report', '/routines/report', ReportRoutineRun))
  .add(HttpCqrs.commandEndpoint('discussion', '/routines/discussion', OpenRoutineDiscussion))
