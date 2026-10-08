import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { connect, createServer } from 'node:net'
import { startOidcProvider, type OidcProvider } from '../../tests/e2e/fixtures/oidc-provider.mjs'
import {
  AntasphereAccountManager,
  ANTASPHERE_SCOPE,
  CALLBACK_PATH,
  resolveAntasphereIssuer,
  type AntasphereAccountDeps
} from './antasphere-account'
import {
  ANTASPHERE_STATUS_KEYS,
  type AntasphereAccountStatus
} from '../shared/antasphere-account-types'
import { eachTestPorts, electronTestPorts, standaloneTestPorts, tempDataDir } from './ports/testing'
import type { SettingsPorts } from './ports/registry'

/**
 * The Antasphere login (PRDCT-3259) against a local signed OIDC provider
 * (tests/e2e/fixtures/oidc-provider.mjs): discovery, registration, the code
 * flow with PKCE, state and nonce, the ID token checked against the JWKS,
 * the session sealed and restored, and every way the flow must NOT land.
 * Nothing here reaches account.antasphere.com: the issuer is the provider
 * on 127.0.0.1, named through the same environment override the app reads.
 */

// The lapse tests wait for real tokens to lapse, up to twice in one test.
vi.setConfig({ testTimeout: 20_000 })

const SESSION = 'antasphere-account-session.json'
const CLIENT = 'antasphere-account-client.json'

let provider: OidcProvider
/** An issuer whose tokens last a few seconds: for everything about a login
 *  lapsing, on the real clock, with no skew between the two sides. Three
 *  seconds leaves a loaded machine room between a token's issue and the
 *  exchange that checks it has not already lapsed. */
let brief: OidcProvider
const BRIEF_TTL_SEC = 3
const LAPSE_MS = BRIEF_TTL_SEC * 1000 + 300
const managers: AntasphereAccountManager[] = []
/** A rejection nobody handled: the one thing none of these flows may produce. */
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

beforeAll(async () => {
  provider = await startOidcProvider()
  brief = await startOidcProvider({
    idTokenTtlSec: BRIEF_TTL_SEC,
    accessTokenTtlSec: BRIEF_TTL_SEC
  })
  process.on('unhandledRejection', onUnhandled)
})
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  await provider.close()
  await brief.close()
})
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.shutdown()
  for (const p of [provider, brief]) {
    p.state.tamper = null
    p.state.denyNext = false
    p.state.tokenDelayMs = 0
    p.state.refreshDelayMs = 0
    p.state.discoveryDelayMs = 0
    p.state.registerDelayOnceMs = 0
    p.state.foreignTokenEndpoint = null
    p.state.discoveryPadBytes = 0
    p.state.confidentialNext = false
    p.state.bareRefresh = false
    p.state.userinfoFail = false
    p.state.refuseRegistrationOnce = null
    p.state.issueRefresh = true
    p.state.idTokenTtlSec = p === brief ? BRIEF_TTL_SEC : 3600
    p.state.accessTokenTtlSec = p === brief ? BRIEF_TTL_SEC : 3600
  }
  await new Promise((r) => setTimeout(r, 0))
  expect(unhandled, 'no unhandled rejection').toEqual([])
})

interface Harness {
  manager: AntasphereAccountManager
  provider: OidcProvider
  /** Every handoff a start answered: what the shell would have opened. */
  opened: URL[]
  statuses: AntasphereAccountStatus[]
  logs: Array<{ event: string; fields?: Record<string, unknown> }>
  fetched: string[]
  /** `manager.start()`, the handoff recorded in `opened`, the status answered. */
  start: () => Promise<AntasphereAccountStatus>
}

function harness(
  ports: SettingsPorts,
  overrides: Partial<AntasphereAccountDeps> = {},
  on: OidcProvider = provider
): Harness {
  const opened: URL[] = []
  const statuses: AntasphereAccountStatus[] = []
  const logs: Harness['logs'] = []
  const fetched: string[] = []
  const manager = new AntasphereAccountManager({
    ports,
    env: { CLAVE_ANTASPHERE_ISSUER: on.issuer },
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(input))
      return globalThis.fetch(input, init)
    },
    log: (event, fields) => logs.push({ event, fields }),
    ...overrides
  })
  manager.onChange((s) => statuses.push(s))
  managers.push(manager)
  const start = async (): Promise<AntasphereAccountStatus> => {
    const { status, handoff } = await manager.start()
    if (handoff) opened.push(new URL(handoff.url))
    return status
  }
  return { manager, provider: on, opened, statuses, logs, fetched, start }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  read: () => T | null | undefined | false,
  what = 'condition',
  timeoutMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const settled = (h: Harness): Promise<AntasphereAccountStatus> =>
  waitFor(() => {
    const s = h.manager.status()
    return s.phase !== 'signing-in' ? s : null
  }, 'the login to settle')

/** Play the user: wait for the browser to be asked (the `n`th time), then
 *  follow the redirect. */
async function browse(h: Harness, n = 0): Promise<{ location: string; response: Response }> {
  const url = await waitFor(() => h.opened[n], 'the browser')
  return h.provider.browse(url)
}

/** A login that lands: the helper proves it, so a test that counts what a
 *  login left behind never counts the leavings of one that did not. */
async function signIn(h: Harness): Promise<AntasphereAccountStatus> {
  const n = h.opened.length
  await h.start()
  const { response } = await browse(h, n)
  expect(response.status).toBe(200)
  const status = await settled(h)
  expect(status.phase, `the login did not land: ${status.lastFailure}`).toBe('signed-in')
  return status
}

/** One raw HTTP request to a loopback port, the request line as given:
 *  what a client that is not a browser, or a hostile one, can send. */
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      data += chunk
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

const fileMode = (dir: string, name: string): number =>
  fs.statSync(path.join(dir, name)).mode & 0o777
const readFile = (dir: string, name: string): string =>
  fs.readFileSync(path.join(dir, name), 'utf-8')
const exists = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name))

describe('the issuer configuration', () => {
  it('is the hub unless the environment names a loopback test provider', () => {
    const def = resolveAntasphereIssuer({})
    expect(def).toMatchObject({ ok: true })
    if (def.ok) expect(def.config).toMatchObject({ insecure: false })
    if (def.ok) expect(def.config.issuer.origin).toBe('https://account.antasphere.com')
    const loop = resolveAntasphereIssuer({ CLAVE_ANTASPHERE_ISSUER: 'http://127.0.0.1:4555' })
    expect(loop.ok && loop.config.insecure).toBe(true)
    const tls = resolveAntasphereIssuer({ CLAVE_ANTASPHERE_ISSUER: 'https://staging.example.test' })
    expect(tls.ok && !tls.config.insecure).toBe(true)
  })
  it('refuses anything that is not a bare https origin, or plain http off 127.0.0.1', () => {
    for (const value of [
      'http://localhost:4555',
      'http://10.0.0.1:4555',
      'http://127.0.0.1:4555/tenant',
      'https://account.antasphere.com/?x=1',
      'https://user:pw@account.antasphere.com',
      'https://account.antasphere.com/#f',
      'ftp://account.antasphere.com',
      'not a url'
    ]) {
      expect(resolveAntasphereIssuer({ CLAVE_ANTASPHERE_ISSUER: value }).ok, value).toBe(false)
    }
  })
  it('a refused override never falls back to the hub: the login is off', async () => {
    const h = harness(electronTestPorts(), {
      env: { CLAVE_ANTASPHERE_ISSUER: 'http://localhost:1' }
    })
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'configuration',
      issuerHost: ''
    })
    await h.start()
    expect(h.manager.status().lastFailure).toBe('configuration')
    expect(h.fetched).toEqual([])
    expect(h.opened).toEqual([])
  })
})

