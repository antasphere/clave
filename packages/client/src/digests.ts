/**
 * The digests domain of the client (PRDCT-4327): a chat view's one-shot reads
 * asked of the server the tab runs on. A read is queued behind the server's
 * other helpers and may take its timeout and a retry, so it runs on the
 * patient deadline. No launch is sent: the server reads its own record.
 */
import type {
  ExchangeDigestRead,
  ExchangeDigestResult,
  WorkDigestRead,
  WorkDigestResult
} from '@clave/contract/digests'
import type { Call } from './call'

type Done<R> = Extract<R, { ok: true }>

export interface DigestsClient {
  readonly exchange: (request: ExchangeDigestRead) => Promise<ExchangeDigestResult>
  readonly exchangesOf: (sessionId: string) => Promise<Record<string, Done<ExchangeDigestResult>>>
  readonly work: (request: WorkDigestRead) => Promise<WorkDigestResult>
  readonly workOf: (sessionId: string) => Promise<Record<string, Done<WorkDigestResult>>>
}

export const digestsClient = (call: Call, patientCall: Call = call): DigestsClient => ({
  exchange: ({ sessionId, key, messages }) =>
    patientCall((c) => c.digests.exchange({ payload: { sessionId, key, messages } })),
  exchangesOf: (sessionId) => call((c) => c.digests.exchangesOf({ payload: { sessionId } })),
  work: ({ sessionId, key, notes, tools }) =>
    patientCall((c) => c.digests.work({ payload: { sessionId, key, notes, tools } })),
  workOf: (sessionId) => call((c) => c.digests.workOf({ payload: { sessionId } }))
})
