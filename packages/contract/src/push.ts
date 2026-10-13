/**
 * The push channel: one WebSocket per client beside the HTTP API, on the same
 * listener, carrying server events and session streams to the client. The
 * framework has no push transport; this is Clave's own, shaped so it can move
 * upstream later. Every frame is JSON, one object per message, discriminated
 * by `_tag`.
 *
 * The protocol: the client opens the socket and sends `hello` with the token
 * within `HELLO_TIMEOUT_MS`; the server answers `welcome` or closes the socket
 * with one of the codes below. Then the client subscribes to sessions by id
 * and receives their frames until it unsubscribes or the session exits. Server
 * events reach every welcomed client. Terminal bytes travel base64.
 */
import { Schema } from 'effect'
import { ServerEventEnvelope } from './events'
import { Session, SessionStream } from './sessions'
import { ViewRequest } from './views'

export const PUSH_PATH = '/push'
export const PUSH_PROTOCOL = 1
export const HELLO_TIMEOUT_MS = 5_000

/** WebSocket close codes the server uses; 4000 to 4999 are an application's own. */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_MALFORMED = 4002
export const CLOSE_HELLO_TIMEOUT = 4008
export const CLOSE_SERVER_STOPPING = 4010

export const ClientFrame = Schema.Union(
  Schema.TaggedStruct('hello', {
    token: Schema.String,
    /** How the client names itself, for the server's log. */
    client: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct('subscribe', { sessionId: Schema.String }),
  Schema.TaggedStruct('unsubscribe', { sessionId: Schema.String }),
  Schema.TaggedStruct('ping', {})
)
export type ClientFrame = typeof ClientFrame.Type

export const ServerFrame = Schema.Union(
  Schema.TaggedStruct('welcome', {
    serverId: Schema.String,
    protocol: Schema.Literal(PUSH_PROTOCOL)
  }),
  Schema.TaggedStruct('subscribed', { sessionId: Schema.String, session: Session }),
  Schema.TaggedStruct('unsubscribed', { sessionId: Schema.String }),
  Schema.TaggedStruct('stream', { sessionId: Schema.String, stream: SessionStream }),
  Schema.TaggedStruct('exit', { sessionId: Schema.String, code: Schema.Number }),
  Schema.TaggedStruct('event', ServerEventEnvelope.fields),
  /** A refusal that keeps the socket open: an unknown session, a frame out of order. */
  Schema.TaggedStruct('error', {
    sessionId: Schema.optional(Schema.String),
    message: Schema.String
  }),
  Schema.TaggedStruct('pong', {}),
  // ── Lane D (wave 3): the view requests ──
  /** A view request for the window named by its key. Every welcomed peer
   *  receives it and only that window answers, through the
   *  `AnswerViewRequest` command. */
  Schema.TaggedStruct('request', ViewRequest.fields)
)
export type ServerFrame = typeof ServerFrame.Type

export const decodeClientFrame = Schema.decodeUnknownEither(Schema.parseJson(ClientFrame))
export const encodeClientFrame = Schema.encodeSync(Schema.parseJson(ClientFrame))
export const decodeServerFrame = Schema.decodeUnknownEither(Schema.parseJson(ServerFrame))
export const encodeServerFrame = Schema.encodeSync(Schema.parseJson(ServerFrame))