describe.each(eachTestPorts())('on %s', (_name, makePorts) => {
  it('signs in: discovery, a registration, the code flow, and the session sealed on disk', async () => {
    const ports = makePorts()
    const h = harness(ports)
    const before = { ...provider.state.counts }
    const started = await h.start()
    expect(started.phase).toBe('signing-in')
    expect(started.loginStartedAt).toBeTypeOf('number')

    const url = await waitFor(() => h.opened[0], 'the browser')
    // The authorization request: our client, PKCE S256, state and nonce,
    // the loopback callback, and the identity scopes exactly.
    expect(url.origin).toBe(provider.issuer)
    expect(url.pathname).toBe('/authorize')
    const q = url.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(q.get('scope')).toBe(ANTASPHERE_SCOPE)
    expect(q.get('scope')).not.toMatch(/account:/)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(q.get('client_id')).toBe(provider.state.registrations.at(-1)!.registered.client_id)

    const { response } = await provider.browse(url)
    expect(response.status).toBe(200)
    // The page the browser shows never claims the sign-in: that is decided
    // by the exchange that follows, and told in Clave.
    const page = await response.text()
    expect(page).toContain('Go back to Clave')
    expect(page).not.toMatch(/signed in/i)
    const status = await settled(h)
    expect(status.phase).toBe('signed-in')
    expect(status.account).toEqual({
      subject: 'user-7f3a',
      name: 'Ada Example',
      email: 'ada@example.test',
      emailVerified: true
    })
    expect(status.renewable).toBe(true)
    expect(status.lastFailure).toBeNull()
    expect(status.expiresAt).toBeGreaterThan(Date.now())

    // What the provider saw: one registration as a public native client
    // with the minimal grants, one discovery, one code exchange.
    expect(provider.state.counts.register - before.register).toBe(1)
    expect(provider.state.counts.token - before.token).toBe(1)
    const sent = provider.state.registrations.at(-1)!.sent
    expect(sent).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
      scope: ANTASPHERE_SCOPE
    })
    expect(sent.client_secret).toBeUndefined()
    const exchange = provider.state.log.filter((e) => e.path === '/token').at(-1)!
    const form = new URLSearchParams(exchange.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(form.get('client_secret')).toBeNull()
    // The JWKS was read: the signature was checked, not just the claims.
    expect(provider.state.counts.jwks - before.jwks).toBeGreaterThanOrEqual(1)

    // On disk: the registration (no secret, no scope) and the sealed session.
    const clientFile = JSON.parse(readFile(ports.dir, CLIENT))
    expect(Object.keys(clientFile).sort()).toEqual([
      'clientId',
      'issuer',
      'redirectPort',
      'registeredAt',
      'v'
    ])
    expect(clientFile.redirectPort).toBe(Number(q.get('redirect_uri')!.match(/:(\d+)\//)![1]))
    const sessionText = readFile(ports.dir, SESSION)
    const sessionFile = JSON.parse(sessionText)
    expect(Object.keys(sessionFile).sort()).toEqual([
      'clientId',
      'issuer',
      'savedAt',
      'sealed',
      'v'
    ])
    for (const plain of ['ada@example.test', 'Ada Example', 'user-7f3a', 'rt-', 'at-', 'refresh']) {
      expect(sessionText, plain).not.toContain(plain)
    }
    expect(fileMode(ports.dir, SESSION)).toBe(0o600)
    expect(fileMode(ports.dir, CLIENT)).toBe(0o600)
  })

  it('restores the session at the next boot without a network round trip', async () => {
    const ports = makePorts()
    const first = harness(ports)
    await signIn(first)
    first.manager.shutdown()

    const before = { ...provider.state.counts }
    const second = harness(ports)
    expect(second.manager.status().phase).toBe('signed-out')
    await second.manager.restore()
    const status = second.manager.status()
    expect(status.phase).toBe('signed-in')
    expect(status.account?.email).toBe('ada@example.test')
    expect(status.renewable).toBe(true)
    expect(second.fetched).toEqual([])
    expect(provider.state.counts).toEqual(before)
    expect(second.statuses.at(-1)?.phase).toBe('signed-in')
  })

  it('signs out locally: the files go, the status says so, and nothing is sent to the issuer', async () => {
    const ports = makePorts()
    const h = harness(ports)
    await signIn(h)
    const before = { ...provider.state.counts }
    const status = h.manager.signOut()
    expect(status).toMatchObject({ phase: 'signed-out', account: null, lastFailure: null })
    expect(exists(ports.dir, SESSION)).toBe(false)
    // The registration is the install's, not the login's: it stays for the next sign-in.
    expect(exists(ports.dir, CLIENT)).toBe(true)
    expect(provider.state.counts).toEqual(before)
    const again = harness(ports)
    await again.manager.restore()
    expect(again.manager.status().phase).toBe('signed-out')
  })
})

describe('the registration is the install’s', () => {
  it('a second login reuses the client and its loopback port', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    await signIn(h)
    const first = JSON.parse(readFile(ports.dir, CLIENT))
    const registrations = provider.state.counts.register
    h.manager.signOut()
    await signIn(h)
    expect(provider.state.counts.register).toBe(registrations)
    expect(JSON.parse(readFile(ports.dir, CLIENT))).toEqual(first)
    expect(h.opened[1].searchParams.get('client_id')).toBe(first.clientId)
    expect(h.opened[1].searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${first.redirectPort}${CALLBACK_PATH}`
    )
  })

  it('when the stored port is taken, one replacement is registered on a new port', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    await signIn(h)
    const first = JSON.parse(readFile(ports.dir, CLIENT))
    h.manager.signOut()
    // Somebody else now holds the port the registration names.
    const squatter = createServer()
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(first.redirectPort, '127.0.0.1', () => resolve())
    })
    try {
      const registrations = provider.state.counts.register
      await signIn(h)
      expect(provider.state.counts.register).toBe(registrations + 1)
      const replaced = JSON.parse(readFile(ports.dir, CLIENT))
      expect(replaced.clientId).not.toBe(first.clientId)
      expect(replaced.redirectPort).not.toBe(first.redirectPort)
      expect(h.logs.some((l) => l.event === 'antasphere.listener.port-taken')).toBe(true)
      // And the replacement is what the next login reuses.
      h.manager.signOut()
      await signIn(h)
      expect(provider.state.counts.register).toBe(registrations + 1)
    } finally {
      await new Promise((r) => squatter.close(r))
    }
  })

  it('a registration that comes back confidential, or is refused, is not kept', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    provider.state.confidentialNext = true
    await h.start()
    expect((await settled(h)).lastFailure).toBe('registration')
    expect(exists(ports.dir, CLIENT)).toBe(false)
    expect(h.opened).toEqual([])

    provider.state.refuseRegistrationOnce = 403
    await h.start()
    expect((await settled(h)).lastFailure).toBe('registration')
    expect(exists(ports.dir, CLIENT)).toBe(false)
    expect(h.opened).toEqual([])
  })
})

describe('what the callback accepts', () => {
  it('ignores a callback with another state, and still takes the real one', async () => {
    const h = harness(electronTestPorts())
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'forged')
    callback.searchParams.set('state', 'not-the-state')
    callback.searchParams.set('iss', provider.issuer)
    const forged = await fetch(callback)
    expect(forged.status).toBe(400)
    expect(h.manager.status().phase).toBe('signing-in')
    // No state at all, a POST, another path: nothing consumed either.
    expect((await fetch(new URL(url.searchParams.get('redirect_uri')!))).status).toBe(400)
    expect((await fetch(callback, { method: 'POST' })).status).toBe(404)
    expect((await fetch(new URL('/other', callback))).status).toBe(404)
    expect(h.manager.status().phase).toBe('signing-in')
    const { response } = await provider.browse(url)
    expect(response.status).toBe(200)
    expect((await settled(h)).phase).toBe('signed-in')
  })

  it('a second callback with the right state after the first changes nothing', async () => {
    const h = harness(electronTestPorts())
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    const { location } = await provider.browse(url)
    await settled(h)
    expect(h.manager.status().phase).toBe('signed-in')
    // The listener is gone with the login; a replay lands on nothing.
    await expect(fetch(location)).rejects.toThrow()
  })

  it('the hub saying no is a denial, not an error', async () => {
    const h = harness(electronTestPorts())
    provider.state.denyNext = true
    await h.start()
    const { response } = await browse(h)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('did not complete')
    const status = await settled(h)
    expect(status).toMatchObject({ phase: 'signed-out', lastFailure: 'denied', account: null })
  })
})

describe('a token that does not validate is no login', () => {
  const cases: Array<[string, () => void]> = [
    ['signed by another key', () => (provider.state.tamper = { key: 'other' })],
    ['from another issuer', () => (provider.state.tamper = { iss: 'https://evil.example.test' })],
    ['for another audience', () => (provider.state.tamper = { aud: 'someone-else' })],
    ['with another nonce', () => (provider.state.tamper = { nonce: 'replayed' })],
    [
      'already expired',
      () => (provider.state.tamper = { exp: Math.floor(Date.now() / 1000) - 600 })
    ]
  ]
  it.each(cases)('%s', async (_name, arrange) => {
    const ports = electronTestPorts()
    const h = harness(ports)
    arrange()
    await h.start()
    await browse(h)
    const status = await settled(h)
    expect(status).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'invalid-response',
      account: null
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
    // And the failure crosses as a code: the status carries no server text.
    expect(JSON.stringify(status)).not.toMatch(/evil|replayed|someone-else|JWT|signature/)
  })
})

describe('the issuer is pinned and every request bounded', () => {
  it('metadata that points off the issuer is refused before anything is sent there', async () => {
    const h = harness(electronTestPorts())
    provider.state.foreignTokenEndpoint = 'http://127.0.0.1:9/token'
    await h.start()
    const status = await settled(h)
    expect(status.lastFailure).toBe('invalid-response')
    expect(h.opened).toEqual([])
    expect(h.fetched.every((u) => u.startsWith(provider.issuer))).toBe(true)
  })
  it('an answer too large for the bound is a network failure', async () => {
    const h = harness(electronTestPorts())
    provider.state.discoveryPadBytes = 300 * 1024
    await h.start()
    expect((await settled(h)).lastFailure).toBe('network')
    expect(h.opened).toEqual([])
  })
  it('an issuer that cannot be reached is a network failure', async () => {
    const h = harness(electronTestPorts(), {
      env: { CLAVE_ANTASPHERE_ISSUER: 'http://127.0.0.1:9' }
    })
    await h.start()
    expect((await settled(h)).lastFailure).toBe('network')
  })
})

describe('cancelling and signing out beat any answer still in flight', () => {
  it('cancel closes the listener; the browser’s answer lands on nothing', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    const first = await fetch(url, { redirect: 'manual' })
    const location = first.headers.get('location')!
    const status = h.manager.cancel()
    expect(status).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    await expect(fetch(location)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(h.manager.dismissFailure().lastFailure).toBeNull()
  })

  it('a cancel during the code exchange drops the tokens that arrive after it', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    provider.state.tokenDelayMs = 300
    await h.start()
    const { response } = await browse(h)
    expect(response.status).toBe(200)
    await waitFor(() => provider.state.log.some((e) => e.path === '/token'), 'the exchange')
    h.manager.cancel()
    await new Promise((r) => setTimeout(r, 600))
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(h.logs.some((l) => l.event === 'antasphere.login.dropped')).toBe(true)
  })

  it('a sign-out during a renewal drops the renewed session', async () => {
    const ports = electronTestPorts()
    const h = harness(ports, {}, brief)
    await signIn(h)
    h.manager.shutdown()
    await sleep(LAPSE_MS)
    const later = harness(ports, {}, brief)
    brief.state.refreshDelayMs = 300
    const refreshes = brief.state.counts.refresh
    const restoring = later.manager.restore()
    await waitFor(() => brief.state.counts.refresh > refreshes, 'the refresh')
    later.manager.signOut()
    await restoring
    expect(later.manager.status()).toMatchObject({ phase: 'signed-out', account: null })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(later.logs.some((l) => l.event === 'antasphere.renew.dropped')).toBe(true)
  })

  it('a login nobody finishes times out', async () => {
    const h = harness(electronTestPorts(), { loginTimeoutMs: 150 })
    await h.start()
    await waitFor(() => h.opened[0], 'the browser')
    const status = await settled(h)
    expect(status.lastFailure).toBe('timeout')
    expect(status.phase).toBe('signed-out')
  })

  it('shutdown stops a login in flight and fires nothing later', async () => {
    const h = harness(electronTestPorts())
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    h.manager.shutdown()
    await expect(fetch(new URL(url.searchParams.get('redirect_uri')!))).rejects.toThrow()
    await h.start()
    expect(h.manager.status().phase).toBe('signed-out')
  })
})

describe('restoring a stored session', () => {
  /** A login on the given issuer, its manager shut down: the files alone. */
  async function storedSession(
    on: OidcProvider = provider
  ): Promise<{ ports: ReturnType<typeof electronTestPorts> }> {
    const ports = electronTestPorts()
    const h = harness(ports, {}, on)
    await signIn(h)
    h.manager.shutdown()
    return { ports }
  }

  it('renews a lapsed session with its refresh token, the same person', async () => {
    const { ports } = await storedSession(brief)
    await sleep(LAPSE_MS)
    const later = harness(ports, {}, brief)
    const refreshes = brief.state.counts.refresh
    await later.manager.restore()
    const status = later.manager.status()
    expect(status.phase).toBe('signed-in')
    expect(status.account?.subject).toBe('user-7f3a')
    expect(brief.state.counts.refresh).toBe(refreshes + 1)
    expect(status.expiresAt).toBeGreaterThan(Date.now())
    const form = new URLSearchParams(
      brief.state.log.filter((e) => e.path === '/token').at(-1)!.body
    )
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_secret')).toBeNull()
  })

  it('a renewal that names another person is refused and the session discarded', async () => {
    const { ports } = await storedSession(brief)
    await sleep(LAPSE_MS)
    const later = harness(ports, {}, brief)
    brief.state.tamper = { sub: 'someone-else' }
    await later.manager.restore()
    expect(later.manager.status()).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'invalid-response'
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
  })

  it('a renewal refused by the issuer discards the session; the network being down keeps it', async () => {
    const { ports } = await storedSession(brief)
    await sleep(LAPSE_MS)
    const refused = harness(ports, {}, brief)
    // The token the file holds is unknown to a provider that forgot it.
    brief.state.refreshTokens.clear()
    await refused.manager.restore()
    expect(refused.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, SESSION)).toBe(false)

    const { ports: ports2 } = await storedSession(brief)
    await sleep(LAPSE_MS)
    const offline = harness(
      ports2,
      {
        fetch: async () => {
          throw new TypeError('fetch failed')
        }
      },
      brief
    )
    await offline.manager.restore()
    expect(offline.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'network' })
    expect(exists(ports2.dir, SESSION)).toBe(true)
  })

  it('a lapsed session without a refresh token is simply gone at the next boot', async () => {
    brief.state.issueRefresh = false
    const { ports } = await storedSession(brief)
    await sleep(LAPSE_MS)
    const later = harness(ports, {}, brief)
    await later.manager.restore()
    expect(later.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(later.fetched).toEqual([])
  })

  it('a session bound to another issuer or another client is discarded', async () => {
    const { ports } = await storedSession()
    const file = JSON.parse(readFile(ports.dir, SESSION))
    fs.writeFileSync(
      path.join(ports.dir, SESSION),
      JSON.stringify({ ...file, clientId: 'another' })
    )
    const h = harness(ports)
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(h.fetched).toEqual([])
  })

  it('a sealed record that does not open, or opens to something else, is discarded', async () => {
    const { ports } = await storedSession()
    const file = JSON.parse(readFile(ports.dir, SESSION))
    fs.writeFileSync(
      path.join(ports.dir, SESSION),
      JSON.stringify({ ...file, sealed: 'bm90IG91cnM=' })
    )
    const h = harness(ports)
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, SESSION)).toBe(false)

    const { ports: ports2 } = await storedSession()
    const file2 = JSON.parse(readFile(ports2.dir, SESSION))
    fs.writeFileSync(
      path.join(ports2.dir, SESSION),
      JSON.stringify({ ...file2, sealed: ports2.secrets.seal('{"v":1,"not":"a session"}') })
    )
    const h2 = harness(ports2)
    await h2.manager.restore()
    expect(h2.manager.status().phase).toBe('signed-out')
    expect(exists(ports2.dir, SESSION)).toBe(false)
    expect(h2.fetched).toEqual([])
  })

  it('a malformed or truncated file is discarded', async () => {
    const { ports } = await storedSession()
    fs.writeFileSync(path.join(ports.dir, SESSION), '{"v":1,"sea')
    const h = harness(ports)
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-out')
  })

  it('without OS encryption the session is not a login, and no login can start', async () => {
    const { ports } = await storedSession()
    const flag = { available: false }
    const dark = harness(electronTestPorts(ports.dir, flag))
    await dark.manager.restore()
    expect(dark.manager.status()).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'storage',
      secureStorage: false
    })
    // Kept: the encryption may be back at the next boot.
    expect(exists(ports.dir, SESSION)).toBe(true)
    await dark.start()
    expect(dark.manager.status().lastFailure).toBe('storage')
    expect(dark.opened).toEqual([])
    flag.available = true
    expect(dark.manager.status().secureStorage).toBe(true)
  })

  it('on the Keychain adapter a sealed record from another machine opens to nothing', async () => {
    const dir = tempDataDir()
    const h = harness(standaloneTestPorts(dir))
    await signIn(h)
    h.manager.shutdown()
    // Another machine: same files, an empty keychain.
    const elsewhere = harness(standaloneTestPorts(dir))
    await elsewhere.manager.restore()
    expect(elsewhere.manager.status().phase).toBe('signed-out')
    expect(exists(dir, SESSION)).toBe(false)
  })

  it('a disk that fails is a storage failure in the status, never a rejection', async () => {
    const { ports } = await storedSession()
    const broken: SettingsPorts = {
      secrets: ports.secrets,
      storage: {
        ...ports.storage,
        read: () => {
          throw new Error('EIO')
        }
      }
    }
    const h = harness(broken)
    await expect(h.manager.restore()).resolves.toBeUndefined()
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'storage' })
    expect(h.logs.some((l) => l.event === 'antasphere.restore.failed')).toBe(true)
  })

  it('a sign-out whose file cannot be removed invalidates the record in place', async () => {
    // The Electron adapter: the ciphertext IS the file and discard is a
    // no-op, so a file left intact would be a login again at the next boot.
    const { ports } = await storedSession()
    const h = harness({
      secrets: ports.secrets,
      storage: {
        ...ports.storage,
        remove: () => {
          throw new Error('EPERM')
        }
      }
    })
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-in')
    expect(h.manager.signOut()).toMatchObject({
      phase: 'signed-out',
      account: null,
      lastFailure: null
    })
    expect(h.logs.some((l) => l.event === 'antasphere.session.remove-failed')).toBe(true)
    // The file is still there, and is no session.
    expect(JSON.parse(readFile(ports.dir, SESSION))).toEqual({ v: 1, revoked: true })
    expect(fileMode(ports.dir, SESSION)).toBe(0o600)
    const later = harness(ports)
    await later.manager.restore()
    expect(later.manager.status()).toMatchObject({ phase: 'signed-out', account: null })
    expect(later.fetched).toEqual([])
  })

  it('a sign-out that can neither remove nor invalidate the record is shown as a storage failure', async () => {
    const { ports } = await storedSession()
    const before = readFile(ports.dir, SESSION)
    const h = harness({
      secrets: ports.secrets,
      storage: {
        ...ports.storage,
        remove: () => {
          throw new Error('EPERM')
        },
        write: () => {
          throw new Error('EROFS')
        }
      }
    })
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-in')
    expect(() => h.manager.signOut()).not.toThrow()
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-out',
      account: null,
      lastFailure: 'storage'
    })
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'signed-out', lastFailure: 'storage' })
    expect(h.logs.some((l) => l.event === 'antasphere.session.clear-failed')).toBe(true)
    // Honestly: the record is intact, and a boot on a disk that works would
    // restore it. That is why the failure is shown rather than a sign-out.
    expect(readFile(ports.dir, SESSION)).toBe(before)
    const back = harness(ports)
    await back.manager.restore()
    expect(back.manager.status().phase).toBe('signed-in')
  })
})

describe('what the listener accepts on the wire', () => {
  it('answers a malformed or foreign request target with 400 and keeps the login waiting', async () => {
    const h = harness(electronTestPorts())
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    const port = Number(new URL(url.searchParams.get('redirect_uri')!).port)
    const state = url.searchParams.get('state')!
    // An absolute-form target that does not parse (a port out of range).
    const malformed = await rawRequest(
      port,
      `GET http://evil.example:99999/callback?state=${state}&code=x HTTP/1.1`
    )
    expect(malformed).toMatch(/^HTTP\/1\.1 400 /)
    expect(malformed).toContain('not valid')
    // An absolute-form target naming another origin, with the genuine state.
    const foreign = await rawRequest(
      port,
      `GET http://evil.example/callback?state=${state}&code=x&iss=${encodeURIComponent(provider.issuer)} HTTP/1.1`
    )
    expect(foreign).toMatch(/^HTTP\/1\.1 400 /)
    // A path that is not the callback, and a method that is not GET.
    expect(await rawRequest(port, `GET /elsewhere?state=${state} HTTP/1.1`)).toMatch(/ 404 /)
    expect(await rawRequest(port, `POST /callback?state=${state} HTTP/1.1`)).toMatch(/ 404 /)
    // The login is still waiting, and the real answer still lands.
    expect(h.manager.status().phase).toBe('signing-in')
    const { response } = await provider.browse(url)
    expect(response.status).toBe(200)
    expect((await settled(h)).phase).toBe('signed-in')
    expect(unhandled).toEqual([])
  })
})

describe('a lapsed identity with a refresh token', () => {
  it('reads signed out while its renewal runs, and signed in once it lands', async () => {
    const clock = { offset: 0 }
    const h = harness(electronTestPorts(), { now: () => Date.now() + clock.offset })
    const status = await signIn(h)
    // The renewed tokens must outlive the clock we are about to set.
    provider.state.idTokenTtlSec = 7200
    provider.state.accessTokenTtlSec = 7200
    provider.state.refreshDelayMs = 400
    const refreshes = provider.state.counts.refresh
    clock.offset = status.expiresAt! - Date.now() + 1000
    const lapsed = h.manager.status()
    expect(lapsed).toMatchObject({
      phase: 'signed-out',
      account: null,
      expiresAt: null,
      renewable: true,
      lastFailure: 'expired'
    })
    // The read kicked the renewal; while it runs the identity is not a login,
    // and every window was told so, not only the reader.
    await waitFor(() => provider.state.counts.refresh > refreshes, 'the refresh')
    expect(h.manager.status().phase).toBe('signed-out')
    await waitFor(() => h.statuses.at(-1)?.phase === 'signed-out', 'the lapse push')
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
    await waitFor(() => h.logs.some((l) => l.event === 'antasphere.renew.ok'), 'the renewal')
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-in',
      lastFailure: null,
      renewable: true
    })
    expect(h.manager.status().account?.subject).toBe('user-7f3a')
    expect(h.statuses.at(-1)?.phase).toBe('signed-in')
  })

  it('stays signed out when the renewal is refused', async () => {
    const clock = { offset: 0 }
    const ports = electronTestPorts()
    const h = harness(ports, { now: () => Date.now() + clock.offset })
    const status = await signIn(h)
    provider.state.refreshTokens.clear()
    clock.offset = status.expiresAt! - Date.now() + 1000
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
    await waitFor(() => h.logs.some((l) => l.event === 'antasphere.renew.failed'), 'the refusal')
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-out',
      account: null,
      renewable: false,
      lastFailure: 'invalid-response'
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
  })

  it('a session further away than a timer can hold is re-armed, never ended early', async () => {
    const ports = electronTestPorts()
    const issuer = new URL(provider.issuer).origin
    const clientId = 'dcr-far-away'
    const DAY = 24 * 3600_000
    const far = Date.now() + 40 * DAY // past the 2^31 - 1 ms a timer holds (~24.8 days)
    fs.writeFileSync(
      path.join(ports.dir, CLIENT),
      JSON.stringify({ v: 1, issuer, clientId, redirectPort: 4567, registeredAt: Date.now() })
    )
    const secret = {
      v: 1,
      issuer,
      clientId,
      account: { subject: 'far', name: 'Far Away', email: 'far@example.test', emailVerified: true },
      signedInAt: Date.now(),
      expiresAt: far,
      refreshToken: null
    }
    fs.writeFileSync(
      path.join(ports.dir, SESSION),
      JSON.stringify({
        v: 1,
        issuer,
        clientId,
        sealed: ports.secrets.seal(JSON.stringify(secret)),
        savedAt: Date.now()
      })
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const h = harness(ports)
      await h.manager.restore()
      expect(h.manager.status()).toMatchObject({ phase: 'signed-in', expiresAt: far })
      // The platform's maximum passes: not due, so the timer is re-armed.
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
      expect(h.manager.status()).toMatchObject({ phase: 'signed-in', expiresAt: far })
      // The rest of the way: due now.
      await vi.advanceTimersByTimeAsync(far - Date.now() + 1)
      expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
      expect(h.fetched).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the windows hear a lapse while the renewal is still pending', () => {
  /** A stored login, then a fresh manager on fake timers whose renewal
   *  never answers: what the timers do on their own, with nothing read. */
  async function armed(): Promise<{ h: Harness; expiresAt: number; calls: string[] }> {
    const ports = electronTestPorts()
    const first = harness(ports)
    const { expiresAt } = await signIn(first)
    first.manager.shutdown()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls: string[] = []
    const h = harness(ports, {
      fetch: (input: string | URL | Request) => {
        calls.push(String(input))
        return new Promise<Response>(() => {})
      }
    })
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-in')
    return { h, expiresAt: expiresAt!, calls }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the end timer pushes signed out when the renewal started on time has not landed', async () => {
    const { h, expiresAt, calls } = await armed()
    // A minute ahead: the renewal is asked for, and hangs.
    await vi.advanceTimersByTimeAsync(expiresAt - 60_000 - Date.now() + 10)
    expect(calls.length).toBeGreaterThan(0)
    expect(h.manager.status().phase).toBe('signed-in')
    // The end: the windows hear it, without anybody reading.
    await vi.advanceTimersByTimeAsync(expiresAt - Date.now() + 10)
    expect(h.statuses.at(-1)).toMatchObject({
      phase: 'signed-out',
      account: null,
      renewable: true,
      lastFailure: 'expired'
    })
    expect(h.logs.filter((l) => l.event === 'antasphere.session.lapsed')).toHaveLength(1)
    // And once only: more ticks tell nothing new and ask for no second renewal.
    const asked = calls.length
    const pushes = h.statuses.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.statuses.length).toBe(pushes)
    expect(calls.length).toBe(asked)
  })

  it('a renewal timer that fires past the end pushes the lapse itself, before the end timer', async () => {
    const { h, expiresAt, calls } = await armed()
    // The delay the renewal timer was armed with, a minute ahead of the end.
    const toRenewal = expiresAt - 60_000 - Date.now()
    // The wall clock jumps past the end while no timer fires (a sleep: timers
    // wait on their remaining delay, the clock does not).
    vi.setSystemTime(expiresAt + 5 * 60_000)
    expect(h.statuses.at(-1)?.phase).toBe('signed-in')
    // Only the renewal timer's own delay runs out; the end timer is still
    // a minute of ticks away and nobody reads the status.
    await vi.advanceTimersByTimeAsync(toRenewal + 10)
    expect(h.statuses.at(-1)).toMatchObject({
      phase: 'signed-out',
      account: null,
      renewable: true,
      lastFailure: 'expired'
    })
    expect(h.logs.filter((l) => l.event === 'antasphere.session.lapsed')).toHaveLength(1)
    // The renewal was asked for and is pending; the end timer has not fired.
    expect(calls.length).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    // When the end timer does fire, it has nothing new to tell.
    const pushes = h.statuses.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.statuses.length).toBe(pushes)
    expect(h.logs.filter((l) => l.event === 'antasphere.session.lapsed')).toHaveLength(1)
  })
})

