/**
 * The window's copies of the device read models (`src/shared/mobile-types.ts`)
 * are held to the contract here: each shape must be assignable both ways, so
 * a field added or renamed on one side fails this file's typecheck, the way
 * `sessions.test.ts` holds the session model's two copies together.
 */
import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import type * as Shared from '../../../src/shared/mobile-types'
import {
  DEVICE_PAIR_PATH,
  DevicePlatform,
  DeviceView,
  DevicesView,
  PendingPairingView,
  RequestDevicePairing,
  devicesGroup
} from './devices'

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? Mutable<U>[] : T[K]
}
/** Both directions, or the file does not compile. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const deviceView: Same<Mutable<typeof DeviceView.Type>, Shared.DeviceView> = true
const pendingView: Same<Mutable<typeof PendingPairingView.Type>, Shared.PendingPairingView> = true
const devicesView: Same<Mutable<typeof DevicesView.Type>, Shared.DevicesView> = true
const platform: Same<typeof DevicePlatform.Type, Shared.DevicePlatform> = true

describe('the devices contract', () => {
  it('keeps the window’s copies of its read models', () => {
    expect([deviceView, pendingView, devicesView, platform]).toEqual([true, true, true, true])
  })
  it('pairs on one open path, with the token redacted on the wire', () => {
    expect(DEVICE_PAIR_PATH).toBe('/devices/pair')
    const encoded = Schema.encodeSync(RequestDevicePairing.payload)({
      idToken: Schema.decodeSync(Schema.Redacted(Schema.String))('t'),
      clientId: 'c',
      device: { name: 'n', platform: 'ios', appVersion: '1' }
    })
    expect(encoded.idToken).toBe('t')
    const refused = Schema.decodeUnknownEither(RequestDevicePairing.payload)({
      idToken: 'a-token-that-must-not-echo',
      clientId: 'c',
      device: { name: 'n', platform: 'tv', appVersion: '1' }
    })
    expect(refused._tag).toBe('Left')
    if (refused._tag === 'Left')
      expect(String(refused.left)).not.toContain('a-token-that-must-not-echo')
  })
  it('declares every route of the domain once', () => {
    const names = Object.keys(devicesGroup.endpoints).sort()
    expect(names).toEqual(
      [
        'approve',
        'clearPushToken',
        'list',
        'me',
        'readPairing',
        'readRelay',
        'refuse',
        'requestPairing',
        'revoke',
        'setPushToken',
        'setRelay'
      ].sort()
    )
  })
})
