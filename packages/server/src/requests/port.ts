import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  HostedRequestInput,
  PendingRequest,
  RequestResultView,
  RequestSnapshot,
  ResolveRequestInput,
  SetRequestAnswersInput
} from '../../../contract/src/requests'

export interface RequestsService {
  readonly snapshot: () => RequestSnapshot
  readonly resolve: (input: ResolveRequestInput) => Promise<{ accepted: boolean }>
  readonly subscribe: (listener: (revision: number) => void) => () => void
  /** A request an agent tool puts to the person (PRDCT-4157). */
  readonly createHosted: (input: HostedRequestInput) => PendingRequest
  /** Where a request stands for the tool that created it, after waiting up
   *  to `waitMs` (bounded by the service) for the person. */
  readonly resultAfter: (
    requestId: string,
    sessionId: string,
    waitMs?: number
  ) => Promise<RequestResultView>
  /** The agent writes to a form it asked (PRDCT-4157). */
  readonly setAnswers: (input: SetRequestAnswersInput) => Promise<RequestResultView>
}
const missing = (): never => {
  throw new CapabilityUnavailable({
    capability: 'requests',
    message: 'This server has no shared request service.'
  })
}
export class RequestsPort extends Context.Tag('@clave/server/Requests')<
  RequestsPort,
  RequestsService
>() {
  static layer(service: RequestsService): Layer.Layer<RequestsPort> {
    return Layer.succeed(RequestsPort, service)
  }
  static readonly none: RequestsService = {
    snapshot: missing,
    resolve: async () => missing(),
    subscribe: () => () => {},
    createHosted: missing,
    resultAfter: async () => missing(),
    setAnswers: async () => missing()
  }
}