describe('a renewal keeps the profile it was shown', () => {
  /** A login, then a lapse on the injected clock with renewed tokens that
   *  outlive it: the renewal runs on the next read. */
  async function lapse(
    h: Harness,
    status: AntasphereAccountStatus,
    clock: { offset: number }
  ): Promise<void> {
    provider.state.idTokenTtlSec = 7200
    provider.state.accessTokenTtlSec = 7200
    clock.offset = status.expiresAt! - Date.now() + 1000
    h.manager.status()
    await waitFor(
      () =>
        h.logs.some(
          (l) => l.event === 'antasphere.renew.ok' || l.event === 'antasphere.renew.failed'
        ),
      'the renewal'
    )
  }

  it('asks userinfo when the renewed token carries no email', async () => {
    const clock = { offset: 0 }
    const h = harness(electronTestPorts(), { now: () => Date.now() + clock.offset })
    const status = await signIn(h)
    expect(status.account).toMatchObject({ name: 'Ada Example', email: 'ada@example.test' })
    const infos = provider.state.counts.userinfo
    provider.state.tamper = { omitClaims: true }
    await lapse(h, status, clock)
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-in',
      account: {
        subject: 'user-7f3a',
        name: 'Ada Example',
        email: 'ada@example.test',
        emailVerified: true
      }
    })
    expect(provider.state.counts.userinfo).toBe(infos + 1)
  })

  it('keeps what the login had when userinfo cannot answer either', async () => {
    const clock = { offset: 0 }
    const h = harness(electronTestPorts(), { now: () => Date.now() + clock.offset })
    const status = await signIn(h)
    provider.state.tamper = { omitClaims: true }
    provider.state.userinfoFail = true
    await lapse(h, status, clock)
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-in',
      account: {
        subject: 'user-7f3a',
        name: 'Ada Example',
        email: 'ada@example.test',
        emailVerified: true
      }
    })
    expect(h.logs.some((l) => l.event === 'antasphere.renew.userinfo-failed')).toBe(true)
  })

  it('a renewal that names no lifetime ends the login, once, with no loop', async () => {
    const clock = { offset: 0 }
    const ports = electronTestPorts()
    const h = harness(ports, { now: () => Date.now() + clock.offset })
    const status = await signIn(h)
    provider.state.bareRefresh = true
    const refreshes = provider.state.counts.refresh
    await lapse(h, status, clock)
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-out',
      account: null,
      renewable: false,
      lastFailure: 'invalid-response'
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(provider.state.counts.refresh).toBe(refreshes + 1)
    // Several renewal ticks later: nothing was asked for again.
    await sleep(2_500)
    expect(provider.state.counts.refresh).toBe(refreshes + 1)
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', renewable: false })
    expect(h.statuses.at(-1)).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'invalid-response'
    })
  })
})

