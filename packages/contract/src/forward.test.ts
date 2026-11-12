import { describe, expect, it } from 'vitest'
import { HOP_BY_HOP_HEADERS, connectionListed, isForwardLease, relayCloseCode } from './forward'

describe('the forward contract', () => {
  it('takes a lease of 32 lowercase hex characters, and nothing else', () => {
    expect(isForwardLease('0123456789abcdef0123456789abcdef')).toBe(true)
    for (const value of [
      '',
      '0123456789abcdef0123456789abcde',
      '0123456789abcdef0123456789abcdef0',
      '0123456789ABCDEF0123456789ABCDEF',
      '0123456789abcdef0123456789abcdeg',
      '0123456789abcdef0123456789abcde/'
    ])
      expect(isForwardLease(value), value).toBe(false)
  })
  it('names the hop-by-hop headers of RFC 9110', () => {
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual(
      [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade'
      ].sort()
    )
  })
  it('reads the names a Connection header lists, lowercased', () => {
    expect([...connectionListed('keep-alive, X-Private ,')]).toEqual(['keep-alive', 'x-private'])
    expect([...connectionListed(['a', 'B, c'])]).toEqual(['a', 'b', 'c'])
    expect(connectionListed(undefined).size).toBe(0)
  })
  it('relays a close code that can be sent, and 1000 for one that cannot', () => {
    for (const code of [1000, 1001, 1009, 1011, 3000, 4321, 4999])
      expect(relayCloseCode(code)).toBe(code)
    for (const code of [undefined, 1004, 1005, 1006, 1015, 999, 2000, 5000])
      expect(relayCloseCode(code), String(code)).toBe(1000)
  })
})
