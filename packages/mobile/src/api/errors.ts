import type { ServerFailure } from '../contract/types'

/** Why a call to a Clave server did not answer what was asked. */
export type ServerErrorKind =
  /** 401: the bearer is not this server's. */
  | 'unauthenticated'
  /** 422 with a declared failure: `failure` carries the server's own words. */
  | 'refused'
  /** The request never completed: no route, a reset, an offline phone. */
  | 'network'
  /** The deadline passed before an answer. */
  | 'timeout'
  /** The server answered something this client does not read. */
  | 'protocol'
  /** The address is not one this build sends a credential to (transport-policy.ts). */
  | 'policy'

export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
    readonly options: {
      readonly status?: number
      readonly failure?: ServerFailure
      readonly cause?: unknown
    } = {}
  ) {
    super(message)
    this.name = 'ServerError'
  }

  get status(): number | undefined {
    return this.options.status
  }

  /** The declared failure of a refusal, when there is one. */
  get failure(): ServerFailure | undefined {
    return this.options.failure
  }

  /** `true` when the server said it lacks the part (`CapabilityUnavailable`). */
  get capabilityUnavailable(): boolean {
    return this.options.failure?._tag === 'CapabilityUnavailable'
  }
}

export const isServerError = (error: unknown): error is ServerError => error instanceof ServerError

/** The sentence to show for any error a call threw. */
export function messageOf(error: unknown): string {
  if (error instanceof ServerError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
