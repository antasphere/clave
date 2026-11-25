/**
 * The decisions domain of the client (PRDCT-5179): which projects the tabs
 * of a server work on, asked of that server, which reads them, asks Jev with
 * its own key and keeps each answer on the tab's record. One call may name
 * up to fifty tabs, each read on its own, so it runs on the patient deadline.
 *
 * A server that answered without the decisions (a release before them: its
 * router's 404; or one with nothing behind the port: `CapabilityUnavailable`)
 * is thrown as `DecisionsMissing`, said as the update it needs, never as a
 * server that did not answer.
 */
import type { ReadTabProjectsResult } from '@clave/contract/decisions'
import { Schema } from 'effect'
import { NotFoundProblem } from '@structure-ai/http'
import type { Call } from './call'

export interface DecisionsClient {
  readonly readTabProjects: (sessionIds: ReadonlyArray<string>) => Promise<ReadTabProjectsResult>
}

/** What a server without the decisions is said to need. */
export const DECISIONS_OUTDATED = 'This server asks no decision: it needs an update.'

export class DecisionsMissing extends Error {
  readonly _tag = 'DecisionsMissing'
  constructor() {
    super(DECISIONS_OUTDATED)
    this.name = 'DecisionsMissing'
  }
}

/** The server answered, without the decisions. */
export const isDecisionsMissing = (error: unknown): boolean =>
  (error instanceof Error && Schema.is(NotFoundProblem)(error.cause)) ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    (error as { capability?: unknown }).capability === 'decisions')

export const decisionsClient = (call: Call, patientCall: Call = call): DecisionsClient => ({
  readTabProjects: (sessionIds) =>
    patientCall((c) =>
      c.decisions.readTabProjects({ payload: { sessionIds: [...sessionIds] } })
    ).catch((error: unknown) => {
      throw isDecisionsMissing(error) ? new DecisionsMissing() : error
    })
})
