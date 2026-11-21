/**
 * The relay (decision 4 of the mobile spec, lane E of the mobile wave):
 * the directory of a person's machines and the road from their phone to
 * them. Every Clave server signed in to Antasphere connects to the relay
 * outbound and stays connected; a phone holding a bearer of the hub lists
 * the machines of its own subject and reaches one through the relay, which
 * carries its HTTP requests and tunnels its push socket to the machine's
 * own listener. The relay keeps connection state and nothing else: no
 * session, no history, no secret, no token of a server, no body beyond the
 * frames in flight.
 *
 * Two roads meet here, and this module is their one definition:
 *
 *  - the person's road (the phone, lane C's `RelayMachineSource`, lane D's
 *    enrollment): `POST /machines/claim` with the owner's hub bearer answers
 *    a machine credential once; `GET /machines` lists that subject's
 *    machines; `POST /machines/forget` drops one; `GET /health` is open;
 *    `<relay>/m/<machineId>/<path>` is forwarded to the machine as it is,
 *    the `Authorization` of the device session included, so the machine's
 *    own listener authenticates the caller and the relay only routes;
 *    `WS <relay>/m/<machineId>/push` is the machine's push channel, tunnelled.
 *  - the machine's road (`packages/server/src/relay/client.ts`): one
 *    WebSocket to `/machines/connect`, the first frame a `hello` carrying the
 *    credential and the record, then the frames below in both directions.
 *
 * Every frame is JSON, one object per message, discriminated by `_tag`, the
 * push channel's convention (`push.ts`). Bodies travel base64.
 */
import { Schema } from 'effect'

export const RELAY_PROTOCOL = 1

/** The machine's control socket. */
export const RELAY_CONNECT_PATH = '/machines/connect'
/** A person claims a machine credential, lists and forgets their machines. */
export const RELAY_CLAIM_PATH = '/machines/claim'
export const RELAY_MACHINES_PATH = '/machines'
export const RELAY_FORGET_PATH = '/machines/forget'
/** Open: says the relay is live, how many machines it knows and how many are online. */
export const RELAY_HEALTH_PATH = '/health'
/** `/m/<machineId>/<path>`: the phone's road to one machine. */
export const RELAY_MACHINE_PREFIX = '/m/'
/** The one path under a machine that is a WebSocket: its push channel. */
export const RELAY_PUSH_PATH = '/push'

/** A machine has this long to say hello once its socket is open. */
export const RELAY_HELLO_TIMEOUT_MS = 5_000
/** The relay pings every connected machine this often. */
export const RELAY_PING_MS = 25_000
/** A machine that sent nothing for this long is offline and its socket is ended. */
export const RELAY_OFFLINE_MS = 60_000
/** A forwarded request's body is bounded; beyond this the relay answers 413. */
export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024
/** A response of known length up to this size travels in one `response`
 *  frame; a longer or unknown one is streamed as head, chunks and end. */
export const RELAY_STREAM_THRESHOLD_BYTES = 64 * 1024
/** Per machine: open tunnels, and requests in flight. */
export const RELAY_MAX_TUNNELS = 64
export const RELAY_MAX_REQUESTS = 256
/** A forwarded request the machine has not finished answering by then is a 504. */
export const RELAY_REQUEST_TIMEOUT_MS = 120_000
/** One frame on the control socket, at most: the largest body, base64, and its headers. */
export const RELAY_MAX_FRAME_BYTES = 16 * 1024 * 1024
/** How long the relay remembers which subject a hub bearer names. */
export const RELAY_AUTH_CACHE_MS = 10 * 60_000

/** Close codes on the control socket; 4000 to 4999 are an application's own. */
export const RELAY_CLOSE_UNAUTHORIZED = 4001
export const RELAY_CLOSE_MALFORMED = 4002
export const RELAY_CLOSE_HELLO_TIMEOUT = 4008
/** A newer socket of the same machine arrived; the older one is closed with this. */
export const RELAY_CLOSE_REPLACED = 4009
export const RELAY_CLOSE_STOPPING = 4010
/** Nothing heard from the machine for `RELAY_OFFLINE_MS`. */
export const RELAY_CLOSE_SILENT = 4011
/** The owner forgot the machine while it was connected. */
export const RELAY_CLOSE_FORGOTTEN = 4012

export const MachinePlatform = Schema.Literal('macos', 'linux')
export type MachinePlatform = typeof MachinePlatform.Type

/** An address the machine listens on that a phone may try before the relay. */
export const DirectAddress = Schema.Struct({ url: Schema.String })
export type DirectAddress = typeof DirectAddress.Type

/** What a machine says of itself: at the claim, and again at every connect. */
export const MachineRecord = Schema.Struct({
  name: Schema.String,
  platform: MachinePlatform,
  version: Schema.String,
  direct: Schema.Array(DirectAddress)
})
export type MachineRecord = typeof MachineRecord.Type

/** `POST /machines/claim`, with the owner's hub bearer: the record in, the
 *  credential out, once; the relay keeps the secret as a hash. */
export const ClaimMachine = MachineRecord
export const MachineCredential = Schema.Struct({
  machineId: Schema.String,
  machineSecret: Schema.String
})
export type MachineCredential = typeof MachineCredential.Type

/** One row of `GET /machines`: the record, whether the machine is connected
 *  now, and when it was last heard from (epoch milliseconds, the relay's clock). */
