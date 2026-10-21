import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { Client, ClientRegistrationReservation, ShellRegistrationIdentity } from './clients'

describe('desktop registration v1 boundary', () => {
  it('bounds UTF-8 bytes without narrowing legacy client names', () => {
    const decode = Schema.decodeUnknownSync(ShellRegistrationIdentity)
    expect(decode({ kind: 'shell', name: 'é'.repeat(128), pid: 7 }).name).toHaveLength(128)
    for (const input of [
      { kind: 'shell', name: 'é'.repeat(129) },
      { kind: 'browser', name: 'shell' },
      { kind: 'shell', name: '' },
      { kind: 'shell', name: 'shell', pid: -1 }
    ])
      expect(() => decode(input)).toThrow()
    expect(
      Schema.decodeUnknownSync(Client)({
        id: 'legacy',
        kind: 'browser',
        name: 'x'.repeat(500),
        registeredAt: 1
      })
    ).toBeTruthy()
  })
  it('requires positive v1 acknowledgment with a server-issued UUID and fixed lifetime', () => {
    const good = { protocol: 1, reservationId: crypto.randomUUID(), expiresInMs: 15000 }
    const decode = Schema.decodeUnknownSync(ClientRegistrationReservation)
    expect(decode(good)).toEqual(good)
    for (const input of [
      {},
      { ...good, protocol: 2 },
      { ...good, reservationId: '' },
      { ...good, expiresInMs: 0 }
    ])
      expect(() => decode(input)).toThrow()
  })
})