describe('what the library tolerates and the login still refuses', () => {
  it('an ID token a few seconds past its expiry, inside the clock tolerance, is no login', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    // openid-client allows 30 s of skew; the login keeps nothing with no time left.
    provider.state.tamper = { exp: Math.floor(Date.now() / 1000) - 5 }
    await h.start()
    await browse(h)
    const status = await settled(h)
    expect(status).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'invalid-response',
      account: null
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(h.statuses.some((s) => s.phase === 'signed-in')).toBe(false)
    // The token itself was exchanged: it is the arrival guard that refused, not the library.
    expect(provider.state.counts.token).toBeGreaterThan(0)
  })

  it('a renewed ID token a few seconds past its expiry is refused once, and nothing is asked again', async () => {
    // The renewal runs on its own clock a second after the login (3 s tokens);
    // the token it gets back is inside the library's tolerance but already past.
    const ports = electronTestPorts()
    const h = harness(ports, {}, brief)
    await signIn(h)
    const signedInPushes = h.statuses.filter((s) => s.phase === 'signed-in').length
    const refreshes = brief.state.counts.refresh
    brief.state.tamper = { exp: Math.floor(Date.now() / 1000) - 5 }
    await waitFor(
      () => h.logs.some((l) => l.event === 'antasphere.renew.failed'),
      'the refusal',
      8000
    )
    expect(h.manager.status()).toMatchObject({
      phase: 'signed-out',
      account: null,
      renewable: false,
      lastFailure: 'invalid-response'
    })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(brief.state.counts.refresh).toBe(refreshes + 1)
    // Several renewal ticks later: no second request, and no signed-in push since.
    await sleep(3_500)
    expect(brief.state.counts.refresh).toBe(refreshes + 1)
    expect(h.statuses.filter((s) => s.phase === 'signed-in')).toHaveLength(signedInPushes)
    expect(h.statuses.at(-1)).toMatchObject({
      phase: 'signed-out',
      lastFailure: 'invalid-response'
    })
  })

  it('a callback carrying two state values is refused and the login keeps waiting', async () => {
    const h = harness(electronTestPorts())
    await h.start()
    const url = await waitFor(() => h.opened[0], 'the browser')
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.append('state', url.searchParams.get('state')!)
    callback.searchParams.append('state', 'other')
    callback.searchParams.set('code', 'x')
    callback.searchParams.set('iss', provider.issuer)
    expect((await fetch(callback)).status).toBe(400)
    expect(h.manager.status().phase).toBe('signing-in')
    const { response } = await provider.browse(url)
    expect(response.status).toBe(200)
    expect((await settled(h)).phase).toBe('signed-in')
  })
})

