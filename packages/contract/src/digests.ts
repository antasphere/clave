/**
 * The digests domain (PRDCT-4327): the one-shot reads a chat view shows on
 * its cards, asked of the server the tab runs on. The EXCHANGE digest says
 * what the reader needs from the messages other tabs sent a session; the
 * WORK digest titles a card of the agent's working notes.
 *
 * - `ReadExchangeDigest` / `ReadWorkDigest`: the digest of these messages or
 *   notes, the one filed for their key or a call read now. The payload names
 *   the session and the content, and NOTHING about the launch: the server
 *   reads the digest on the agent and the account of its own record of that
 *   session, because a client's account ids mean nothing on the server. A
 *   field the schema does not name is dropped on the wire.
 * - `GetExchangeDigests` / `GetWorkDigests`: every digest the server filed
 *   for a session, by key: what a tab shows on opening, the same for every
 *   client of that server.
 *
 * A read that could not be made is an answer, not a failure of the call:
 * `ok: false` with the class of the reason (`timeout | auth | limit |
 * unreadable | cancelled | disabled | failed`), which the card says.
 */
import { Option, Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

export const DIGEST_FAILURE_REASONS = [
  'timeout',
  'auth',
  'limit',
  'unreadable',
  'cancelled',
  'disabled',
  'failed',
  // The host's and the client's own (PRDCT-4327): no record of the tab, too
  // many reads waiting for it, a server without the digests.
  'unknown-session',
  'busy',
  'outdated'
] as const
export type DigestFailureReason = (typeof DIGEST_FAILURE_REASONS)[number]
const isReason = (value: unknown): value is DigestFailureReason =>
  (DIGEST_FAILURE_REASONS as readonly unknown[]).includes(value)

/** A reason this Mac does not know (a newer server's) reads as absent, so
 *  the rest of the answer still decodes. */
const reason = Schema.optionalToOptional(Schema.String, Schema.Literal(...DIGEST_FAILURE_REASONS), {
  decode: (value) => Option.filter(value, isReason),
  encode: (value) => value
})

const NotRead = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  reason
})

export const DigestMessage = Schema.Struct({
  from: Schema.String,
  text: Schema.String,
  request: Schema.optional(Schema.String),
  reply: Schema.optional(Schema.String)
})

export const ExchangeDigestDone = Schema.Struct({
  ok: Schema.Literal(true),
  needsYou: Schema.Boolean,
  summary: Schema.String,
  message: Schema.NullOr(Schema.Number)
})
export const ExchangeDigestResult = Schema.Union(ExchangeDigestDone, NotRead)
export type ExchangeDigestResult = typeof ExchangeDigestResult.Type

export const WorkDigestDone = Schema.Struct({
  ok: Schema.Literal(true),
  title: Schema.String,
  needsYou: Schema.Boolean,
  note: Schema.NullOr(Schema.Number)
})
export const WorkDigestResult = Schema.Union(WorkDigestDone, NotRead)
export type WorkDigestResult = typeof WorkDigestResult.Type

export const ReadExchangeDigest = Command.define('ReadExchangeDigest', {
  payload: Schema.Struct({
    sessionId: Schema.String,
    key: Schema.String,
    messages: Schema.Array(DigestMessage)
  }),
  success: ExchangeDigestResult,
  failure: CapabilityUnavailable
})

export const GetExchangeDigests = Query.define('GetExchangeDigests', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Record({ key: Schema.String, value: ExchangeDigestDone }),
  failure: CapabilityUnavailable
})

export const ReadWorkDigest = Command.define('ReadWorkDigest', {
  payload: Schema.Struct({
    sessionId: Schema.String,
    key: Schema.String,
    notes: Schema.Array(Schema.String),
    tools: Schema.Number
  }),
  success: WorkDigestResult,
  failure: CapabilityUnavailable
})

export const GetWorkDigests = Query.define('GetWorkDigests', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Record({ key: Schema.String, value: WorkDigestDone }),
  failure: CapabilityUnavailable
})

export type ExchangeDigestRead = typeof ReadExchangeDigest.payload.Type
export type WorkDigestRead = typeof ReadWorkDigest.payload.Type

export const digestsGroup = ApiGroup.make('digests')
  .add(HttpCqrs.commandEndpoint('exchange', '/digests/exchange', ReadExchangeDigest))
  .add(HttpCqrs.queryEndpoint('exchangesOf', '/digests/exchanges-of', GetExchangeDigests))
  .add(HttpCqrs.commandEndpoint('work', '/digests/work', ReadWorkDigest))
  .add(HttpCqrs.queryEndpoint('workOf', '/digests/work-of', GetWorkDigests))
