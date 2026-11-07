/**
 * The devices commands and queries, through the bus. The owner-only ones
 * never see a phone: the token check refuses a device session on them with
 * 403 before the bus. The phone-only ones read which phone asked off the
 * dispatch's actor, which the token check set; the owner's token on them is
 * the declared `DeviceSessionRequired`.
 */
import { Effect, Redacted } from 'effect'
import { CommandHandler, QueryHandler, type Dispatch } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  ApproveDevicePairing,
  ClearDevicePushToken,
  DeviceNotFound,
  DevicePairingNotFound,
  DevicePairingRefused,
  DeviceSessionRequired,
  ListDevices,
  ReadDevicePairing,
  ReadMobileRelay,
  ReadOwnDevice,
  RefuseDevicePairing,
  RelayAddressInvalid,
  RequestDevicePairing,
  RevokeDevice,
  SetDevicePushToken,
  SetMobileRelay
} from '@clave/contract/devices'
import { deviceIdOfActor } from './actor'
import { DeviceSessions } from './service'

type Ctor<E> = abstract new (...args: never[]) => E
const declaredBy =
  <E>(declared: ReadonlyArray<Ctor<E>>) =>
  (error: unknown): error is E =>
    declared.some((ctor) => error instanceof ctor)

/** A synchronous domain call: one of the declared failures fails the
 *  command as it is, anything else is a defect (a 500, never a refusal). */
const attempt = <A, E>(declared: ReadonlyArray<Ctor<E>>, run: () => A): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(run())
    } catch (error) {
      return declaredBy(declared)(error) ? Effect.fail(error) : Effect.die(error)
    }
  })

const attemptAsync = <A, E>(
  declared: ReadonlyArray<Ctor<E>>,
  run: () => Promise<A>
): Effect.Effect<A, E> =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      declaredBy(declared)(error) ? Effect.fail(error) : Effect.die(error)
    )
  )

/** Which phone asked, or the declared refusal when it was not a phone. */
const askingDevice = (dispatch: Dispatch): Effect.Effect<string, DeviceSessionRequired> => {
  const deviceId = deviceIdOfActor(dispatch.actor)
  return deviceId === null
    ? Effect.fail(
        new DeviceSessionRequired({ message: 'This route answers a phone by its device session.' })
      )
    : Effect.succeed(deviceId)
}

const pairingFailures: ReadonlyArray<Ctor<DevicePairingRefused | CapabilityUnavailable>> = [
  DevicePairingRefused,
  CapabilityUnavailable
]
const ownFailures: ReadonlyArray<Ctor<DeviceSessionRequired | DeviceNotFound>> = [
  DeviceSessionRequired,
  DeviceNotFound
]
const relayFailures: ReadonlyArray<Ctor<RelayAddressInvalid | CapabilityUnavailable>> = [
  RelayAddressInvalid,
  CapabilityUnavailable
]

export const deviceHandlers = [
  CommandHandler.make(RequestDevicePairing, (p) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attemptAsync(pairingFailures, () =>
        devices.requestPairing({
          idToken: Redacted.value(p.idToken),
          clientId: p.clientId,
          device: p.device
        })
      )
    )
  ),
  QueryHandler.make(ReadDevicePairing, (p) =>
    Effect.map(DeviceSessions, (devices) => devices.readPairing(p.id))
  ),
  QueryHandler.make(ListDevices, () => Effect.map(DeviceSessions, (devices) => devices.list())),
  CommandHandler.make(ApproveDevicePairing, (p) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attempt([DevicePairingNotFound], () => devices.approve(p.pairingId))
    )
  ),
  CommandHandler.make(RefuseDevicePairing, (p) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attempt([DevicePairingNotFound], () => devices.refuse(p.pairingId))
    )
  ),
  CommandHandler.make(RevokeDevice, (p) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attempt([DeviceNotFound], () => devices.revoke(p.deviceId))
    )
  ),
  QueryHandler.make(ReadOwnDevice, (_p, dispatch) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      Effect.flatMap(askingDevice(dispatch), (deviceId) =>
        attempt(ownFailures, () => devices.me(deviceId))
      )
    )
  ),
  CommandHandler.make(SetDevicePushToken, (p, dispatch) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      Effect.flatMap(askingDevice(dispatch), (deviceId) =>
        attempt(ownFailures, () =>
          devices.setPushToken(deviceId, Redacted.value(p.token), p.platform)
        )
      )
    )
  ),
  CommandHandler.make(ClearDevicePushToken, (_p, dispatch) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      Effect.flatMap(askingDevice(dispatch), (deviceId) =>
        attempt(ownFailures, () => devices.clearPushToken(deviceId))
      )
    )
  ),
  QueryHandler.make(ReadMobileRelay, () =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attempt([CapabilityUnavailable], () => ({ url: devices.relay.get() }))
    )
  ),
  CommandHandler.make(SetMobileRelay, (p) =>
    Effect.flatMap(DeviceSessions, (devices) =>
      attempt(relayFailures, () => ({ url: devices.relay.set(p.url) }))
    )
  )
] as const