describe('a login lasts as long as its identity', () => {
  it('ends when the ID token does, even with a longer-lived access token', async () => {
    const skewed = await startOidcProvider({ idTokenTtlSec: 2, accessTokenTtlSec: 3600 })
    try {
      const h = harness(electronTestPorts(), {}, skewed)
      const before = Date.now()
      const status = await signIn(h)
      expect(status.expiresAt).toBeGreaterThan(before)
      expect(status.expiresAt).toBeLessThanOrEqual(Date.now() + 2_500)
    } finally {
      await skewed.close()
    }
  })

  it('and no later than the access token when that is the shorter', async () => {
    const skewed = await startOidcProvider({ idTokenTtlSec: 3600, accessTokenTtlSec: 2 })
    try {
      const h = harness(electronTestPorts(), {}, skewed)
      const status = await signIn(h)
      expect(status.expiresAt).toBeLessThanOrEqual(Date.now() + 2_500)
    } finally {
      await skewed.close()
    }
  })

  it('without a refresh token a running app signs out when the login lapses', async () => {
    brief.state.issueRefresh = false
    const ports = electronTestPorts()
    const h = harness(ports, {}, brief)
    const refreshes = brief.state.counts.refresh
    const status = await signIn(h)
    expect(status.renewable).toBe(false)
    expect(status.phase).toBe('signed-in')
    await waitFor(() => h.manager.status().phase === 'signed-out', 'the lapse', LAPSE_MS + 5000)
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
    // And the windows hear it, whichever of the timer or a read noticed first.
    await waitFor(() => h.statuses.at(-1)?.phase === 'signed-out', 'the push')
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
    expect(exists(ports.dir, SESSION)).toBe(false)
    expect(brief.state.counts.refresh).toBe(refreshes)
  })

  it('a read past the end is signed out even before the timer fires', async () => {
    brief.state.issueRefresh = false
    const clock = { now: Date.now() }
    const h = harness(electronTestPorts(), { now: () => clock.now }, brief)
    const status = await signIn(h)
    expect(status.phase).toBe('signed-in')
    clock.now = status.expiresAt! + 1
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'expired' })
  })

  it('with a refresh token a running app renews ahead of the lapse and stays signed in', async () => {
    const h = harness(electronTestPorts(), {}, brief)
    await signIn(h)
    const refreshes = brief.state.counts.refresh
    await waitFor(() => brief.state.counts.refresh > refreshes, 'the renewal')
    await waitFor(
      () => h.logs.some((l) => l.event === 'antasphere.renew.ok'),
      'the renewal landing'
    )
    expect(h.manager.status()).toMatchObject({ phase: 'signed-in', renewable: true })
    expect(h.manager.status().account?.subject).toBe('user-7f3a')
  })
})

