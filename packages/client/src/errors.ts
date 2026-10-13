/**
 * How the server's absence and refusals reach a caller. Lane F's rule, from
 * the wave: an unreachable server is an error the caller sees, never a quiet
 * fallback to anything else.
 */
export class ServerUnreachable extends Error {
  readonly _tag = 'ServerUnreachable'
  constructor(
    readonly url: string,
    cause: unknown
  ) {
    super(`Clave's server at ${url} did not answer`, { cause })
    this.name = 'ServerUnreachable'
  }
}

/** The server answered and said no to the token. */
export class ServerRefused extends Error {
  readonly _tag = 'ServerRefused'
  constructor(
    readonly url: string,
    readonly status: number
  ) {
    super(`Clave's server at ${url} refused the token (${status})`)
    this.name = 'ServerRefused'
  }
}
