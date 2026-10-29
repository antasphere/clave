/**
 * The devices domain through a running server (mobile wave, lane A, issue
 * #281 acceptances 1, 2, 4 and 5): a phone stood in by fetch and a WebSocket,
 * the owner by the server's token, the hub by the local provider. The
 * pairing's lifecycle, the device session's reach and its refusals, the
 * push handshake's origins, the revocation that closes the socket, the push
 * token on lane B's seam, the relay address, the record on disk.
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CLOSE_DEVICE_REVOKED, DEVICE_PAIR_PATH } from '@clave/contract/devices'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'
import { memoryDeviceStorage, type DevicesPortService } from './port'
import { DEVICE_FORBIDDEN_MESSAGE, deviceHearsEvent, deviceMayCall } from './scope'
import { FIXTURE_PATH } from '../fixtures/route'
import { makeDeviceSessions } from './service'

type Provider = Awaited<ReturnType<typeof startOidcProvider>>
const OWNER = 'user-7f3a'

async function mintIdToken(provider: Provider): Promise<{ idToken: string; clientId: string }> {
  const redirect = 'clave://oauth/callback'
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Clave on a phone'
    })
  })
  const { client_id: clientId } = (await registration.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email')
  authorize.searchParams.set('state', 's')
  authorize.searchParams.set('nonce', 'n')
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
  return { idToken: ((await exchanged.json()) as { id_token: string }).id_token, clientId }
}

interface World {
  server: EmbeddedServer
  source: FakeSource
  storage: ReturnType<typeof memoryDeviceStorage>
  owner: { subject: string | null }
  clock: { now: number }
  relay: { url: string }
  asked: Array<{ name: string; platform: string }>
  json: (
    method: 'GET' | 'POST',
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> }
  ) => Promise<{ status: number; body: unknown; headers: Headers }>
  pair: () => Promise<{ pairingId: string; expiresAt: number }>
  device: () => Promise<{ token: string; deviceId: string; pairingId: string }>
  pushUrl: () => string
}

const PHONE = { name: 'Valentin’s iPhone', platform: 'ios' as const, appVersion: '0.1.0' }
let provider: Provider
let world: World | null = null

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
afterEach(async () => {
  await world?.server.stop()
  world = null
})

async function start(options: { owner?: string | null; issuer?: string } = {}): Promise<World> {
  const source = new FakeSource(aSession('s1'))
  const storage = memoryDeviceStorage()
  const owner = { subject: options.owner === undefined ? OWNER : options.owner }
  const clock = { now: Date.now() }
  const relay = { url: '' }
  const asked: World['asked'] = []
  const port: DevicesPortService = {
    storage,
    owner: () => owner.subject,
    issuer: options.issuer ?? provider.issuer,
    serverName: () => 'the-mac',
    relay: { get: () => relay.url, set: (url) => void (relay.url = url) },
    onPairingRequested: (pairing) => void asked.push({ ...pairing }),
    now: () => clock.now
  }
  const server = await startEmbedded({
    ports: { sessions: source, devices: port },
    testFixtures: true
  })
  const json: World['json'] = async (method, path, o = {}) => {
    const token = o.token === undefined ? server.token : o.token
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body, headers: response.headers }
  }
  const pair: World['pair'] = async () => {
    const minted = await mintIdToken(provider)
    const answer = await json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: { ...minted, device: PHONE }
    })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    return answer.body as { pairingId: string; expiresAt: number }
  }
  const device: World['device'] = async () => {
    const { pairingId } = await pair()
    expect((await json('POST', '/devices/approve', { body: { pairingId } })).status).toBe(200)
    const read = await json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })
    const { deviceSession } = read.body as {
      deviceSession: { token: string; deviceId: string }
    }
    return { token: deviceSession.token, deviceId: deviceSession.deviceId, pairingId }
  }
  world = {
    server,
    source,
    storage,
    owner,
    clock,
    relay,
    asked,
    json,
    pair,
    device,
    pushUrl: () => server.url.replace('http:', 'ws:') + '/push'
  }
  return world
}

describe('the pairing', () => {
  it('waits for the owner, issues the session once on the approval, and tells the Mac', async () => {
    const w = await start()
    const { pairingId, expiresAt } = await w.pair()
    expect(expiresAt - w.clock.now).toBe(10 * 60 * 1000)
    expect(w.asked).toEqual([{ name: PHONE.name, platform: 'ios' }])
    expect(
      (await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })).body
    ).toEqual({
      status: 'pending'
    })
    const listed = (await w.json('GET', '/devices')).body as {
      devices: unknown[]
      pending: Array<{ id: string; name: string; platform: string; appVersion: string }>
    }
    expect(listed.devices).toEqual([])
    expect(listed.pending).toMatchObject([{ id: pairingId, ...PHONE }])
    // Nothing is issued before the approval: the record is empty.
    expect(w.storage.read()).toBeNull()
    const approved = await w.json('POST', '/devices/approve', { body: { pairingId } })
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({ ...PHONE, lastSeenAt: null })
    const first = await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })
    expect(first.body).toMatchObject({
      status: 'approved',
      deviceSession: { serverId: w.server.serverId, serverName: 'the-mac' }
    })
    const session = (first.body as { deviceSession: { token: string; deviceId: string } })
      .deviceSession
    expect(session.token).toMatch(/^[0-9a-f]{64}$/)
    expect((approved.body as { id: string }).id).toBe(session.deviceId)
    // Exactly once: the second read carries no token.
    expect(
      (await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })).body
    ).toEqual({
      status: 'approved'
    })
    // The record keeps the hash and never the token.
    const document = w.storage.read()!
    expect(document).toContain(createHash('sha256').update(session.token).digest('hex'))
    expect(document).not.toContain(session.token)
    // The approved pairing is gone from the pending list and the device is listed.
    const after = (await w.json('GET', '/devices')).body as {
      devices: unknown[]
      pending: unknown[]
    }
    expect(after.pending).toEqual([])
    expect(after.devices).toMatchObject([{ id: session.deviceId, ...PHONE }])
  })
  it('refuses the phone when the owner says so, and forgets an unknown pairing as expired', async () => {
    const w = await start()
    const { pairingId } = await w.pair()
    expect((await w.json('POST', '/devices/refuse', { body: { pairingId } })).status).toBe(204)
    expect(
      (await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })).body
    ).toEqual({
      status: 'refused'
    })
    // Settled: a second approval finds nothing to approve.
    const again = await w.json('POST', '/devices/approve', { body: { pairingId } })
    expect(again.status).toBe(422)
    expect(again.body).toMatchObject({ _tag: 'DevicePairingNotFound' })
    expect(
      (await w.json('GET', `${DEVICE_PAIR_PATH}?id=pair-nobody`, { token: null })).body
    ).toEqual({
      status: 'expired'
    })
  })
  it('lapses after ten minutes unanswered, and cannot be approved then', async () => {
    const w = await start()
    const { pairingId } = await w.pair()
    w.clock.now += 10 * 60 * 1000 + 1
    expect(
      (await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })).body
    ).toEqual({
      status: 'expired'
    })
    expect((await w.json('GET', '/devices')).body).toMatchObject({ pending: [] })
    expect((await w.json('POST', '/devices/approve', { body: { pairingId } })).status).toBe(422)
    expect(w.storage.read()).toBeNull()
  })
  it('refuses every token on a server with no owner, by name, before any key is read', async () => {
    const w = await start({ owner: null })
    const minted = await mintIdToken(provider)
    const before = provider.state.counts.jwks
    const answer = await w.json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: { ...minted, device: PHONE }
    })
    expect(answer.status).toBe(422)
    expect(answer.body).toMatchObject({ _tag: 'CapabilityUnavailable', capability: 'devices' })
    expect(provider.state.counts.jwks).toBe(before)
    expect(w.asked).toEqual([])
  })
  it('refuses a token that fails a check, naming the check and never the token', async () => {
    const w = await start()
    provider.state.tamper = { sub: 'user-somebody-else' }
    const minted = await mintIdToken(provider)
    const answer = await w.json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: { ...minted, device: PHONE }
    })
    expect(answer.status).toBe(422)
    expect(answer.body).toMatchObject({ _tag: 'DevicePairingRefused', check: 'subject' })
    expect(JSON.stringify(answer.body)).not.toContain(minted.idToken.slice(0, 20))
    expect(w.asked).toEqual([])
    expect((await w.json('GET', '/devices')).body).toMatchObject({ pending: [] })
  })
  it('refuses a body that is not a pairing request without echoing it, and one that is too big', async () => {
    const w = await start()
    const bad = await w.json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: {
        idToken: 'secret-looking-value',
        clientId: 'c',
        device: { name: 'x', platform: 'tv' }
      }
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).not.toContain('secret-looking-value')
    const big = await w.json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: { idToken: 'x'.repeat(20 * 1024), clientId: 'c', device: PHONE }
    })
    expect(big.status).toBe(413)
  })
  it('refuses the issuer override it cannot accept, as configuration', async () => {
    const w = await start({ issuer: 'http://localhost:1' })
    const minted = await mintIdToken(provider)
    const answer = await w.json('POST', DEVICE_PAIR_PATH, {
      token: null,
      body: { ...minted, device: PHONE }
    })
    expect(answer.body).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'configuration'
    })
  })
})

describe('the device session’s reach', () => {
  it('reaches the sessions, their history, the requests and its own record', async () => {
    const w = await start()
    const { token, deviceId } = await w.device()
    const sessions = await w.json('GET', '/sessions', { token })
    expect(sessions.status).toBe(200)
    expect(sessions.body).toMatchObject([{ id: 's1' }])
    expect((await w.json('GET', '/sessions/history?id=s1', { token })).status).toBe(200)
    // The requests and settings ports are absent here: refused as unavailable
    // (a 422, or the settings' own defect), never as unauthenticated or forbidden.
    expect((await w.json('GET', '/requests/pending', { token })).status).toBe(422)
    const profiles = (await w.json('GET', '/launch-profiles', { token })).status
    expect(profiles !== 401 && profiles !== 403, String(profiles)).toBe(true)
    const workspaces = (await w.json('GET', '/workspaces', { token })).status
    expect(workspaces !== 401 && workspaces !== 403, String(workspaces)).toBe(true)
    const me = await w.json('GET', '/devices/me', { token })
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ id: deviceId, ...PHONE })
  })
  it('is refused on the fixture route, the owner-only device routes, the accounts, the clients and every other route', async () => {
    const w = await start()
    const { token, pairingId } = await w.device()
    const refused: Array<['GET' | 'POST', string, unknown?]> = [
      ['POST', FIXTURE_PATH, { source: '() => 1' }],
      ['GET', '/devices'],
      ['POST', '/devices/approve', { pairingId }],
      ['POST', '/devices/refuse', { pairingId }],
      ['POST', '/devices/revoke', { deviceId: 'x' }],
      ['GET', '/devices/relay'],
      ['POST', '/devices/relay', { url: '' }],
      ['GET', '/accounts/antasphere'],
      ['GET', '/accounts/claude'],
      ['GET', '/clients'],
      ['POST', '/clients', { kind: 'other', name: 'phone' }],
      ['GET', '/plugins'],
      ['GET', '/server/info'],
      ['POST', '/server/upgrade', {}],
      ['POST', '/launch-profiles', {}],
      ['POST', '/workspaces/registry', {}],
      ['GET', '/sidebar/layout?windowKey=w1'],
      ['POST', '/sessions/rename', { id: 's1', name: 'x' }],
      ['POST', '/sessions/type', { id: 's1', text: 'x' }],
      ['GET', '/sessions/screen?id=s1'],
      ['POST', '/files/write', {}],
      ['GET', '/git/status?repo=x'],
      ['POST', '/agent-tools/announce', {}]
    ]
    for (const [method, path, body] of refused) {
      const answer = await w.json(method, path, { token, ...(body !== undefined && { body }) })
      expect(answer.status, `${method} ${path}`).toBe(403)
      expect(answer.body, `${method} ${path}`).toEqual({
        error: 'Forbidden',
        message: DEVICE_FORBIDDEN_MESSAGE
      })
    }
    // The owner keeps every one of them.
    expect((await w.json('GET', '/devices')).status).toBe(200)
    expect((await w.json('POST', FIXTURE_PATH, { body: { source: '() => 1' } })).status).toBe(200)
  })
  it('answers the owner’s token on a phone-only route with the declared refusal', async () => {
    const w = await start()
    const me = await w.json('GET', '/devices/me')
    expect(me.status).toBe(422)
    expect(me.body).toMatchObject({ _tag: 'DeviceSessionRequired' })
    expect(
      (await w.json('POST', '/devices/me/push-token', { body: { token: 't', platform: 'ios' } }))
        .status
    ).toBe(422)
  })
  it('is refused with 401 when it is not a session at all, like any stranger', async () => {
    const w = await start()
    await w.device()
    expect((await w.json('GET', '/sessions', { token: 'a'.repeat(64) })).status).toBe(401)
    expect((await w.json('GET', '/sessions', { token: '' })).status).toBe(401)
  })
  it('records the phone as seen on its calls, at most once a minute, and tells the clients', async () => {
    const w = await start()
    const { token, deviceId } = await w.device()
    const seen = (): number | null =>
      (w.storage.read()
        ? (
            JSON.parse(w.storage.read()!) as {
              devices: Array<{ id: string; lastSeenAt: number | null }>
            }
          ).devices
        : []
      ).find((d) => d.id === deviceId)?.lastSeenAt ?? null
    expect(seen()).toBeNull()
    const t0 = w.clock.now
    await w.json('GET', '/sessions', { token })
    expect(seen()).toBe(t0)
    w.clock.now += 30_000
    await w.json('GET', '/sessions', { token })
    expect(seen()).toBe(t0)
    w.clock.now += 31_000
    await w.json('GET', '/sessions', { token })
    expect(seen()).toBe(t0 + 61_000)
    expect((await w.json('GET', '/devices')).body).toMatchObject({
      devices: [{ id: deviceId, lastSeenAt: t0 + 61_000 }]
    })
  })
  it('ends at the revocation: the next call is 401 and the owner no longer lists it', async () => {
    const w = await start()
    const { token, deviceId } = await w.device()
    expect((await w.json('GET', '/sessions', { token })).status).toBe(200)
    expect((await w.json('POST', '/devices/revoke', { body: { deviceId } })).status).toBe(204)
    expect((await w.json('GET', '/sessions', { token })).status).toBe(401)
    expect((await w.json('GET', '/devices/me', { token })).status).toBe(401)
    expect((await w.json('GET', '/devices')).body).toMatchObject({ devices: [] })
    const twice = await w.json('POST', '/devices/revoke', { body: { deviceId } })
    expect(twice.status).toBe(422)
    expect(twice.body).toMatchObject({ _tag: 'DeviceNotFound' })
  })
})

describe('the push token and lane B’s seam', () => {
  it('lists a token the phone set and not one it cleared; a stale forget keeps the current one', async () => {
    const w = await start()
    const { token, deviceId } = await w.device()
    const service = makeDeviceSessions(
      {
        storage: w.storage,
        owner: () => OWNER,
        issuer: provider.issuer,
        serverName: () => 'the-mac'
      },
      { serverId: 'x' }
    )
    // The seam reads the same document the server writes.
    expect(await runList(service)).toEqual([])
    expect(
      (
        await w.json('POST', '/devices/me/push-token', {
          token,
          body: { token: 'apns-1', platform: 'ios' }
        })
      ).status
    ).toBe(204)
    expect(await runList(freshService(w))).toEqual([{ deviceId, platform: 'ios', token: 'apns-1' }])
    expect(w.storage.read()).toContain('apns-1')
    // Forgetting a token that is no longer the current one changes nothing.
    const stale = freshService(w)
    await runEffect(stale.pushTargets.forget(deviceId, 'apns-0'))
    expect(await runList(stale)).toEqual([{ deviceId, platform: 'ios', token: 'apns-1' }])
    await runEffect(stale.pushTargets.forget(deviceId, 'apns-1'))
    expect(await runList(stale)).toEqual([])
    expect(
      (
        await w.json('POST', '/devices/me/push-token', {
          token,
          body: { token: 'apns-2', platform: 'ios' }
        })
      ).status
    ).toBe(204)
    expect((await w.json('POST', '/devices/me/push-token/clear', { token, body: {} })).status).toBe(
      204
    )
    expect(await runList(freshService(w))).toEqual([])
    expect(w.storage.read()).not.toContain('apns-2')
  })
})

import { Effect } from 'effect'
import type { DeviceSessionsService } from './service'
const runEffect = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)
const runList = (service: DeviceSessionsService): Promise<ReadonlyArray<unknown>> =>
  runEffect(service.pushTargets.list())
const freshService = (w: World): DeviceSessionsService =>
  makeDeviceSessions(
    {
      storage: w.storage,
      owner: () => OWNER,
      issuer: provider.issuer,
      serverName: () => 'the-mac'
    },
    { serverId: 'x' }
  )

describe('the relay address', () => {
  it('is stored as an origin, cleared by an empty value, and refused otherwise', async () => {
    const w = await start()
    expect((await w.json('GET', '/devices/relay')).body).toEqual({ url: '' })
    const set = await w.json('POST', '/devices/relay', {
      body: { url: ' https://Relay.Example.com/ ' }
    })
    expect(set.status).toBe(200)
    expect(set.body).toEqual({ url: 'https://relay.example.com' })
    expect(w.relay.url).toBe('https://relay.example.com')
    expect((await w.json('GET', '/devices/relay')).body).toEqual({
      url: 'https://relay.example.com'
    })
    for (const bad of [
      'relay',
      'ftp://relay.example.com',
      'https://relay.example.com/path',
      'https://u:p@relay.example.com',
      'https://relay.example.com/?q=1'
    ]) {
      const answer = await w.json('POST', '/devices/relay', { body: { url: bad } })
      expect(answer.status, bad).toBe(422)
      expect(answer.body, bad).toMatchObject({ _tag: 'RelayAddressInvalid' })
    }
    expect(w.relay.url).toBe('https://relay.example.com')
    expect((await w.json('POST', '/devices/relay', { body: { url: '' } })).body).toEqual({
      url: ''
    })
    expect(w.relay.url).toBe('')
  })
})

describe('the push channel', () => {
  it('welcomes a hello with a device session, from no Origin, a loopback one or the server’s own address', async () => {
    const w = await start()
    const { token } = await w.device()
    const own = new URL(w.server.url).origin
    for (const origin of [undefined, 'http://localhost:5173', own]) {
      const peer = new Peer(w.pushUrl(), origin === undefined ? {} : { origin })
      await peer.opened
      peer.send({ _tag: 'hello', token })
      expect((await peer.next())._tag, String(origin)).toBe('welcome')
      peer.ws.close()
      await peer.closed
    }
  })
  it('keeps refusing a page from another site, and a session that is not one', async () => {
    const w = await start()
    const { token } = await w.device()
    for (const origin of [
      'http://evil.example',
      `http://evil.example${new URL(w.server.url).host}`,
      'null'
    ]) {
      const refused = new Peer(w.pushUrl(), { origin })
      expect(
        await refused.opened.then(
          () => 'opened',
          (error: Error) => error.message
        ),
        origin
      ).toContain('403')
    }
    const stranger = new Peer(w.pushUrl())
    await stranger.opened
    stranger.send({ _tag: 'hello', token: token.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) })
    expect((await stranger.closed).code).toBe(4001)
  })
  it('closes a phone’s socket when its session is revoked, and leaves the owner’s open', async () => {
    const w = await start()
    const { token, deviceId } = await w.device()
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    expect((await phone.next())._tag).toBe('welcome')
    const mac = new Peer(w.pushUrl())
    await mac.opened
    mac.send({ _tag: 'hello', token: w.server.token })
    expect((await mac.next())._tag).toBe('welcome')
    expect(w.server.connections()).toBe(2)
    expect((await w.json('POST', '/devices/revoke', { body: { deviceId } })).status).toBe(204)
    const closed = await phone.closed
    expect(closed.code).toBe(CLOSE_DEVICE_REVOKED)
    expect(w.server.connections()).toBe(1)
    mac.send({ _tag: 'ping' })
    // The Mac's socket is untouched: the revocation reached it as a devices
    // event, and its ping is answered.
    const frames: string[] = []
    for (let i = 0; i < 3 && !frames.includes('pong'); i++) frames.push((await mac.next())._tag)
    expect(frames).toContain('pong')
    expect(frames).toContain('event')
    mac.ws.close()
    await mac.closed
  })
  it('hands a phone its sessions’ and its own events, and none of the desktop’s', async () => {
    const w = await start()
    const { token } = await w.device()
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    expect((await phone.next())._tag).toBe('welcome')
    await w.server.publish({ _tag: 'plugins.changed' })
    await w.server.publish({ _tag: 'sidebar.layout_removed', windowKey: 'w1' })
    await w.server.publish({ _tag: 'session.state_changed', id: 's1', state: 'working' })
    // The hello itself bumped the devices (the phone was seen), so a
    // `devices.changed` may come first; the session event comes, the
    // desktop's two never do.
    const tags: string[] = []
    for (let i = 0; i < 3 && !tags.includes('session.state_changed'); i++) {
      const frame = await phone.next()
      tags.push(frame._tag === 'event' ? frame.event._tag : frame._tag)
    }
    expect(tags).toContain('session.state_changed')
    expect(tags.every((tag) => tag === 'devices.changed' || tag === 'session.state_changed')).toBe(
      true
    )
    expect(await phone.silence()).toBe(true)
    phone.ws.close()
    await phone.closed
  })
})

describe('the notice a pairing request raises', () => {
  it('tells the owner’s socket the phone’s name and platform, and tells no phone', async () => {
    const w = await start()
    const { token } = await w.device()
    const mac = new Peer(w.pushUrl())
    await mac.opened
    mac.send({ _tag: 'hello', token: w.server.token })
    expect((await mac.next())._tag).toBe('welcome')
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    expect((await phone.next())._tag).toBe('welcome')
    const { pairingId } = await w.pair()
    const heard: unknown[] = []
    for (let i = 0; i < 4; i++) {
      const frame = await mac.next()
      if (frame._tag === 'event') heard.push(frame.event)
      if (frame._tag === 'event' && frame.event._tag === 'devices.pairing_requested') break
    }
    expect(heard).toContainEqual({
      _tag: 'devices.pairing_requested',
      pairingId,
      ...{ name: PHONE.name, platform: 'ios' }
    })
    const phoneHeard: string[] = []
    while (!(await phone.silence(100)))
      phoneHeard.push((await phone.next())._tag === 'event' ? 'event' : 'other')
    // Whatever the phone heard was the revision bump, never the request itself.
    expect(phoneHeard.every((tag) => tag === 'event')).toBe(true)
    mac.ws.close()
    phone.ws.close()
    await Promise.all([mac.closed, phone.closed])
  })
})

describe('the scope, as a table', () => {
  it('names what a phone may call and hears, and nothing more', () => {
    expect(deviceMayCall('GET', '/sessions')).toBe(true)
    expect(deviceMayCall('POST', '/sessions/write')).toBe(true)
    expect(deviceMayCall('GET', '/files/read')).toBe(true)
    expect(deviceMayCall('POST', '/files/write')).toBe(false)
    expect(deviceMayCall('GET', '/workspaces')).toBe(true)
    expect(deviceMayCall('POST', '/workspaces/pins')).toBe(false)
    expect(deviceMayCall('GET', '/devices')).toBe(false)
    expect(deviceMayCall('GET', '/devices/me')).toBe(true)
    expect(deviceMayCall('POST', '/e2e/evaluate')).toBe(false)
    expect(deviceMayCall('DELETE', '/sessions')).toBe(false)
    expect(deviceHearsEvent('session.title_changed')).toBe(true)
    expect(deviceHearsEvent('requests.changed')).toBe(true)
    expect(deviceHearsEvent('accounts.claude_changed')).toBe(false)
    expect(deviceHearsEvent('sidebar.layout_changed')).toBe(false)
  })
})