describe('the secret port holds one item per login', () => {
  it('a renewal replaces the sealed item rather than adding one', async () => {
    const ports = standaloneTestPorts()
    const h = harness(ports, {}, brief)
    await signIn(h)
    expect(ports.security.items.size).toBe(1)
    const first = [...ports.security.items.keys()][0]
    await waitFor(() => h.logs.some((l) => l.event === 'antasphere.renew.ok'), 'a renewal')
    expect(ports.security.items.size).toBe(1)
    expect([...ports.security.items.keys()][0]).not.toBe(first)
    h.manager.signOut()
    expect(ports.security.items.size).toBe(0)
  })

  it('a file that cannot be written leaves no item behind, and no login', async () => {
    const ports = standaloneTestPorts()
    const broken: SettingsPorts = {
      secrets: ports.secrets,
      storage: {
        ...ports.storage,
        write: (name, text, options) => {
          if (name === SESSION) throw new Error('ENOSPC')
          ports.storage.write(name, text, options)
        }
      }
    }
    const h = harness(broken)
    await h.start()
    await browse(h)
    expect(await settled(h)).toMatchObject({ phase: 'signed-out', lastFailure: 'storage' })
    expect(ports.security.items.size).toBe(0)
    expect(exists(ports.dir, SESSION)).toBe(false)
  })
})

