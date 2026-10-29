/**
 * The devices domain: a phone paired with a Clave server as its owner's
 * (clave-os, the spec "Clave on the phone", decision 3; issue #281).
 *
 * The server already knows its owner: the Antasphere account signed in on
 * it. A phone proves it is that person's with an ID token the hub issued to
 * the phone's own client id, once, to ask for a pairing; the owner approves
 * or refuses the phone on the Mac (Settings → Mobile); on the approval the
 * server issues the phone a device session, a credential of the server's
 * own, shown once in the pairing's answer and stored hashed. From then on
 * the phone presents it as a bearer on the API and in the push channel's
 * hello frame, within what a phone does and nothing else (the server's
 * `devices/scope.ts`), and the owner revokes it from the same page.
 *
 * Two kinds of caller use this module and the routes tell them apart by
 * their credential: the owner (the server's token) lists, approves, refuses
 * and revokes; a device reads its own record and sets its push token. The
 * pairing routes take no credential at all: the proof is in the body.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

export const DevicePlatform = Schema.Literal('ios', 'android')
export type DevicePlatform = typeof DevicePlatform.Type

const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))
const Version = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))

/** How a phone names itself when it asks to pair. */
export const DeviceDescription = Schema.Struct({
  name: Name,
  platform: DevicePlatform,
  appVersion: Version
})
export type DeviceDescription = typeof DeviceDescription.Type

/** A paired phone as the owner and the phone itself read it: never its
 *  session token, never its push token. */
export const DeviceView = Schema.Struct({
  id: Id,
  name: Name,
  platform: DevicePlatform,
  appVersion: Version,
  /** Epoch milliseconds, the server's clock. */
  createdAt: Schema.Number,
  /** The last authenticated call, recorded at most once a minute; null before the first. */
  lastSeenAt: Schema.NullOr(Schema.Number)
})
export type DeviceView = typeof DeviceView.Type

/** A phone waiting for the owner's word. */
export const PendingPairingView = Schema.Struct({
  id: Id,
  name: Name,
  platform: DevicePlatform,
  appVersion: Version,
  requestedAt: Schema.Number,
  /** When the request lapses unanswered (ten minutes after it was made). */
  expiresAt: Schema.Number
})
export type PendingPairingView = typeof PendingPairingView.Type

export const PairingStatus = Schema.Literal('pending', 'approved', 'refused', 'expired')
export type PairingStatus = typeof PairingStatus.Type

/** The credential a phone gets once, in the one answer that carries it. */
export const DeviceSessionView = Schema.Struct({
  token: Schema.String,
  deviceId: Id,
  serverId: Schema.String,
  serverName: Schema.String
})
export type DeviceSessionView = typeof DeviceSessionView.Type

/** What the owner sees: the paired phones and the ones asking. */
export const DevicesView = Schema.Struct({
  /** Bumped on every change; the `devices.changed` event carries it. */
  revision: Schema.Number,
  devices: Schema.Array(DeviceView),
  pending: Schema.Array(PendingPairingView)
})
export type DevicesView = typeof DevicesView.Type

/** The checks a pairing request may fail, named one at a time and never
 *  with the token: the server says which check refused, nothing of what it read. */
export const PairingRefusal = Schema.Literal(
  'format',
  'algorithm',
  'keys',
  'key',
  'signature',
  'issuer',
  'expired',
  'not-yet-valid',
  'audience',
  'authorized-party',
  'subject',
  'busy'
)
export type PairingRefusal = typeof PairingRefusal.Type

export class DevicePairingRefused extends Schema.TaggedError<DevicePairingRefused>()(
  'DevicePairingRefused',
  { check: PairingRefusal, message: Schema.String }
) {}
/** The pairing is not waiting any more: settled, lapsed, or never known. */
export class DevicePairingNotFound extends Schema.TaggedError<DevicePairingNotFound>()(
  'DevicePairingNotFound',
  { id: Schema.String, message: Schema.String }
) {}
/** No phone with that id is paired here any more. */
export class DeviceNotFound extends Schema.TaggedError<DeviceNotFound>()('DeviceNotFound', {
  id: Schema.String,
  message: Schema.String
}) {}
/** A phone-only route called with the server's own token: there is no device to answer for. */
export class DeviceSessionRequired extends Schema.TaggedError<DeviceSessionRequired>()(
  'DeviceSessionRequired',
  { message: Schema.String }
) {}
export class RelayAddressInvalid extends Schema.TaggedError<RelayAddressInvalid>()(
  'RelayAddressInvalid',
  { message: Schema.String }
) {}

const privately = (message: string): { message: () => { message: string; override: true } } => ({
  message: () => ({ message, override: true })
})

/**
 * `POST /devices/pair`: a phone asks to pair, with the hub's ID token for its
 * own client id and how it names itself. The answer is the pairing to poll;
 * nothing is issued here. The token travels redacted so no validation
 * message echoes it. A server with no Antasphere login refuses every token
 * (`CapabilityUnavailable`); a token that fails a check is refused by that
 * check's name.
 */
export const RequestDevicePairing = Command.define('RequestDevicePairing', {
  payload: Schema.Struct({
    idToken: Schema.Redacted(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384))),
    clientId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
    device: DeviceDescription
  }).annotations(privately('Invalid pairing request.')),
  success: Schema.Struct({ pairingId: Id, expiresAt: Schema.Number }),
  failure: Schema.Union(DevicePairingRefused, CapabilityUnavailable)
})

/**
 * `GET /devices/pair?id=`: where the pairing stands. On `approved` the answer
 * carries the device session exactly once; the next read answers `approved`
 * with no session. An unknown or forgotten pairing reads `expired`.
 */
