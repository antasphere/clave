/** The routines group of the HTTP API (ADR 0004): apart from the model so a
 *  renderer that reads the types never pulls the HTTP framework's sources. */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  CreateRoutine,
  DeleteRoutine,
  DismissRoutineRun,
  GetRoutineDeck,
  ListRoutines,
  MoveRoutineToFile,
  OpenRoutineDiscussion,
  PauseRoutine,
  ReportRoutineRun,
  RunRoutineNow,
  UpdateRoutine
} from './model'

export const routinesGroup = ApiGroup.make('routines')
  .add(HttpCqrs.queryEndpoint('list', '/routines', ListRoutines))
  .add(HttpCqrs.queryEndpoint('deck', '/routines/deck', GetRoutineDeck))
  .add(HttpCqrs.commandEndpoint('runNow', '/routines/run-now', RunRoutineNow))
  .add(HttpCqrs.commandEndpoint('dismiss', '/routines/dismiss', DismissRoutineRun))
  .add(HttpCqrs.commandEndpoint('report', '/routines/report', ReportRoutineRun))
  .add(HttpCqrs.commandEndpoint('discussion', '/routines/discussion', OpenRoutineDiscussion))
  // PRDCT-4242: the routines this server keeps in its own store.
  .add(HttpCqrs.commandEndpoint('create', '/routines/create', CreateRoutine))
  .add(HttpCqrs.commandEndpoint('update', '/routines/update', UpdateRoutine))
  .add(HttpCqrs.commandEndpoint('delete', '/routines/delete', DeleteRoutine))
  .add(HttpCqrs.commandEndpoint('pause', '/routines/pause', PauseRoutine))
  .add(HttpCqrs.commandEndpoint('moveToFile', '/routines/move-to-file', MoveRoutineToFile))