describe('nothing in flight outlives a cancel, a sign-out, a new login or a shutdown', () => {
  it('a cancel during a slow discovery leaves no rejection and no login', async () => {
    const h = harness(electronTestPorts())
    provider.state.discoveryDelayMs = 300
    const starting = h.start()
    await sleep(50)
    h.manager.cancel()
    // The start answers once the login is over: the status, and no handoff.
    expect(await starting).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    await sleep(500)
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    expect(h.opened).toEqual([])
    expect(h.logs.some((l) => l.event === 'antasphere.login.dropped')).toBe(true)
    expect(unhandled).toEqual([])
  })

  it('a cancel during a slow registration leaves no rejection and no registration', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    provider.state.registerDelayOnceMs = 300
    const starting = h.start()
    await sleep(50)
    h.manager.cancel()
    expect(await starting).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    await sleep(500)
    expect(h.manager.status().phase).toBe('signed-out')
    expect(exists(ports.dir, CLIENT)).toBe(false)
    expect(h.opened).toEqual([])
    expect(unhandled).toEqual([])
  })

  it('a cancel between the page being built and the handoff being opened is a cancel', async () => {
    // The shell opens the handoff after the start answers; a cancel in
    // between is what the generation on the handoff is for.
    const h = harness(electronTestPorts())
    const { status, handoff } = await h.manager.start()
    expect(status.phase).toBe('signing-in')
    expect(handoff?.generation).toBe(h.manager.pendingGeneration())
    h.manager.cancel()
    expect(h.manager.pendingGeneration()).toBeNull()
    expect(h.manager.pendingGeneration()).not.toBe(handoff!.generation)
    await sleep(300)
    expect(h.manager.status()).toMatchObject({ phase: 'signed-out', lastFailure: 'cancelled' })
    // The cancelled login's page lands on nothing.
    await expect(h.provider.browse(handoff!.url)).rejects.toThrow()
    expect(unhandled).toEqual([])
  })

  it('a registration that lands after its login was cancelled never overwrites the next one', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    provider.state.registerDelayOnceMs = 400
    const starting = h.start()
    await sleep(50)
    h.manager.cancel()
    expect((await starting).phase).toBe('signed-out')
    // The second login registers at once and lands; the first registration
    // answers after it.
    await signIn(h)
    const kept = JSON.parse(readFile(ports.dir, CLIENT))
    await sleep(500)
    expect(provider.state.counts.register).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(readFile(ports.dir, CLIENT))).toEqual(kept)
    // The late one is recorded last by the provider; the file names the other.
    const late = provider.state.registrations.at(-1)!.registered.client_id
    expect(kept.clientId).not.toBe(late)
    expect(provider.state.registrations.some((r) => r.registered.client_id === kept.clientId)).toBe(
      true
    )
    expect(h.manager.status().phase).toBe('signed-in')
  })

  it('a new login invalidates an older renewal still in flight', async () => {
    const ports = electronTestPorts()
    const first = harness(ports, {}, brief)
    await signIn(first)
    first.manager.shutdown()
    await sleep(LAPSE_MS)
    const h = harness(ports, {}, brief)
    brief.state.refreshDelayMs = 600
    const refreshes = brief.state.counts.refresh
    const restoring = h.manager.restore()
    await waitFor(() => brief.state.counts.refresh > refreshes, 'the refresh')
    // Meanwhile somebody else signs in.
    brief.state.user = { ...brief.state.user, sub: 'someone-new', email: 'new@example.test' }
    try {
      await signIn(h)
      expect(h.manager.status().account?.subject).toBe('someone-new')
      await restoring
      await sleep(100)
      expect(h.manager.status().account?.subject).toBe('someone-new')
      expect(h.logs.some((l) => l.event === 'antasphere.renew.dropped')).toBe(true)
    } finally {
      brief.state.user = { ...brief.state.user, sub: 'user-7f3a', email: 'ada@example.test' }
    }
  })

  it('a renewal that lands after shutdown writes nothing', async () => {
    const ports = electronTestPorts()
    const first = harness(ports, {}, brief)
    await signIn(first)
    first.manager.shutdown()
    await sleep(LAPSE_MS)
    const before = readFile(ports.dir, SESSION)
    const h = harness(ports, {}, brief)
    brief.state.refreshDelayMs = 300
    const refreshes = brief.state.counts.refresh
    const restoring = h.manager.restore()
    await waitFor(() => brief.state.counts.refresh > refreshes, 'the refresh')
    h.manager.shutdown()
    await restoring
    expect(readFile(ports.dir, SESSION)).toBe(before)
    expect(h.statuses.filter((s) => s.phase === 'signed-in')).toEqual([])
    expect(h.logs.some((l) => l.event === 'antasphere.renew.dropped')).toBe(true)
  })
})