export const ReadDevicePairing = Query.define('ReadDevicePairing', {
  payload: Schema.Struct({ id: Id }),
  success: Schema.Struct({
    status: PairingStatus,
    deviceSession: Schema.optional(DeviceSessionView)
  })
})

/** `GET /devices`: the owner's list, the paired phones and the ones asking. */
export const ListDevices = Query.define('ListDevices', {
  payload: Schema.Struct({}),
  success: DevicesView
})

/** `POST /devices/approve`: the owner lets the phone in; its session is issued to the waiting pairing. */
export const ApproveDevicePairing = Command.define('ApproveDevicePairing', {
  payload: Schema.Struct({ pairingId: Id }),
  success: DeviceView,
  failure: DevicePairingNotFound
})

/** `POST /devices/refuse`: the owner turns the phone away; the pairing reads `refused`. */
export const RefuseDevicePairing = Command.define('RefuseDevicePairing', {
  payload: Schema.Struct({ pairingId: Id }),
  success: Schema.Void,
  failure: DevicePairingNotFound
})

/** `POST /devices/revoke`: the phone's session ends; its next call is refused and its socket closed. */
export const RevokeDevice = Command.define('RevokeDevice', {
  payload: Schema.Struct({ deviceId: Id }),
  success: Schema.Void,
  failure: DeviceNotFound
})

/** `GET /devices/me`: the phone's own record, by its session. */
export const ReadOwnDevice = Query.define('ReadOwnDevice', {
  payload: Schema.Struct({}),
  success: DeviceView,
  failure: Schema.Union(DeviceSessionRequired, DeviceNotFound)
})

/** `POST /devices/me/push-token`: the phone's push token for the notifications
 *  (APNs for an iPhone, FCM for an Android phone), redacted on the wire. */
export const SetDevicePushToken = Command.define('SetDevicePushToken', {
  payload: Schema.Struct({
    token: Schema.Redacted(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096))),
    platform: DevicePlatform
  }).annotations(privately('Invalid push token.')),
  success: Schema.Void,
  failure: Schema.Union(DeviceSessionRequired, DeviceNotFound)
})

/** `POST /devices/me/push-token/clear`: the phone no longer wants notifications here. */
export const ClearDevicePushToken = Command.define('ClearDevicePushToken', {
  payload: Schema.Struct({}),
  success: Schema.Void,
  failure: Schema.Union(DeviceSessionRequired, DeviceNotFound)
})

/** `GET /devices/relay`: the relay address the owner set (Settings → Mobile), empty when none. */
export const ReadMobileRelay = Query.define('ReadMobileRelay', {
  payload: Schema.Struct({}),
  success: Schema.Struct({ url: Schema.String }),
  failure: CapabilityUnavailable
})

/** `POST /devices/relay`: the relay address, an http(s) origin; empty clears it. */
export const SetMobileRelay = Command.define('SetMobileRelay', {
  payload: Schema.Struct({ url: Schema.String.pipe(Schema.maxLength(2048)) }),
  success: Schema.Struct({ url: Schema.String }),
  failure: Schema.Union(RelayAddressInvalid, CapabilityUnavailable)
})

/** The push event: the devices or the pending pairings changed; a client re-lists. */
export const DevicesChanged = Schema.TaggedStruct('devices.changed', { revision: Schema.Number })

/** The push event a phone's request raises, for the Mac's notification when
 *  no window is focused: the phone's name and platform, never its token. The
 *  shell hears it from whichever process runs the server, so the notice is
 *  the same in process and with the server running apart. */
export const DevicePairingRequested = Schema.TaggedStruct('devices.pairing_requested', {
  pairingId: Id,
  name: Name,
  platform: DevicePlatform
})

/** The WebSocket close code a phone's socket gets when its session is revoked
 *  (4000 to 4999 are an application's own; the others are in `push.ts`). */
export const CLOSE_DEVICE_REVOKED = 4011

/** The path a phone pairs on; the only routes of this module that take no bearer. */
export const DEVICE_PAIR_PATH = '/devices/pair'

export const devicesGroup = ApiGroup.make('devices')
  .add(
    HttpCqrs.commandEndpoint('requestPairing', DEVICE_PAIR_PATH, RequestDevicePairing).setPayload(
      // Reapplied after encodedSchema, which rebuilds the refined fields: a
      // body that does not parse is refused with this sentence and nothing
      // of what it carried.
      Schema.encodedSchema(RequestDevicePairing.payload).annotations(
        privately('Invalid pairing request.')
      )
    )
  )
  .add(HttpCqrs.queryEndpoint('readPairing', DEVICE_PAIR_PATH, ReadDevicePairing))
  .add(HttpCqrs.queryEndpoint('list', '/devices', ListDevices))
  .add(HttpCqrs.commandEndpoint('approve', '/devices/approve', ApproveDevicePairing))
  .add(HttpCqrs.commandEndpoint('refuse', '/devices/refuse', RefuseDevicePairing))
  .add(HttpCqrs.commandEndpoint('revoke', '/devices/revoke', RevokeDevice))
  .add(HttpCqrs.queryEndpoint('me', '/devices/me', ReadOwnDevice))
  .add(
    HttpCqrs.commandEndpoint(
      'setPushToken',
      '/devices/me/push-token',
      SetDevicePushToken
    ).setPayload(
      Schema.encodedSchema(SetDevicePushToken.payload).annotations(privately('Invalid push token.'))
    )
  )
  .add(
    HttpCqrs.commandEndpoint('clearPushToken', '/devices/me/push-token/clear', ClearDevicePushToken)
  )
  .add(HttpCqrs.queryEndpoint('readRelay', '/devices/relay', ReadMobileRelay))
  .add(HttpCqrs.commandEndpoint('setRelay', '/devices/relay', SetMobileRelay))
