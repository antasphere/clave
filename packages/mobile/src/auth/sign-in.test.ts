import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startOidcProvider,
  type OidcProvider,
  type OidcProviderTamper
} from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { MemorySecureStore } from '../machines/credentials'
import { REDIRECT_URI } from './issuer'
import { decodeIdToken } from './jwt'
import type { CryptoPort } from './pkce'
import { HubSignIn, type OpenAuthSession, type SignInDeps } from './sign-in'
import { STORE_KEYS } from './store'

/**
 * The sign-in against the local provider (`tests/e2e/fixtures/
 * oidc-provider.mjs`), the same one the Mac's login and lane A's identity
 * check run against: nothing here reaches account.antasphere.com. The
 * platform is stood in by Node: node:crypto for the random bytes and the
 * digest, a fetch of the authorization URL for the authentication session
 * (the provider approves on sight and answers the redirect to
 * `clave://oauth/callback`), a Map for the secure store. The clock is
 * vitest's fake `Date`, shared with the in-process provider, so a token
 * issued "now" lapses when the test moves the clock past its lifetime; the
 * renew-ahead margin is one second here (a minute in the app), so that a
 * ten-second token is fresh when issued and lapsed eleven seconds later.
 */
const nodeCrypto: CryptoPort = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest())
}

/** The person's browser: the authorization URL opened, the redirect handed back. */
const browser: OpenAuthSession = async (url) => {
  const response = await fetch(url, { redirect: 'manual' })
  if (response.status !== 302) throw new Error(`authorize answered ${response.status}`)
  return response.headers.get('location')
}

class RecordingSecureStore extends MemorySecureStore {
  readonly writes: string[] = []
  override async setItemAsync(key: string, value: string): Promise<void> {
    this.writes.push(key)
    await super.setItemAsync(key, value)
  }
}

const START = Date.now()
let provider: OidcProvider
let store: RecordingSecureStore

const advance = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms)
}

const make = (overrides: Partial<SignInDeps> = {}): HubSignIn =>
  new HubSignIn({
    issuer: provider.issuer,
    secureStore: store,
    crypto: nodeCrypto,
    openAuthSession: browser,
    renewAheadMs: 1_000,
    ...overrides
  })

const tokenRequests = (): URLSearchParams[] =>
  provider.state.log.filter((e) => e.path === '/token').map((e) => new URLSearchParams(e.body))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  provider = await startOidcProvider({ accessTokenTtlSec: 10 })
  store = new RecordingSecureStore()
})

afterEach(async () => {
  await provider.close()
  vi.useRealTimers()
})

describe('the registration', () => {
  it('registers the app once as an anonymous public native client and reuses it', async () => {
    const signIn = make()
    const first = await signIn.signIn()
    expect(first.phase).toBe('signed-in')
    expect(provider.state.registrations).toHaveLength(1)
    const sent = provider.state.registrations[0]!.sent
    expect(sent).toMatchObject({
      client_name: 'Clave',
      type: 'native',
      application_type: 'native',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email offline_access'
    })
    await signIn.signOut()
    expect(signIn.status().phase).toBe('signed-out')
    const second = await signIn.signIn()
    expect(second.phase).toBe('signed-in')
    expect(provider.state.counts.register).toBe(1)
    expect(second.clientId).toBe(first.clientId)
  })

  it('refuses a confidential registration and keeps nothing', async () => {
    provider.state.confidentialNext = true
    const status = await make().signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('registration')
    expect(store.map.has(STORE_KEYS.client)).toBe(false)
  })

  it('refuses a registration without the code grant', async () => {
    provider.state.grantTypesOverride = ['refresh_token']
    const status = await make().signIn()
    expect(status.lastFailure).toBe('registration')
  })

  it('refuses metadata naming an endpoint off the issuer', async () => {
    provider.state.foreignTokenEndpoint = 'http://127.0.0.1:1/token'
    const status = await make().signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('invalid-response')
    expect(provider.state.counts.register).toBe(0)
  })
})

