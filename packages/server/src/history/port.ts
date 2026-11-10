/**
 * The History port (PRDCT-4321): the conversations this server's own tabs
 * ran, read on its own disk, and a search of their transcripts. Two shapes
 * stand behind it:
 *
 * - the entry's own implementation, which reads what the server's tabs ran
 *   and the transcripts on its disk.
 * - `HistoryPort.none`: a server with nothing behind it, which answers
 *   `CapabilityUnavailable` to both calls.
 *
 * Both calls are asynchronous: they read the disk. A call rejects with the
 * contract's `CapabilityUnavailable`; the handlers turn anything else into it.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  HistorySearchResult,
  HistorySearchScope,
  ServerHistory
} from '@clave/contract/history'

export interface HistoryService {
  readonly list: () => Promise<ServerHistory>
  /** `scopes` is never empty: the handler defaults it to human and agent. */
  readonly search: (request: {
    query: string
    scopes: HistorySearchScope[]
    maxHits?: number
  }) => Promise<HistorySearchResult>
}

const NO_HISTORY = new CapabilityUnavailable({
  capability: 'history',
  message: 'This server keeps no History of its own.'
})

export class HistoryPort extends Context.Tag('@clave/server/History')<
  HistoryPort,
  HistoryService
>() {
  static layer(service: HistoryService): Layer.Layer<HistoryPort> {
    return Layer.succeed(HistoryPort, service)
  }
  static readonly none: HistoryService = {
    list: () => Promise.reject(NO_HISTORY),
    search: () => Promise.reject(NO_HISTORY)
  }
}