describe('what crosses to the windows', () => {
  it('is the status shape and nothing else, in every phase', async () => {
    const ports = electronTestPorts()
    const h = harness(ports)
    const check = (s: AntasphereAccountStatus): void => {
      expect(Object.keys(s).sort()).toEqual([...ANTASPHERE_STATUS_KEYS].sort())
      const text = JSON.stringify(s)
      expect(text).not.toMatch(/token|code=|state=|verifier|nonce|Bearer|rt-|at-/)
      if (s.account)
        expect(Object.keys(s.account).sort()).toEqual(['email', 'emailVerified', 'name', 'subject'])
    }
    check(h.manager.status())
    await h.start()
    check(h.manager.status())
    await browse(h)
    check(await settled(h))
    for (const s of h.statuses) check(s)
    expect(h.manager.status().issuerHost).toBe(new URL(provider.issuer).host)
  })

  it('a second start while one login waits answers the same handoff: the same flow, reopened', async () => {
    const h = harness(electronTestPorts())
    const first = await h.manager.start()
    expect(first.handoff).not.toBeNull()
    const registrations = provider.state.counts.register
    const again = await h.manager.start()
    expect(again.status.phase).toBe('signing-in')
    expect(again.handoff).toEqual(first.handoff)
    expect(provider.state.counts.register).toBe(registrations)
    // Only the preload that asked gets the handoff: the pushed statuses never carry it.
    for (const s of h.statuses) expect(JSON.stringify(s)).not.toContain('authorize')
  })

  it('a handoff confirms while it is the login in flight, and as nothing once it is not', async () => {
    const h = harness(electronTestPorts())
    const { handoff } = await h.manager.start()
    expect(handoff).not.toBeNull()
    expect(h.manager.confirmHandoff(handoff!)).toBe(true)
    // The same URL under another generation, or another URL under this one: no.
    expect(h.manager.confirmHandoff({ ...handoff!, generation: handoff!.generation + 1 })).toBe(
      false
    )
    expect(h.manager.confirmHandoff({ ...handoff!, url: handoff!.url + '&x=1' })).toBe(false)
    expect(h.manager.confirmHandoff({ ...handoff!, url: `${h.provider.issuer}/authorize` })).toBe(
      false
    )
    // The confirmation is a read: nothing started, nothing pushed.
    const pushes = h.statuses.length
    expect(h.manager.confirmHandoff(handoff!)).toBe(true)
    expect(h.statuses).toHaveLength(pushes)
    // A cancel ends it, and a new login issues another the old one is not.
    h.manager.cancel()
    expect(h.manager.confirmHandoff(handoff!)).toBe(false)
    const next = await h.manager.start()
    expect(next.handoff).not.toBeNull()
    expect(next.handoff).not.toEqual(handoff)
    expect(h.manager.confirmHandoff(handoff!)).toBe(false)
    expect(h.manager.confirmHandoff(next.handoff!)).toBe(true)
    // Once the browser came back the page is spent: not even the current one confirms.
    await h.provider.browse(next.handoff!.url)
    expect(h.manager.confirmHandoff(next.handoff!)).toBe(false)
    await settled(h)
    expect(h.manager.status().phase).toBe('signed-in')
    // A sign-out, and a shutdown, confirm nothing either.
    const third = await h.manager.start()
    h.manager.signOut()
    expect(h.manager.confirmHandoff(third.handoff!)).toBe(false)
    const fourth = await h.manager.start()
    h.manager.shutdown()
    expect(h.manager.confirmHandoff(fourth.handoff!)).toBe(false)
  })

  it('a start answers no handoff when the login cannot start', async () => {
    const h = harness(electronTestPorts())
    const dark = harness(electronTestPorts(tempDataDir(), { available: false }))
    expect(await dark.manager.start()).toMatchObject({
      status: { phase: 'signed-out', lastFailure: 'storage' },
      handoff: null
    })
    h.manager.shutdown()
    expect(await h.manager.start()).toMatchObject({ handoff: null })
  })
})

describe('a Unicode identity on the Keychain adapter', () => {
  // The standalone secret port files printable ASCII only (`security -i`
  // reads one command per line, and `-w` prints anything beyond ASCII as
  // hex). A session is the person's own name and email, which are not
  // ASCII for most of the world: the whole session is serialised to ASCII
  // before it is sealed and read back whole, on the Keychain as on
  // `safeStorage`, with the previous plain-JSON shape still opening.
  const UNICODE_USER = {
    sub: 'user-ünï',
    name: 'Zoë Ünïcode 日本語 🚀',
    email: 'zoë@exämple.test',
    email_verified: true
  }
  let accented: OidcProvider
  beforeAll(async () => {
    accented = await startOidcProvider({
      user: UNICODE_USER,
      idTokenTtlSec: 3,
      accessTokenTtlSec: 3
    })
  })
  afterAll(async () => {
    await accented.close()
  })

  it('signs in, seals an ASCII record, restores the Unicode whole, rotates and cleans the Keychain item', async () => {
    const ports = standaloneTestPorts()
    const h = harness(ports, {}, accented)
    const status = await signIn(h)
    expect(status.account).toEqual({
      subject: UNICODE_USER.sub,
      name: UNICODE_USER.name,
      email: UNICODE_USER.email,
      emailVerified: true
    })
    // One item, printable ASCII through and through, the identity not in clear.
    expect(ports.security.items.size).toBe(1)
    const [firstHandle, firstValue] = [...ports.security.items.entries()][0]
    expect(firstValue).toMatch(/^[\x20-\x7e]+$/)
    expect(firstValue).not.toContain('Zoë')
    expect(firstValue).not.toContain('日本語')
    // Every `security` line the adapter sent was ASCII too: a line break or
    // a raw accent there is a second command or a value read back wrong.
    for (const call of ports.security.calls) {
      expect(call.input ?? '').toMatch(/^[\x20-\x7e\n]*$/)
      for (const arg of call.args) expect(arg).toMatch(/^[\x20-\x7e]*$/)
    }
    // Restored by a fresh manager: the same person, every character intact.
    h.manager.shutdown()
    const again = harness(ports, {}, accented)
    await again.manager.restore()
    expect(again.manager.status().phase).toBe('signed-in')
    expect(again.manager.status().account?.name).toBe(UNICODE_USER.name)
    expect(again.manager.status().account?.email).toBe(UNICODE_USER.email)
    // The renewal rotates the item: one item after, the old handle deleted.
    await waitFor(() => again.logs.some((l) => l.event === 'antasphere.renew.ok'), 'a renewal')
    expect(ports.security.items.size).toBe(1)
    const [secondHandle] = [...ports.security.items.keys()]
    expect(secondHandle).not.toBe(firstHandle)
    const deletes = ports.security.calls.filter((c) => c.args[0] === 'delete-generic-password')
    expect(deletes.map((c) => c.args[c.args.indexOf('-a') + 1])).toContain(
      firstHandle.split('\u0000')[1]
    )
    expect(again.manager.status().account?.name).toBe(UNICODE_USER.name)
    // Sign-out leaves nothing filed.
    again.manager.signOut()
    expect(ports.security.items.size).toBe(0)
  })

  it('a record sealed before the serialisation, plain JSON with Unicode, still restores', async () => {
    const ports = electronTestPorts()
    const stored = harness(ports, {}, accented)
    const status = await signIn(stored)
    stored.manager.shutdown()
    // Rewrite the record the way the previous version sealed it: the JSON
    // itself, Unicode and all, through the same `safeStorage` stand-in.
    const file = JSON.parse(readFile(ports.dir, SESSION))
    const opened = ports.secrets.open(file.sealed)!
    const secret = JSON.parse(opened)
    expect(secret.account.name).toBe(UNICODE_USER.name)
    const legacy = JSON.stringify(secret)
    expect(legacy).toContain('Zoë')
    fs.writeFileSync(
      path.join(ports.dir, SESSION),
      JSON.stringify({ ...file, sealed: ports.secrets.seal(legacy) })
    )
    const h = harness(ports, {}, accented)
    await h.manager.restore()
    expect(h.manager.status().phase).toBe('signed-in')
    expect(h.manager.status().account).toEqual(status.account)
  })
})
