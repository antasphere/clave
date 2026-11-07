/**
 * The server domain of the client (issue #266): the version a server runs
 * and its self-upgrade. A server released before the domain answers its
 * routes with the router's 404, which reaches the caller as
 * `ServerInfoMissing`, so a Mac can tell an older server (one manual run of
 * the install script) from one that cannot be reached.
 */
import type {
  ServerInfo,
  ServerUpgradeRequest,
  ServerUpgradeStatus
} from '@clave/contract/server-info'
import { Schema } from 'effect'
import { NotFoundProblem } from '@structure-ai/http'
import type { Call } from './call'

/** The server answered, without the server domain: a release before it. */
export class ServerInfoMissing extends Error {
  readonly _tag = 'ServerInfoMissing'
  constructor(readonly url: string) {
    super(`Clave's server at ${url} has no version route: it is older than this app`)
    this.name = 'ServerInfoMissing'
  }
}

export interface ServerInfoClient {
  readonly info: () => Promise<ServerInfo>
  readonly upgrade: (request: ServerUpgradeRequest) => Promise<ServerUpgradeStatus>
}

/** The router's own "route not found": the server domain declares no 404 of
 *  its own, so a 404 on its routes is a server without them. */
const routeMissing = (error: unknown): boolean =>
  error instanceof Error && Schema.is(NotFoundProblem)(error.cause)

export const serverInfoClient = (call: Call, url: string): ServerInfoClient => {
  const missing = <T>(run: Promise<T>): Promise<T> =>
    run.catch((error: unknown) => {
      throw routeMissing(error) ? new ServerInfoMissing(url) : error
    })
  return {
    info: () => missing(call((c) => c.server.info({ payload: {} }))),
    upgrade: (request) => missing(call((c) => c.server.upgrade({ payload: request })))
  }
}
