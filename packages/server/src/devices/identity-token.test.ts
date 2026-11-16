/**
 * The owner's proof (mobile wave, lane A, issue #281 acceptance 1): an ID
 * token verified with node:crypto against the local provider's keys. Every
 * refusal is its own case and names its check; nothing here reaches
 * account.antasphere.com.
 */
import { createServer, type Server } from 'node:http'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  type KeyObject
} from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import {
  IdentityTokenRefused,
  JwksCache,
  OwnerMissing,
  resolveAntasphereIssuer,
  verifyIdentityToken
} from './identity-token'

type Provider = Awaited<ReturnType<typeof startOidcProvider>>

/** The phone's side of the hub: register once, sign in once, keep the ID token. */
async function mintIdToken(
  provider: Provider,
  options: { scope?: string } = {}
): Promise<{ idToken: string; clientId: string }> {
  const redirect = 'clave://oauth/callback'
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Clave on a phone',
      application_type: 'native'
    })
  })
  const { client_id: clientId } = (await registration.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', options.scope ?? 'openid profile email')
  authorize.searchParams.set('state', randomBytes(8).toString('hex'))
  authorize.searchParams.set('nonce', randomBytes(8).toString('hex'))
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  const code = new URL(sent.headers.get('location')!).searchParams.get('code')!
  const exchanged = await fetch(`${provider.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  const { id_token: idToken } = (await exchanged.json()) as { id_token: string }
  return { idToken, clientId }
}

const OWNER = 'user-7f3a'
let provider: Provider
let other: Provider

beforeAll(async () => {
  provider = await startOidcProvider()
  other = await startOidcProvider({
    user: { sub: 'user-other', name: 'Other', email: 'other@example.test', email_verified: true }
  })
})
afterAll(async () => {
  await provider.close()
  await other.close()
})

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    if (error instanceof IdentityTokenRefused) return error.check
    if (error instanceof OwnerMissing) return 'owner-missing'
    throw error
  }
  return 'accepted'
}

const verifyWith = (
  minted: { idToken: string; clientId: string },
  overrides: Partial<Parameters<typeof verifyIdentityToken>[0]> = {},
  cache?: JwksCache
): Promise<{ subject: string }> =>
  verifyIdentityToken({
    token: minted.idToken,
    clientId: minted.clientId,
    ownerSubject: OWNER,
    issuer: { issuer: new URL(provider.issuer), insecure: true },
    keys: cache ?? new JwksCache({ issuer: new URL(provider.issuer) }),
    ...overrides
  })

describe('the issuer rule', () => {
  it('is the hub by default, a bare https origin, or http to the literal loopback', () => {
    expect(resolveAntasphereIssuer(undefined)).toMatchObject({
      ok: true,
      config: { insecure: false }
    })
    expect(resolveAntasphereIssuer('https://account.antasphere.com')).toMatchObject({ ok: true })
    expect(resolveAntasphereIssuer('http://127.0.0.1:4321')).toMatchObject({
      ok: true,
      config: { insecure: true }
    })
    for (const bad of [
      'http://localhost:4321',
      'https://account.antasphere.com/path',
      'https://u:p@account.antasphere.com',
      'https://account.antasphere.com/?x=1',
      'not a url',
      'ftp://account.antasphere.com'
    ])
      expect(resolveAntasphereIssuer(bad).ok, bad).toBe(false)
  })
})

describe('the owner’s proof against the local provider', () => {
  it('accepts a valid token of the owner’s subject, audienced to the phone’s client id', async () => {
    const minted = await mintIdToken(provider)
    await expect(verifyWith(minted)).resolves.toEqual({ subject: OWNER })
  })
  it('refuses every token when nobody is signed in on the server, before reading any key', async () => {
    const minted = await mintIdToken(provider)
    const cache = new JwksCache({ issuer: new URL(provider.issuer) })
    expect(await refusal(() => verifyWith(minted, { ownerSubject: null }, cache))).toBe(
      'owner-missing'
    )
    expect(cache.reads).toBe(0)
  })
  it('refuses another subject', async () => {
    provider.state.tamper = { sub: 'user-somebody-else' }
    const minted = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(minted))).toBe('subject')
  })
  it('refuses a token from another issuer, whichever way it is told', async () => {
    // The claim says another issuer: the signature holds, the issuer does not.
    provider.state.tamper = { iss: 'https://evil.example' }
    const claimed = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(claimed))).toBe('issuer')
    // Another provider altogether (another key under the same kid): the signature fails first.
    const foreign = await mintIdToken(other)
    expect(await refusal(() => verifyWith(foreign))).toBe('signature')
  })
  it('refuses another audience, and a token whose client id is not the one presented', async () => {
    provider.state.tamper = { aud: 'dcr-somebody-else' }
    const minted = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(minted))).toBe('audience')
    const honest = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(honest, { clientId: 'dcr-not-this-one' }))).toBe(
      'audience'
    )
  })
  it('refuses an expired token, with a minute of skew and no more', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    provider.state.tamper = { exp: nowS - 120 }
    const expired = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(expired))).toBe('expired')
    provider.state.tamper = { exp: nowS - 30 }
    const skewed = await mintIdToken(provider)
    await expect(verifyWith(skewed)).resolves.toEqual({ subject: OWNER })
  })
  it('refuses a tampered signature', async () => {
    provider.state.tamper = { key: 'other' }
    const minted = await mintIdToken(provider)
    expect(await refusal(() => verifyWith(minted))).toBe('signature')
  })
  it('refuses a tampered body under a good signature', async () => {
    const minted = await mintIdToken(provider)
    const [h, p, s] = minted.idToken.split('.')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: OWNER, aud: 'x' })).toString(
      'base64url'
    )
    expect(await refusal(() => verifyWith({ ...minted, idToken: `${h}.${forged}.${s}` }))).toBe(
      'signature'
    )
  })
  it('refuses what is not a token at all, and an unsigned one', async () => {
    const minted = await mintIdToken(provider)
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '..', 'ab.cd.']) {
      expect(await refusal(() => verifyWith({ ...minted, idToken: bad })), bad).toBe('format')
    }
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${minted.idToken.split('.')[1]}.sig`
    expect(await refusal(() => verifyWith({ ...minted, idToken: none }))).toBe('algorithm')
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${minted.idToken.split('.')[1]}.sig`
    expect(await refusal(() => verifyWith({ ...minted, idToken: hs }))).toBe('algorithm')
  })
  it('caches the keys for a day and reads once for concurrent askers', async () => {
    let now = Date.now()
    const cache = new JwksCache({ issuer: new URL(provider.issuer), now: () => now })
    const minted = await mintIdToken(provider)
    await Promise.all([
      verifyWith(minted, { now: () => now }, cache),
      verifyWith(minted, { now: () => now }, cache)
    ])
    expect(cache.reads).toBe(1)
    // Twenty-three hours on: a fresh token, the same keys, no read.
    now += 23 * 60 * 60 * 1000
    provider.state.tamper = { exp: Math.floor(now / 1000) + 600 }
    const later = await mintIdToken(provider)
    await verifyWith(later, { now: () => now }, cache)
    expect(cache.reads).toBe(1)
    // Past the day: the keys are read again.
    now += 2 * 60 * 60 * 1000
    provider.state.tamper = { exp: Math.floor(now / 1000) + 600 }
    const muchLater = await mintIdToken(provider)
    await verifyWith(muchLater, { now: () => now }, cache)
    expect(cache.reads).toBe(2)
  })
})

/** A key set of this test's own, for what the fixture cannot show: ES256, a
 *  key that appears later, a key too short, a jwks_uri off the issuer. */
interface FakeHub {
  issuer: URL
  keys: Record<string, unknown>[]
  jwksOrigin: string | null
  reads: { discovery: number; jwks: number }
  close: () => Promise<void>
}
async function startFakeHub(): Promise<FakeHub> {
  const hub: FakeHub = {
    issuer: new URL('http://127.0.0.1:1'),
    keys: [],
    jwksOrigin: null,
    reads: { discovery: 0, jwks: 0 },
    close: async () => {}
  }
  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      hub.reads.discovery += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          issuer: hub.issuer.origin,
          jwks_uri: `${hub.jwksOrigin ?? hub.issuer.origin}/jwks`
        })
      )
    }
    if (req.url === '/jwks') {
      hub.reads.jwks += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ keys: hub.keys }))
    }
    res.writeHead(404)
    return res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  hub.issuer = new URL(`http://127.0.0.1:${address.port}`)
  hub.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return hub
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
function signWith(
  key: KeyObject,
  alg: 'RS256' | 'ES256',
  kid: string,
  claims: Record<string, unknown>
): string {
  const input = `${b64({ alg, typ: 'JWT', kid })}.${b64(claims)}`
  const signature =
    alg === 'RS256'
      ? signBytes('sha256', Buffer.from(input), key)
      : signBytes('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}

describe('the keys and the algorithms, against a key set of the test’s own', () => {
  let hub: FakeHub
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig' }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaJwk = {
    ...rsa.publicKey.export({ format: 'jwk' }),
    kid: 'rsa-1',
    alg: 'RS256',
    use: 'sig'
  }
  const short = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const shortJwk = { ...short.publicKey.export({ format: 'jwk' }), kid: 'rsa-short', alg: 'RS256' }
  const claimsFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const nowS = Math.floor(Date.now() / 1000)
    return {
      iss: hub.issuer.origin,
      sub: OWNER,
      aud: 'dcr-phone',
      exp: nowS + 600,
      iat: nowS,
      ...overrides
    }
  }
  const check = (token: string, cache?: JwksCache, clientId = 'dcr-phone'): Promise<string> =>
    refusal(() =>
      verifyIdentityToken({
        token,
        clientId,
        ownerSubject: OWNER,
        issuer: { issuer: hub.issuer, insecure: true },
        keys: cache ?? new JwksCache({ issuer: hub.issuer })
      })
    )
  beforeAll(async () => {
    hub = await startFakeHub()
    hub.keys = [ecJwk, rsaJwk, shortJwk]
  })
  afterAll(async () => {
    await hub.close()
  })

  it('verifies ES256 as it verifies RS256', async () => {
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor()))).toBe('accepted')
    expect(await check(signWith(rsa.privateKey, 'RS256', 'rsa-1', claimsFor()))).toBe('accepted')
    // The right key under the wrong algorithm's name is not that key.
    expect(await check(signWith(rsa.privateKey, 'RS256', 'ec-1', claimsFor()))).toBe('key')
  })
  it('refuses an RSA key under 2048 bits', async () => {
    expect(await check(signWith(short.privateKey, 'RS256', 'rsa-short', claimsFor()))).toBe('key')
  })
  it('honours nbf with the skew, an audience list, and azp when present', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    expect(
      await check(signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor({ nbf: nowS + 300 })))
    ).toBe('not-yet-valid')
    expect(
      await check(signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor({ nbf: nowS + 30 })))
    ).toBe('accepted')
    expect(
      await check(
        signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor({ aud: ['other', 'dcr-phone'] }))
      )
    ).toBe('accepted')
    expect(
      await check(
        signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor({ aud: ['dcr-phone'], azp: 'dcr-else' }))
      )
    ).toBe('authorized-party')
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor({ exp: 'soon' })))).toBe(
      'expired'
    )
  })
  it('reads the keys again once for an unknown kid, and not again within a minute', async () => {
    let now = Date.now()
    const cache = new JwksCache({ issuer: hub.issuer, now: () => now })
    hub.keys = [rsaJwk]
    expect(await check(signWith(rsa.privateKey, 'RS256', 'rsa-1', claimsFor()), cache)).toBe(
      'accepted'
    )
    expect(cache.reads).toBe(1)
    // The hub rotated: the new key is read on sight of its kid.
    hub.keys = [rsaJwk, ecJwk]
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-1', claimsFor()), cache)).toBe(
      'accepted'
    )
    expect(cache.reads).toBe(2)
    // A kid nobody publishes does not make the server hammer the hub.
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-ghost', claimsFor()), cache)).toBe(
      'key'
    )
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-ghost', claimsFor()), cache)).toBe(
      'key'
    )
    expect(cache.reads).toBe(2)
    now += 61_000
    expect(await check(signWith(ec.privateKey, 'ES256', 'ec-ghost', claimsFor()), cache)).toBe(
      'key'
    )
    expect(cache.reads).toBe(3)
  })
  it('refuses a key set that is not the issuer’s, or that cannot be read', async () => {
    const elsewhere = await startFakeHub()
    try {
      hub.jwksOrigin = elsewhere.issuer.origin
      const cache = new JwksCache({ issuer: hub.issuer })
      expect(await check(signWith(rsa.privateKey, 'RS256', 'rsa-1', claimsFor()), cache)).toBe(
        'keys'
      )
      expect(elsewhere.reads.jwks).toBe(0)
    } finally {
      hub.jwksOrigin = null
      await elsewhere.close()
    }
    const dead = new JwksCache({ issuer: new URL('http://127.0.0.1:9'), timeoutMs: 2000 })
    expect(
      await refusal(() =>
        verifyIdentityToken({
          token: signWith(rsa.privateKey, 'RS256', 'rsa-1', claimsFor()),
          clientId: 'dcr-phone',
          ownerSubject: OWNER,
          issuer: { issuer: new URL('http://127.0.0.1:9'), insecure: true },
          keys: dead
        })
      )
    ).toBe('keys')
  })
})
