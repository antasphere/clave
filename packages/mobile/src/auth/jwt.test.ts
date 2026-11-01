import { describe, expect, it } from 'vitest'
import { base64urlEncode } from './encoding'
import { checkIdToken, decodeIdToken, IdTokenRefused } from './jwt'

const segment = (value: unknown): string =>
  base64urlEncode(new TextEncoder().encode(JSON.stringify(value)))
const sig = base64urlEncode(new Uint8Array([1, 2, 3, 4]))

const claims = {
  iss: 'https://hub.test',
  sub: 'user-1',
  aud: 'client-1',
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  nonce: 'n-1',
  name: 'Ada',
  email: 'ada@example.test',
  email_verified: true
}
const token = (header: unknown = { alg: 'RS256', typ: 'JWT' }, payload: unknown = claims): string =>
  `${segment(header)}.${segment(payload)}.${sig}`

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof IdTokenRefused) return error.check
    throw error
  }
  throw new Error('not refused')
}

describe('decodeIdToken', () => {
  it('reads the claims of a well-formed token without verifying its signature', () => {
    expect(decodeIdToken(token())).toEqual({
      iss: 'https://hub.test',
      sub: 'user-1',
      aud: ['client-1'],
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      nonce: 'n-1',
      azp: undefined,
      name: 'Ada',
      email: 'ada@example.test',
      emailVerified: true
    })
  })

  it('takes an audience list', () => {
    expect(decodeIdToken(token(undefined, { ...claims, aud: ['a', 'client-1'] })).aud).toEqual([
      'a',
      'client-1'
    ])
  })

  it.each([
    ['two segments', `${segment({ alg: 'RS256' })}.${segment(claims)}`, 'format'],
    ['an empty signature', `${segment({ alg: 'RS256' })}.${segment(claims)}.`, 'format'],
    ['a header that is not JSON', `abc.${segment(claims)}.${sig}`, 'format'],
    ['a payload with padding', `${segment({ alg: 'RS256' })}.${segment(claims)}=.${sig}`, 'format'],
    ['alg none', token({ alg: 'none' }), 'algorithm'],
    ['alg HS256', token({ alg: 'HS256', typ: 'JWT' }), 'algorithm'],
    ['a typ that is not JWT', token({ alg: 'RS256', typ: 'JWE' }), 'format'],
    ['no issuer', token(undefined, { ...claims, iss: '' }), 'format'],
    ['no subject', token(undefined, { ...claims, sub: '' }), 'subject'],
    ['an empty audience', token(undefined, { ...claims, aud: [] }), 'format'],
    ['no expiry', token(undefined, { ...claims, exp: 'soon' }), 'format'],
    [
      'a non-boolean email_verified',
      token(undefined, { ...claims, email_verified: 'yes' }),
      'format'
    ]
  ])('refuses %s by shape', (_, value, check) => {
    expect(refusal(() => decodeIdToken(value))).toBe(check)
  })
})

describe('checkIdToken', () => {
  const expected = {
    issuer: 'https://hub.test',
    clientId: 'client-1',
    nonce: 'n-1',
    now: 1_950_000_000 * 1000
  }
  const decoded = decodeIdToken(token())

  it('passes the token the phone asked for', () => {
    expect(() => checkIdToken(decoded, expected)).not.toThrow()
  })

  it('passes a token from a refresh, which carries no nonce to compare', () => {
    const withoutNonce = { issuer: expected.issuer, clientId: expected.clientId, now: expected.now }
    expect(() => checkIdToken({ ...decoded, nonce: undefined }, withoutNonce)).not.toThrow()
  })

  it.each([
    ['issuer', { ...expected, issuer: 'https://other.test' }],
    ['audience', { ...expected, clientId: 'client-2' }],
    ['nonce', { ...expected, nonce: 'n-2' }],
    ['expired', { ...expected, now: 2_000_000_100 * 1000 }],
    ['not-yet-valid', { ...expected, now: 1_899_999_000 * 1000 }]
  ])('refuses by %s', (check, against) => {
    expect(refusal(() => checkIdToken(decoded, against))).toBe(check)
  })

  it('tolerates a minute of clock skew on the lifetime', () => {
    expect(() => checkIdToken(decoded, { ...expected, now: 2_000_000_030 * 1000 })).not.toThrow()
    expect(() => checkIdToken(decoded, { ...expected, now: 1_899_999_970 * 1000 })).not.toThrow()
  })

  it('refuses an authorized party that is not this client', () => {
    const withAzp = decodeIdToken(token(undefined, { ...claims, azp: 'client-9' }))
    expect(refusal(() => checkIdToken(withAzp, expected))).toBe('authorized-party')
  })
})
