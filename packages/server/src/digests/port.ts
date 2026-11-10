/**
 * The digests port (PRDCT-4327): what the server needs from whoever runs the
 * one-shot reads. The app's implementation (`src/main/exchange-digest.ts`,
 * `hostDigests`) reads each digest on the launch of the server's OWN record
 * of the session and files it in the server's data folder; a server with
 * nothing behind it runs on `DigestsPort.none`, which refuses every call as
 * unavailable.
 *
 * The requests carry no launch: the contract names none, so nothing a client
 * says about the tab's account can reach the read.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  ExchangeDigestRead,
  ExchangeDigestResult,
  WorkDigestRead,
  WorkDigestResult
} from '@clave/contract/digests'

type Done<R> = Extract<R, { ok: true }>

export interface DigestsService {
  readonly exchangeDigest: (request: ExchangeDigestRead) => Promise<ExchangeDigestResult>
  readonly exchangeDigestsOf: (
    sessionId: string
  ) =>
    | Record<string, Done<ExchangeDigestResult>>
    | Promise<Record<string, Done<ExchangeDigestResult>>>
  readonly workDigest: (request: WorkDigestRead) => Promise<WorkDigestResult>
  readonly workDigestsOf: (
    sessionId: string
  ) => Record<string, Done<WorkDigestResult>> | Promise<Record<string, Done<WorkDigestResult>>>
}

const NO_DIGESTS = new CapabilityUnavailable({
  capability: 'digests',
  message: 'This server reads no digests.'
})
const refuse = (): Promise<never> => Promise.reject(NO_DIGESTS)

export class DigestsPort extends Context.Tag('@clave/server/Digests')<
  DigestsPort,
  DigestsService
>() {
  static layer(service: DigestsService): Layer.Layer<DigestsPort> {
    return Layer.succeed(DigestsPort, service)
  }
  /** A server with no reader behind it: every call says so. */
  static readonly none: DigestsService = {
    exchangeDigest: refuse,
    exchangeDigestsOf: refuse,
    workDigest: refuse,
    workDigestsOf: refuse
  }
}
