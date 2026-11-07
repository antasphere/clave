import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { RequestSnapshot, ResolveRequestInput } from '../../../contract/src/requests'

export interface RequestsService {
  readonly snapshot: () => RequestSnapshot
  readonly resolve: (input: ResolveRequestInput) => Promise<{ accepted: boolean }>
  readonly subscribe: (listener: (revision: number) => void) => () => void
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
    subscribe: () => () => {}
  }
}
