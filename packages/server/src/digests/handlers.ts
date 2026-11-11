/**
 * The digests domain on the server (PRDCT-4327): each command and query one
 * call on the port. A read that could not be made comes back as the port's
 * `ok: false` answer, with its reason; what the port THROWS is the server
 * saying it cannot read digests at all, `CapabilityUnavailable`.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  GetExchangeDigests,
  GetPageTitles,
  GetSpokenRenderings,
  GetWorkDigests,
  ReadExchangeDigest,
  ReadPageTitle,
  ReadSpokenRendering,
  ReadWorkDigest
} from '@clave/contract/digests'
import { DigestsPort, type DigestsService } from './port'

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({
        capability: 'digests',
        message: error instanceof Error && error.message ? error.message : String(error)
      })

const call = <A>(
  run: (port: DigestsService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable, DigestsPort> =>
  Effect.flatMap(DigestsPort, (port) =>
    Effect.tryPromise({ try: async () => run(port), catch: unavailable })
  )

export const digestHandlers = [
  CommandHandler.make(ReadExchangeDigest, (p) =>
    call((d) => d.exchangeDigest({ sessionId: p.sessionId, key: p.key, messages: p.messages }))
  ),
  QueryHandler.make(GetExchangeDigests, (p) => call((d) => d.exchangeDigestsOf(p.sessionId))),
  CommandHandler.make(ReadWorkDigest, (p) =>
    call((d) =>
      d.workDigest({ sessionId: p.sessionId, key: p.key, notes: p.notes, tools: p.tools })
    )
  ),
  QueryHandler.make(GetWorkDigests, (p) => call((d) => d.workDigestsOf(p.sessionId))),
  CommandHandler.make(ReadSpokenRendering, (p) =>
    call((d) => d.spoken({ sessionId: p.sessionId, key: p.key, markdown: p.markdown }))
  ),
  QueryHandler.make(GetSpokenRenderings, (p) => call((d) => d.spokenOf(p.sessionId))),
  CommandHandler.make(ReadPageTitle, (p) =>
    call((d) => d.pageTitle({ sessionId: p.sessionId, key: p.key, message: p.message }))
  ),
  QueryHandler.make(GetPageTitles, (p) => call((d) => d.pageTitlesOf(p.sessionId)))
] as const
