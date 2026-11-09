/**
 * The routines port (ADR 0004, PRDCT-4102): what the server needs from
 * whoever runs the scheduler. The implementation is one object built in
 * whichever process runs the server (`src/main/routines/service.ts`: inside
 * Electron main, as the app's separate child, or as a daemon); a server with
 * nothing behind it runs on `Routines.none`, which lists no routines and
 * refuses every act as unavailable rather than pretend to schedule.
 *
 * The methods are plain calls and promises, not Effects: the handlers
 * (`handlers.ts`) are where a thrown error becomes a declared failure. A
 * plain `Error` is the scheduler's refusal in the words the window shows
 * (`RoutineRefused`); an error carrying `errors` is a report the schema
 * refused (`RoutineReportRefused`); a thrown `CapabilityUnavailable` is the
 * server saying it runs no routines.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type * as Contract from '@clave/contract/routines'
import type { Unsubscribe } from '../sessions/port'

export type RoutinesListing = Contract.RoutinesListing
export type RoutineRun = Contract.RoutineRun
export type RoutineStatus = Contract.RoutineStatus
export type RoutinesEvent = Contract.RoutinesEvent

export interface RoutineReportInput {
  readonly sessionId: string
  readonly status: RoutineStatus
  readonly headline: string
  readonly summary: string
  readonly data: unknown
}

/** A report the scheduler would not take, with the schema's errors for the agent. */
export class RoutineReportRefusal extends Error {
  readonly errors: ReadonlyArray<string>
  constructor(message: string, errors: ReadonlyArray<string> = []) {
    super(message)
    this.name = 'RoutineReportRefusal'
    this.errors = errors
  }
}

export interface RoutinesService {
  /** Every routine this server knows, with its runs and where the decks are served. */
  list(): RoutinesListing | Promise<RoutinesListing>
  /** A run outside the schedule; throws while one is in flight. */
  runNow(key: string): Promise<RoutineRun>
  /** The run's badge put away. */
  dismiss(runId: string): void
  /** The agent's report for the run its session is; throws `RoutineReportRefusal`. */
  report(input: RoutineReportInput): Promise<{ runId: string; deck: string }>
  /** A run's filled deck page, for a client that cannot reach this server's
   *  viewer (PRDCT-4149); throws for a run with no deck. */
  deck(runId: string): Promise<{ html: string }>
  /** The run's conversation continued, in the panel or as a tab; answers the session. */
  openDiscussion(
    runId: string,
    windowKey: string,
    mode: 'panel' | 'tab'
  ): Promise<{ sessionId: string }>
  /** Every change: the routines, their next occurrence, their runs. */
  subscribe(listener: (event: RoutinesEvent) => void): Unsubscribe
}

const NO_ROUTINES = new CapabilityUnavailable({
  capability: 'routines',
  message: 'This server runs no routines.'
})

export class Routines extends Context.Tag('@clave/server/Routines')<Routines, RoutinesService>() {
  static layer(service: RoutinesService): Layer.Layer<Routines> {
    return Layer.succeed(Routines, service)
  }
  /** A server with no scheduler behind it: nothing listed, every act refused. */
  static readonly none: RoutinesService = {
    list: () => ({
      routines: [],
      viewer: { url: null, note: NO_ROUTINES.message },
      server: { id: '', name: '' }
    }),
    runNow: () => Promise.reject(NO_ROUTINES),
    deck: () => Promise.reject(NO_ROUTINES),
    dismiss: () => {
      throw NO_ROUTINES
    },
    report: () => Promise.reject(NO_ROUTINES),
    openDiscussion: () => Promise.reject(NO_ROUTINES),
    subscribe: () => () => {}
  }
}
