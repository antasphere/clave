import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { signJwt, verifyJwt } from './jwt'

describe('the signed tokens the push platforms take', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

  it('signs ES256 as a raw r||s pair that verifies against the public half', () => {
    const token = signJwt(
      { kid: 'KEY1' },
      { iss: 'TEAM1', iat: 1700000000 },
      ec.privateKey,
      'ES256'
    )
    const [h, , s] = token.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      kid: 'KEY1',
      alg: 'ES256'
    })
    expect(Buffer.from(s, 'base64url').length).toBe(64)
    expect(verifyJwt(token, ec.publicKey, 'ES256')).toEqual({
      header: { kid: 'KEY1', alg: 'ES256' },
      claims: { iss: 'TEAM1', iat: 1700000000 }
    })
  })
  it('signs RS256 with a PEM key and verifies it', () => {
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const token = signJwt(
      { typ: 'JWT' },
      { iss: 'svc@project.iam', aud: 'https://t' },
      pem,
      'RS256'
    )
    expect(verifyJwt(token, rsa.publicKey, 'RS256')?.claims).toEqual({
      iss: 'svc@project.iam',
      aud: 'https://t'
    })
  })
  it('refuses a token signed with another key, a changed claim, the wrong algorithm, or no shape', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const token = signJwt({ kid: 'K' }, { iss: 'T' }, ec.privateKey, 'ES256')
    expect(verifyJwt(token, other.publicKey, 'ES256')).toBeNull()
    const [h, , s] = token.split('.')
    const tampered = `${h}.${Buffer.from(JSON.stringify({ iss: 'X' })).toString('base64url')}.${s}`
    expect(verifyJwt(tampered, ec.publicKey, 'ES256')).toBeNull()
    expect(verifyJwt(token, rsa.publicKey, 'RS256')).toBeNull()
    expect(verifyJwt('not.a', ec.publicKey, 'ES256')).toBeNull()
    expect(verifyJwt('a.b.c', ec.publicKey, 'ES256')).toBeNull()
  })
})
