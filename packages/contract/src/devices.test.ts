/**
 * The devices contract a native phone pairs and calls through. The desktop
 * keeps no copy of these read models: its pairing page is not on this branch,
 * and a phone is approved by the owner's own call to the server.
 */
import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { DEVICE_PAIR_PATH, RequestDevicePairing, devicesGroup } from './devices'

describe('the devices contract', () => {
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
