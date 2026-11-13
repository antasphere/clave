/**
 * The History domain's handlers (PRDCT-4321). The search's scopes are checked
 * here, before the port sees them: a scope the contract does not name is
 * dropped, and none left reads as human and agent; an empty list of ids reads
 * as none named, every listed conversation. What the port throws or
 * rejects with becomes the declared failure, never a 500.
 */
import { Effect, Schema } from 'effect'
import { QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { HistorySearchScope, ListServerHistory, SearchServerHistory } from '@clave/contract/history'
import { HistoryPort } from './port'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({ capability: 'history', message: messageOf(error) })

/** What a search reads when it names no scope the contract knows. */
const DEFAULT_SCOPES: HistorySearchScope[] = ['human', 'agent']

const isScope = Schema.is(HistorySearchScope)

const scopesOf = (asked: ReadonlyArray<string> | undefined): HistorySearchScope[] => {
  const known = (asked ?? []).filter(isScope)
  return known.length > 0 ? known : DEFAULT_SCOPES
}

/** The conversations a search names (PRDCT-4321); none left after the split
 *  (`ids=` or only commas) reads as absent: every listed conversation. */
const idsOf = (asked: ReadonlyArray<string> | undefined): string[] | undefined => {
  const ids = (asked ?? []).filter((id) => id.length > 0)
  return ids.length > 0 ? ids : undefined
}

export const historyHandlers = [
  QueryHandler.make(ListServerHistory, () =>
    Effect.flatMap(HistoryPort, (port) =>
      Effect.tryPromise({ try: () => port.list(), catch: unavailable })
    )
  ),
  QueryHandler.make(SearchServerHistory, (payload) =>
    Effect.flatMap(HistoryPort, (port) => {
      const ids = idsOf(payload.ids)
      return Effect.tryPromise({
        try: () =>
          port.search({
            query: payload.query,
            scopes: scopesOf(payload.scopes),
            ...(payload.maxHits !== undefined && { maxHits: payload.maxHits }),
            ...(ids !== undefined && { ids })
          }),
        catch: unavailable
      })
    })
  )
] as const
