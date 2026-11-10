/**
 * The History domain of the client (PRDCT-4321): the conversations a
 * server's tabs ran, and a search of their transcripts. A server released
 * before the domain answers its routes with the router's 404, which reaches
 * the caller as `HistoryMissing`, so a Mac can tell an older server (no
 * History to list beside its own) from one that cannot be reached.
 */
import type {
  HistorySearchResult,
  HistorySearchScope,
  ServerHistory
} from '@clave/contract/history'
import { Schema } from 'effect'
import { NotFoundProblem } from '@structure-ai/http'
import type { Call } from './call'

/** The server answered, without the History domain: a release before it. */
export class HistoryMissing extends Error {
  readonly _tag = 'HistoryMissing'
  constructor(readonly url: string) {
    super(`Clave's server at ${url} has no History route: it is older than this app`)
    this.name = 'HistoryMissing'
  }
}

export interface HistoryClient {
  readonly list: () => Promise<ServerHistory>
  /** No scope reads human and agent, the server's default. */
  readonly search: (request: {
    query: string
    scopes?: HistorySearchScope[]
    maxHits?: number
  }) => Promise<HistorySearchResult>
}

/** The router's own "route not found": the History domain declares no 404 of
 *  its own, so a 404 on its routes is a server without them. */
const routeMissing = (error: unknown): boolean =>
  error instanceof Error && Schema.is(NotFoundProblem)(error.cause)

/** `searchCall` carries the search under a longer deadline than the list's:
 *  the server reads transcripts for up to twenty seconds before it answers. */
export const historyClient = (call: Call, url: string, searchCall: Call = call): HistoryClient => {
  const missing = <T>(run: Promise<T>): Promise<T> =>
    run.catch((error: unknown) => {
      throw routeMissing(error) ? new HistoryMissing(url) : error
    })
  return {
    list: () => missing(call((c) => c.history.list({ payload: {} }))),
    // A GET carries the scopes comma-joined and its numbers as strings (the contract says why).
    search: (request) =>
      missing(
        searchCall((c) =>
          c.history.search({
            payload: {
              query: request.query,
              ...(request.scopes !== undefined &&
                request.scopes.length > 0 && { scopes: request.scopes.join(',') }),
              ...(request.maxHits !== undefined && { maxHits: String(request.maxHits) })
            }
          })
        )
      )
  }
}
