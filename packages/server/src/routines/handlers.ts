/**
 * The routines domain on the buses (ADR 0004): one handler per command and
 * query of `@clave/contract/routines`, each a call on the port. A thrown
 * `CapabilityUnavailable` is that declared failure where the contract has
 * it; a `RoutineReportRefusal` is `RoutineReportRefused` with its errors; a
 * plain `Error` is the scheduler's refusal, `RoutineRefused`, in the words
 * the window shows; anything else is a defect.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  DismissRoutineRun,
  GetRoutineDeck,
  ListRoutines,
  OpenRoutineDiscussion,
  ReportRoutineRun,
  RoutineRefused,
  RoutineReportRefused,
  RunRoutineNow
} from '@clave/contract/routines'
import { Routines, type RoutinesService } from './port'

const refused = (error: unknown): RoutineRefused =>
  new RoutineRefused({ message: error instanceof Error ? error.message : String(error) })

const call = <A>(
  run: (routines: RoutinesService) => A | Promise<A>
): Effect.Effect<A, RoutineRefused, Routines> =>
  Effect.flatMap(Routines, (routines) =>
    Effect.tryPromise({
      try: async () => await run(routines),
      catch: refused
    })
  )

export const routineHandlers = [
  QueryHandler.make(ListRoutines, () =>
    Effect.flatMap(Routines, (routines) => Effect.promise(async () => await routines.list()))
  ),
  QueryHandler.make(GetRoutineDeck, (p) => call((r) => r.deck(p.runId))),
  CommandHandler.make(RunRoutineNow, (p) => call((r) => r.runNow(p.key))),
  CommandHandler.make(DismissRoutineRun, (p) => call((r) => r.dismiss(p.runId))),
  CommandHandler.make(ReportRoutineRun, (p) =>
    Effect.flatMap(Routines, (routines) =>
      Effect.tryPromise({
        try: () =>
          routines.report({
            sessionId: p.sessionId,
            status: p.status,
            headline: p.headline,
            summary: p.summary,
            data: p.data
          }),
        // A refusal carries its `errors` list (the shape of `RoutineReportRefusal`,
        // whichever module defined the class: the implementation lives in the
        // process that runs the server and must not load this package at boot).
        catch: (error) =>
          new RoutineReportRefused({
            message: error instanceof Error ? error.message : String(error),
            errors: Array.isArray((error as { errors?: unknown }).errors)
              ? [...(error as { errors: unknown[] }).errors.map(String)]
              : []
          })
      })
    )
  ),
  CommandHandler.make(OpenRoutineDiscussion, (p) =>
    call((r) => r.openDiscussion(p.runId, p.windowKey, p.mode))
  )
]
