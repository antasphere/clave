/**
 * The seam for the notifications (lane B of the mobile wave): the phones a
 * notification may go to, by their push token, and the way to forget a
 * token APNs or FCM reported gone. Lane B declares the same two interfaces
 * in `notify/port.ts`; the integration branch wires `devicesPushTargets`
 * into the notifier. Verbatim from the wave's brief: do not reshape.
 */
import { Effect } from 'effect'
import type { DeviceStore } from './store'

export interface PushTarget {
  readonly deviceId: string
  readonly platform: 'ios' | 'android'
  readonly token: string
}
export interface PushTargets {
  readonly list: () => Effect.Effect<ReadonlyArray<PushTarget>>
  /** APNs or FCM reported the token gone: clear it on the device record. */
  readonly forget: (deviceId: string, token: string) => Effect.Effect<void>
}
export const devicesPushTargets: (store: DeviceStore) => PushTargets = (store) => ({
  list: () => Effect.sync(() => store.pushTargets()),
  forget: (deviceId, token) =>
    Effect.sync(() => {
      store.clearPushToken(deviceId, token)
    })
})
