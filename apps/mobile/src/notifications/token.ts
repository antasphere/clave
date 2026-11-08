/**
 * The device token, registered with the paired machine so its server can
 * push to this phone (decision 9 of the spec): the raw APNs or FCM token
 * from the platform (`getDevicePushTokenAsync`, no Expo push service), sent
 * through `POST /devices/me/push-token` with the device session, once per
 * token value and again when the platform hands a new one. The last token
 * registered with each machine is kept in the key-value store, so a boot
 * that gets the same token sends nothing. A simulator or a build without
 * the push capability hands no token: said as such, never as a failure of
 * the machine.
 */
import type { KeyValueStore } from '../chat/drafts'
import type { DevicePlatform, EnrollmentClient } from '../enroll/client'
import type { NotificationsPort } from './port'

export const pushTokenKey = (machineId: string): string => `clave.push-token:${machineId}`

export type TokenRegistration =
  | { readonly kind: 'registered'; readonly token: string }
  | { readonly kind: 'unchanged' }
  /** No native token on this platform, or the platform refused to hand one. */
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

export interface TokenPorts {
  readonly notifications: Pick<NotificationsPort, 'getDevicePushTokenAsync'>
  readonly client: Pick<EnrollmentClient, 'setPushToken' | 'clearPushToken'>
  readonly kv: KeyValueStore
}

export async function registerDeviceToken(
  target: {
    readonly machineId: string
    readonly bearer: string
    readonly platform: DevicePlatform
  },
  ports: TokenPorts
): Promise<TokenRegistration> {
  let got
  try {
    got = await ports.notifications.getDevicePushTokenAsync()
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: `This device hands out no push token (${error instanceof Error ? error.message : String(error)}).`
    }
  }
  if ((got.type !== 'ios' && got.type !== 'android') || typeof got.data !== 'string' || !got.data)
    return { kind: 'unsupported', reason: `No native push token on this platform (${got.type}).` }
  if (got.type !== target.platform)
    return {
      kind: 'unsupported',
      reason: `The token is ${got.type}'s and the device registered as ${target.platform}.`
    }
  const key = pushTokenKey(target.machineId)
  if ((await ports.kv.getItem(key)) === got.data) return { kind: 'unchanged' }
  try {
    await ports.client.setPushToken(target.bearer, got.data, target.platform)
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  await ports.kv.setItem(key, got.data)
  return { kind: 'registered', token: got.data }
}

/** The phone no longer wants notifications from this machine. */
export async function clearDeviceToken(
  target: { readonly machineId: string; readonly bearer: string },
  ports: Pick<TokenPorts, 'client' | 'kv'>
): Promise<void> {
  await ports.client.clearPushToken(target.bearer)
  await ports.kv.removeItem(pushTokenKey(target.machineId))
}