export const MachineView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  platform: MachinePlatform,
  version: Schema.String,
  online: Schema.Boolean,
  lastSeen: Schema.NullOr(Schema.Number),
  direct: Schema.Array(DirectAddress)
})
export type MachineView = typeof MachineView.Type
export const MachineList = Schema.Struct({ machines: Schema.Array(MachineView) })
export type MachineList = typeof MachineList.Type

/** `POST /machines/forget`, by the owner. */
export const ForgetMachine = Schema.Struct({ machineId: Schema.String })
export type ForgetMachine = typeof ForgetMachine.Type

export const RelayHealth = Schema.Struct({
  status: Schema.Literal('live'),
  machines: Schema.Number,
  online: Schema.Number
})
export type RelayHealth = typeof RelayHealth.Type

/** HTTP headers as they travel in a frame, lowercased names; a header that
 *  appears more than once (`set-cookie`) is an array. */
export const RelayHeaders = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Array(Schema.String))
})
export type RelayHeaders = typeof RelayHeaders.Type

/** What a machine sends the relay. */
export const MachineFrame = Schema.Union(
  Schema.TaggedStruct('hello', {
    machineId: Schema.String,
    machineSecret: Schema.String,
    record: MachineRecord
  }),
  Schema.TaggedStruct('pong', {}),
  /** The whole answer to a `request`, its body base64. */
  Schema.TaggedStruct('response', {
    id: Schema.String,
    status: Schema.Number,
    headers: RelayHeaders,
    body: Schema.String
  }),
  /** A streamed answer: the head, then chunks (base64), then the end. */
  Schema.TaggedStruct('response-head', {
    id: Schema.String,
    status: Schema.Number,
    headers: RelayHeaders
  }),
  Schema.TaggedStruct('response-chunk', { id: Schema.String, data: Schema.String }),
  Schema.TaggedStruct('response-end', { id: Schema.String }),
  /** The machine could not perform the request, or lost it halfway. */
  Schema.TaggedStruct('response-error', { id: Schema.String, message: Schema.String }),
  /** A message from the machine's push channel to the phone, base64; text unless `binary`. */
  Schema.TaggedStruct('tunnel-data', {
    tunnelId: Schema.String,
    data: Schema.String,
    binary: Schema.optional(Schema.Boolean)
  }),
  Schema.TaggedStruct('tunnel-close', {
    tunnelId: Schema.String,
    code: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String)
  })
)
export type MachineFrame = typeof MachineFrame.Type

/** What the relay sends a machine. */
export const RelayFrame = Schema.Union(
  Schema.TaggedStruct('welcome', {
    machineId: Schema.String,
    protocol: Schema.Literal(RELAY_PROTOCOL)
  }),
  Schema.TaggedStruct('ping', {}),
  /** A phone's request, to be performed against the machine's own listener;
   *  `path` carries the query, `body` is base64. */
  Schema.TaggedStruct('request', {
    id: Schema.String,
    method: Schema.String,
    path: Schema.String,
    headers: RelayHeaders,
    body: Schema.String
  }),
  /** The phone went away before the answer: the machine may stop. */
  Schema.TaggedStruct('request-abort', { id: Schema.String }),
  /** A phone opened the push channel: the machine opens its own socket to
   *  its listener and pipes both ways under this id. */
  Schema.TaggedStruct('tunnel-open', { tunnelId: Schema.String, headers: RelayHeaders }),
  Schema.TaggedStruct('tunnel-data', {
    tunnelId: Schema.String,
    data: Schema.String,
    binary: Schema.optional(Schema.Boolean)
  }),
  Schema.TaggedStruct('tunnel-close', {
    tunnelId: Schema.String,
    code: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String)
  }),
  /** A refusal that keeps the socket open: a frame out of order, an unknown id. */
  Schema.TaggedStruct('error', { message: Schema.String })
)
export type RelayFrame = typeof RelayFrame.Type

export const decodeMachineFrame = Schema.decodeUnknownEither(Schema.parseJson(MachineFrame))
export const encodeMachineFrame = Schema.encodeSync(Schema.parseJson(MachineFrame))
export const decodeRelayFrame = Schema.decodeUnknownEither(Schema.parseJson(RelayFrame))
export const encodeRelayFrame = Schema.encodeSync(Schema.parseJson(RelayFrame))

export const decodeMachineRecord = Schema.decodeUnknownEither(MachineRecord)
export const decodeMachineCredential = Schema.decodeUnknownEither(MachineCredential)
export const decodeMachineList = Schema.decodeUnknownEither(MachineList)
export const decodeForgetMachine = Schema.decodeUnknownEither(ForgetMachine)

/** The machine id in a road path (`/m/<id>/sessions?x=1` gives `<id>` and
 *  `/sessions?x=1`), or null when the path is not a road. The id is one
 *  segment of the characters an id is made of. */
export function parseMachinePath(url: string): { machineId: string; path: string } | null {
  if (!url.startsWith(RELAY_MACHINE_PREFIX)) return null
  const rest = url.slice(RELAY_MACHINE_PREFIX.length)
  const cut = rest.search(/[/?]/)
  const machineId = cut === -1 ? rest : rest.slice(0, cut)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) return null
  const path = cut === -1 ? '/' : rest.slice(cut)
  return { machineId, path: path.startsWith('/') ? path : `/${path}` }
}
