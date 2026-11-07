/**
 * The devices domain of the typed client (mobile wave, lane A): what the
 * Mac's Settings → Mobile asks of its server (the list, an approval, a
 * refusal, a revocation, the relay address), and what a phone asks with its
 * device session (its own record, its push token). The pairing calls are
 * here for a test that stands in for a phone; a phone itself uses the
 * platform's fetch on the same routes.
 */
import type {
  DeviceDescription,
  DevicePlatform,
  DeviceSessionView,
  DeviceView,
  DevicesView,
  PairingStatus
} from '@clave/contract/devices'
import type { Call } from './call'

export interface PairingRequestInput {
  readonly idToken: string
  readonly clientId: string
  readonly device: DeviceDescription
}

export interface DevicesClient {
  readonly list: () => Promise<DevicesView>
  readonly approve: (pairingId: string) => Promise<DeviceView>
  readonly refuse: (pairingId: string) => Promise<void>
  readonly revoke: (deviceId: string) => Promise<void>
  readonly requestPairing: (
    input: PairingRequestInput
  ) => Promise<{ pairingId: string; expiresAt: number }>
  readonly readPairing: (
    id: string
  ) => Promise<{ status: PairingStatus; deviceSession?: DeviceSessionView }>
  readonly me: () => Promise<DeviceView>
  readonly setPushToken: (token: string, platform: DevicePlatform) => Promise<void>
  readonly clearPushToken: () => Promise<void>
  readonly relay: {
    readonly get: () => Promise<string>
    readonly set: (url: string) => Promise<string>
  }
}

const done = (): void => undefined

export const devicesClient = (call: Call): DevicesClient => ({
  list: () => call((c) => c.devices.list({ payload: {} })),
  approve: (pairingId) => call((c) => c.devices.approve({ payload: { pairingId } })),
  refuse: (pairingId) => call((c) => c.devices.refuse({ payload: { pairingId } })).then(done),
  revoke: (deviceId) => call((c) => c.devices.revoke({ payload: { deviceId } })).then(done),
  requestPairing: (input) => call((c) => c.devices.requestPairing({ payload: input })),
  readPairing: (id) => call((c) => c.devices.readPairing({ payload: { id } })),
  me: () => call((c) => c.devices.me({ payload: {} })),
  setPushToken: (token, platform) =>
    call((c) => c.devices.setPushToken({ payload: { token, platform } })).then(done),
  clearPushToken: () => call((c) => c.devices.clearPushToken({ payload: {} })).then(done),
  relay: {
    get: () => call((c) => c.devices.readRelay({ payload: {} })).then((r) => r.url),
    set: (url) => call((c) => c.devices.setRelay({ payload: { url } })).then((r) => r.url)
  }
})
