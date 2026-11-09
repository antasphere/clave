/**
 * The routines domain of the client (ADR 0004): the routines a server
 * schedules and their runs. A window lists them for its toolbar, asks for a
 * run by hand, dismisses a run's badge and opens a run's discussion; the
 * agent tools report a run through `report`. A refusal of the scheduler is
 * thrown as the contract's `RoutineRefused`, a refused report as
 * `RoutineReportRefused` with the schema's errors, a server that runs no
 * routines as `CapabilityUnavailable`, like every declared failure.
 */
import type { RoutineRun, RoutineStatus, RoutinesListing } from '@clave/contract/routines'
import type { Call } from './call'

export interface RoutinesClient {
  readonly list: () => Promise<RoutinesListing>
  readonly runNow: (key: string) => Promise<RoutineRun>
  /** A run's filled deck page (PRDCT-4149), for a Mac that cannot reach the server's viewer. */
  readonly deck: (runId: string) => Promise<{ html: string }>
  readonly dismiss: (runId: string) => Promise<void>
  readonly report: (input: {
    sessionId: string
    status: RoutineStatus
    headline: string
    summary: string
    data: unknown
  }) => Promise<{ runId: string; deck: string }>
  readonly openDiscussion: (
    runId: string,
    windowKey: string,
    mode: 'panel' | 'tab'
  ) => Promise<{ sessionId: string }>
}

export const routinesClient = (call: Call): RoutinesClient => ({
  list: () => call((c) => c.routines.list({ payload: {} })),
  runNow: (key) => call((c) => c.routines.runNow({ payload: { key } })),
  deck: (runId) => call((c) => c.routines.deck({ payload: { runId } })),
  dismiss: (runId) => call((c) => c.routines.dismiss({ payload: { runId } })).then(() => undefined),
  report: (input) => call((c) => c.routines.report({ payload: input })),
  openDiscussion: (runId, windowKey, mode) =>
    call((c) => c.routines.discussion({ payload: { runId, windowKey, mode } }))
})
