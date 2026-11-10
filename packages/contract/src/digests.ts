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

/* The bounds of what a client may send (PRDCT-4327). A client clips a
 * timeline before it keys and sends it, and the host clips again
 * (`clipDigestMessages`, `clipNotes` in the app's shared code): the latest
 * 30 messages, each text clipped to 4,000 characters (plus the mark of the
 * cut), the sender's name to 200; the latest 40 notes, each to 600. The
 * bounds follow that clip with a small margin; `digests.test.ts` in the app
 * holds them to it. */
/** The most messages one read may carry. */
export const DIGEST_MAX_MESSAGES = 30
/** The longest a message's text, request or reply may be. */
export const DIGEST_MAX_TEXT = 4_096
/** The longest a sender's name may be. */
export const DIGEST_MAX_FROM = 256
/** The most notes one work card's read may carry. */
export const DIGEST_MAX_NOTES = 40
/** The longest a note may be. */
export const DIGEST_MAX_NOTE = 1_024
const Text = Schema.String.pipe(Schema.maxLength(DIGEST_MAX_TEXT))
const Note = Schema.String.pipe(Schema.maxLength(DIGEST_MAX_NOTE))
const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
/** `digestKey`'s shape: the count, then the hash in base 36. */
export const ExchangeDigestKey = Schema.String.pipe(Schema.pattern(/^\d{1,4}-[0-9a-z]{1,8}$/))
/** `workDigestKey`'s shape. */
export const WorkDigestKey = Schema.String.pipe(Schema.pattern(/^work-\d{1,4}-[0-9a-z]{1,8}$/))

export const DigestMessage = Schema.Struct({
  from: Schema.String.pipe(Schema.maxLength(DIGEST_MAX_FROM)),
  text: Text,
  request: Schema.optional(Text),
  reply: Schema.optional(Text)
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
    sessionId: SessionId,
    key: ExchangeDigestKey,
    messages: Schema.Array(DigestMessage).pipe(Schema.maxItems(DIGEST_MAX_MESSAGES))
  }),
  success: ExchangeDigestResult,
  failure: CapabilityUnavailable
})

export const GetExchangeDigests = Query.define('GetExchangeDigests', {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Record({ key: Schema.String, value: ExchangeDigestDone }),
  failure: CapabilityUnavailable
})

export const ReadWorkDigest = Command.define('ReadWorkDigest', {
  payload: Schema.Struct({
    sessionId: SessionId,
    key: WorkDigestKey,
    notes: Schema.Array(Note).pipe(Schema.maxItems(DIGEST_MAX_NOTES)),
    tools: Schema.Int.pipe(Schema.between(0, 100_000))
  }),
  success: WorkDigestResult,
  failure: CapabilityUnavailable
})

export const GetWorkDigests = Query.define('GetWorkDigests', {
  payload: Schema.Struct({ sessionId: SessionId }),
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
