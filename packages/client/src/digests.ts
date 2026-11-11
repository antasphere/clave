/**
 * The digests domain of the client (PRDCT-4327): a chat view's one-shot reads
 * asked of the server the tab runs on. A read is queued behind the server's
 * other helpers and may take its timeout and a retry, so it runs on the
 * patient deadline. No launch is sent: the server reads its own record.
 *
 * A server that answered without the digests (a release before them: its
 * router's 404; or one with nothing behind the port: `CapabilityUnavailable`)
 * reads as `outdated`, never as a server that did not answer: a read is a
 * result with that reason, the filed digests none (PRDCT-4327).
 */
import type {
  ExchangeDigestRead,
  ExchangeDigestResult,
  WorkDigestRead,
  WorkDigestResult
} from '@clave/contract/digests'
import { Schema } from 'effect'
import { BadRequestProblem, NotFoundProblem } from '@structure-ai/http'
import type { Call } from './call'

type Done<R> = Extract<R, { ok: true }>

export interface DigestsClient {
  readonly exchange: (request: ExchangeDigestRead) => Promise<ExchangeDigestResult>
  readonly exchangesOf: (sessionId: string) => Promise<Record<string, Done<ExchangeDigestResult>>>
  readonly work: (request: WorkDigestRead) => Promise<WorkDigestResult>
  readonly workOf: (sessionId: string) => Promise<Record<string, Done<WorkDigestResult>>>
}

/** The server answered, without the digests. */
export const isDigestsMissing = (error: unknown): boolean =>
  (error instanceof Error && Schema.is(NotFoundProblem)(error.cause)) ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    (error as { capability?: unknown }).capability === 'digests')

/** The server refused what it was sent as invalid (a 400): asking again
 *  sends the same thing, so it reads as `refused`, never as a server that did
 *  not answer. */
export const isDigestRefused = (error: unknown): boolean =>
  error instanceof Error && Schema.is(BadRequestProblem)(error.cause)

const REFUSED = {
  ok: false as const,
  error: 'The server refused the request as invalid',
  reason: 'refused' as const
}

const OUTDATED = {
  ok: false as const,
  error: 'This server has no digests: it needs an update',
  reason: 'outdated' as const
}
const orOutdated = <T>(run: Promise<T>, missing: T, refused: T = missing): Promise<T> =>
  run.catch((error: unknown) => {
    if (isDigestsMissing(error)) return missing
    if (isDigestRefused(error)) return refused
    throw error
  })

export const digestsClient = (call: Call, patientCall: Call = call): DigestsClient => ({
  exchange: ({ sessionId, key, messages }) =>
    orOutdated<ExchangeDigestResult>(
      patientCall((c) => c.digests.exchange({ payload: { sessionId, key, messages } })),
      OUTDATED,
      REFUSED
    ),
  exchangesOf: (sessionId) =>
    orOutdated(
      call((c) => c.digests.exchangesOf({ payload: { sessionId } })),
      {}
    ),
  work: ({ sessionId, key, notes, tools }) =>
    orOutdated<WorkDigestResult>(
      patientCall((c) => c.digests.work({ payload: { sessionId, key, notes, tools } })),
      OUTDATED,
      REFUSED
    ),
  workOf: (sessionId) =>
    orOutdated(
      call((c) => c.digests.workOf({ payload: { sessionId } })),
      {}
    )
})