describe('the code flow', () => {
  it('signs in with PKCE S256, keeps the identity and the three tokens', async () => {
    const signIn = make()
    const status = await signIn.signIn()
    expect(status.phase).toBe('signed-in')
    expect(status.account).toEqual({
      subject: 'user-7f3a',
      name: 'Ada Example',
      email: 'ada@example.test',
      emailVerified: true
    })
    expect(status.renewable).toBe(true)
    expect(status.expiresAt).toBeGreaterThan(Date.now())
    const [exchange] = tokenRequests()
    expect(exchange?.get('grant_type')).toBe('authorization_code')
    expect(exchange?.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(exchange?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
    expect(exchange?.get('client_id')).toBe(status.clientId)
    for (const key of Object.values(STORE_KEYS)) expect(store.map.has(key)).toBe(true)
    const id = JSON.parse(store.map.get(STORE_KEYS.idToken)!) as { token: string }
    expect(decodeIdToken(id.token).aud).toEqual([status.clientId])
    expect(await signIn.accessToken()).toMatch(/^at-/)
    expect(await signIn.idToken()).toBe(id.token)
    expect(provider.state.counts.refresh).toBe(0)
  })

  it('a refused authorization is said as denied', async () => {
    provider.state.denyNext = true
    const status = await make().signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('denied')
  })

  it('a dismissed authentication session is cancelled', async () => {
    const status = await make({ openAuthSession: async () => null }).signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('cancelled')
    expect(provider.state.counts.token).toBe(0)
  })

  it('a second ask while the browser is open joins the first', async () => {
    let release!: (url: string | null) => void
    const held = new Promise<string | null>((resolve) => {
      release = resolve
    })
    const signIn = make({ openAuthSession: () => held })
    const first = signIn.signIn()
    const second = signIn.signIn()
    expect(signIn.status().phase).toBe('signing-in')
    release(null)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.lastFailure).toBe('cancelled')
  })

  it('a redirect carrying another state is refused before any exchange', async () => {
    const forged: OpenAuthSession = async (url) =>
      (await browser(url, REDIRECT_URI))!.replace(/state=[^&]*/, 'state=forged')
    const status = await make({ openAuthSession: forged }).signIn()
    expect(status.lastFailure).toBe('invalid-response')
    expect(provider.state.counts.token).toBe(0)
  })

  it('a redirect somewhere else than the registered callback is refused', async () => {
    const elsewhere: OpenAuthSession = async (url) =>
      (await browser(url, REDIRECT_URI))!.replace('clave://oauth/callback', 'https://evil.test/cb')
    const status = await make({ openAuthSession: elsewhere }).signIn()
    expect(status.lastFailure).toBe('invalid-response')
    expect(provider.state.counts.token).toBe(0)
  })

  it('an unreachable issuer is a network failure', async () => {
    const status = await make({
      fetch: async () => {
        throw new TypeError('offline')
      }
    }).signIn()
    expect(status.lastFailure).toBe('network')
  })

  it.each<[string, OidcProviderTamper]>([
    ['another issuer', { iss: 'https://evil.test' }],
    ['another audience', { aud: 'another-client' }],
    ['a stale nonce', { nonce: 'stale' }],
    ['an expired lifetime', { exp: Math.floor(START / 1000) - 3600 }]
  ])('refuses an ID token with %s by its shape, and keeps nothing', async (_, tamper) => {
    provider.state.tamper = tamper
    const status = await make().signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('invalid-response')
    expect(store.map.has(STORE_KEYS.session)).toBe(false)
    expect(store.map.has(STORE_KEYS.refreshToken)).toBe(false)
  })

  it('leaves the signature to the server: a token signed with another key passes the shape', async () => {
    provider.state.tamper = { key: 'other' }
    const status = await make().signIn()
    expect(status.phase).toBe('signed-in')
  })
})

describe('the refresh', () => {
  it('renews a lapsed access token once for two asks, the rotated token kept first', async () => {
    const signIn = make()
    await signIn.signIn()
    const firstRefresh = store.map.get(STORE_KEYS.refreshToken)
    const mark = store.writes.length
    advance(11_000)
    const [a, b] = await Promise.all([signIn.accessToken(), signIn.accessToken()])
    expect(a).toBe(b)
    expect(provider.state.counts.refresh).toBe(1)
    const writes = store.writes.slice(mark)
    expect(writes.indexOf(STORE_KEYS.refreshToken)).toBeGreaterThanOrEqual(0)
    expect(writes.indexOf(STORE_KEYS.refreshToken)).toBeLessThan(
      writes.indexOf(STORE_KEYS.accessToken)
    )
    const rotated = store.map.get(STORE_KEYS.refreshToken)
    expect(rotated).not.toBe(firstRefresh)
    expect(await signIn.accessToken()).toBe(a)
    expect(provider.state.counts.refresh).toBe(1)
    advance(11_000)
    await signIn.accessToken()
    const refreshes = tokenRequests().filter((f) => f.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(2)
    expect(refreshes[1]!.get('refresh_token')).toBe(rotated)
  })

  it('drops the whole family on invalid_grant and signs the person out', async () => {
    const signIn = make()
    await signIn.signIn()
    provider.state.refreshTokens.clear()
    advance(11_000)
    await expect(signIn.accessToken()).rejects.toMatchObject({ failure: 'expired' })
    const status = signIn.status()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('expired')
    for (const key of [STORE_KEYS.session, STORE_KEYS.refreshToken, STORE_KEYS.accessToken])
      expect(store.map.has(key)).toBe(false)
    expect(store.map.has(STORE_KEYS.client)).toBe(true)
  })

  it('registers again on invalid_client, signs out, and the next sign-in uses the new client', async () => {
    const signIn = make()
    const first = await signIn.signIn()
    provider.state.registrations.splice(0)
    advance(11_000)
    await expect(signIn.accessToken()).rejects.toMatchObject({ failure: 'client-purged' })
    expect(provider.state.counts.register).toBe(2)
    expect(signIn.status().phase).toBe('signed-out')
    expect(signIn.status().lastFailure).toBe('client-purged')
    const stored = JSON.parse(store.map.get(STORE_KEYS.client)!) as { clientId: string }
    expect(stored.clientId).not.toBe(first.clientId)
    expect(stored.clientId).toBe(provider.state.registrations[0]!.registered.client_id)
    const again = await signIn.signIn()
    expect(again.phase).toBe('signed-in')
    expect(again.clientId).toBe(stored.clientId)
  })

  it('a network failure during the refresh keeps the session for later', async () => {
    const signIn = make()
    await signIn.signIn()
    advance(11_000)
    await provider.close()
    await expect(signIn.accessToken()).rejects.toMatchObject({ failure: 'network' })
    expect(signIn.status().phase).toBe('signed-in')
    expect(store.map.has(STORE_KEYS.refreshToken)).toBe(true)
    provider = await startOidcProvider()
  })

  it('renews the ID token for the enrollment, and asks for a new sign-in when none comes back', async () => {
    await provider.close()
    provider = await startOidcProvider({ idTokenTtlSec: 10, accessTokenTtlSec: 3600 })
    const signIn = make()
    await signIn.signIn()
    advance(11_000)
    const renewed = await signIn.idToken()
    expect(provider.state.counts.refresh).toBe(1)
    expect(decodeIdToken(renewed).exp * 1000).toBeGreaterThan(Date.now())
    provider.state.bareRefresh = true
    advance(11_000)
    await expect(signIn.idToken()).rejects.toMatchObject({ failure: 'expired' })
    expect(signIn.status().phase).toBe('signed-in')
  })
})

describe('the restore at boot', () => {
  it('restores a stored session without the network and reuses its tokens', async () => {
    await make().signIn()
    const tokensBefore = provider.state.counts.token
    const next = make()
    const status = await next.restore()
    expect(status.phase).toBe('signed-in')
    expect(status.account?.subject).toBe('user-7f3a')
    expect(await next.accessToken()).toMatch(/^at-/)
    expect(provider.state.counts.token).toBe(tokensBefore)
  })

  it('discards a session stored for another client', async () => {
    await make().signIn()
    store.map.set(
      STORE_KEYS.client,
      JSON.stringify({ issuer: provider.issuer, clientId: 'someone-else', registeredAt: 1 })
    )
    const status = await make().restore()
    expect(status.phase).toBe('signed-out')
    expect(store.map.has(STORE_KEYS.session)).toBe(false)
  })

  it('a refused issuer override signs nobody in and says configuration', async () => {
    const signIn = make({ issuer: 'http://192.168.1.10:8080' })
    expect(signIn.status().lastFailure).toBe('configuration')
    const status = await signIn.signIn()
    expect(status.phase).toBe('signed-out')
    expect(status.lastFailure).toBe('configuration')
  })
})
