/**
 * The devices domain through a running server (mobile wave, lane A, issue
 * #281 acceptances 1, 2, 4 and 5): a phone stood in by fetch and a WebSocket,
 * the owner by the server's token, the hub by the local provider. The
 * pairing's lifecycle, the device session's reach and its refusals, the
 * push handshake's origins, the revocation that closes the socket, the push
 * token on lane B's seam, the relay address, the record on disk.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_DEVICE_SUSPENDED,
  DEVICE_PAIR_PATH
} from '@clave/contract/devices'
import { CLOSE_UNAUTHORIZED, type ServerFrame } from '@clave/contract/push'
import { hashToken } from './store'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'
import { memoryDeviceStorage, type DevicesPortService } from './port'
import { DEVICE_FORBIDDEN_MESSAGE, deviceHearsEvent, deviceMayCall } from './scope'
import { FIXTURE_PATH } from '../fixtures/route'
import { OWNER_READ_ATTEMPTS, makeDeviceSessions } from './service'
import type { ServerPorts } from '../ports'
import { memoryWriteLedgerStorage, STOPPED_AFTER_DISPATCH } from '../sessions/writes'
import { FakeSettingsSource } from '../settings/test-support'
import type { ClaudeAccount, CodexAccount, UsageRead } from '../settings/port'
import { SidebarLayouts } from '../sidebar/layouts'
import { layoutsOverviewSource } from '../sidebar/overview'
import { memorySidebarStorage, noWindowsHost } from '../sidebar/ports'
import { ServerInfoPort } from '../server-info/port'
import { PendingRequests } from '../requests/service'
import { createServerFiles } from '../files/service'
import { ensureFileHelper } from '../files/test-support'
import type { TimelinePage } from '@clave/contract/timeline'

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
  /** The account manager's word (PRDCT-4448): the owner changes and the entry says so at
   *  once, to whoever listens on the port (with `notices`). */
  changeOwner: (subject: string | null) => void
  /** Who listens on the port for the owner's changes now. */
  noticeListeners: Set<(owner: string | null) => void>
  clock: { now: number }
  relay: { url: string }
  asked: Array<{ name: string; platform: string }>
  json: (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
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

async function start(
  options: {
    owner?: string | null
    issuer?: string
    source?: FakeSource
    ports?: Omit<ServerPorts, 'sessions' | 'devices'>
    /** The entry tells every change of the owner as it happens (PRDCT-4448). */
    notices?: boolean
    /** The entry answers the owner synchronously, at the moment of each check (PRDCT-4448). */
    fresh?: boolean
  } = {}
): Promise<World> {
  const source = options.source ?? new FakeSource(aSession('s1'))
  const storage = memoryDeviceStorage()
  const owner = { subject: options.owner === undefined ? OWNER : options.owner }
  const noticeListeners = new Set<(owner: string | null) => void>()
  const clock = { now: Date.now() }
  const relay = { url: '' }
  const asked: World['asked'] = []
  const port: DevicesPortService = {
    storage,
    owner: () => owner.subject,
    ...(options.fresh && { ownerNow: () => owner.subject }),
    ...(options.notices && {
      onOwnerChanged: (listener: (owner: string | null) => void) => {
        noticeListeners.add(listener)
        return () => void noticeListeners.delete(listener)
      }
    }),
    issuer: options.issuer ?? provider.issuer,
    serverName: () => 'the-mac',
    relay: { get: () => relay.url, set: (url) => void (relay.url = url) },
    onPairingRequested: (pairing) => void asked.push({ ...pairing }),
    now: () => clock.now
  }
  const server = await startEmbedded({
    ports: { ...options.ports, sessions: source, devices: port },
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
    changeOwner: (subject) => {
      owner.subject = subject
      for (const listener of [...noticeListeners]) listener(subject)
    },
    noticeListeners,
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
      ['GET', '/accounts/claude/migrated'],
      ['GET', '/accounts/login'],
      ['POST', '/accounts/claude', { label: 'x' }],
      ['POST', '/accounts/claude/token', { id: 'default', token: 'sk-ant-x' }],
      ['GET', '/usage/claude'],
      ['GET', '/usage/codex?force=true'],
      ['GET', '/usage/pi?range=today'],
      ['GET', '/clients'],
      ['POST', '/clients', { kind: 'other', name: 'phone' }],
      ['GET', '/plugins'],
      ['POST', '/server/upgrade', {}],
      ['POST', '/server/name', { name: 'x' }],
      ['POST', '/launch-profiles', {}],
      ['POST', '/workspaces/registry', {}],
      ['GET', '/sidebar/layout?windowKey=w1'],
      ['GET', '/sidebar/layouts'],
      ['POST', '/sidebar/groups', { windowKey: 'w1', group: { name: 'x' } }],
      ['POST', '/sidebar/groups/collapsed', { windowKey: 'w1', groupId: 'g1', collapsed: true }],
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
  it('is refused with 401 when it presents the hash its record keeps, and so is its hello', async () => {
    const w = await start()
    const { token } = await w.device()
    const stored = hashToken(token)
    expect(w.storage.read()).toContain(stored)
    expect((await w.json('GET', '/sessions', { token: stored })).status).toBe(401)
    expect((await w.json('GET', '/devices/me', { token: stored })).status).toBe(401)
    const peer = new Peer(w.pushUrl())
    await peer.opened
    peer.send({ _tag: 'hello', token: stored })
    expect((await peer.closed).code).toBe(CLOSE_UNAUTHORIZED)
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
    const phoneHeard: ServerFrame[] = []
    while (!(await phone.silence(100))) phoneHeard.push(await phone.next())
    // Whatever the phone heard was the revision bump, never the request itself.
    expect(phoneHeard.every((frame) => frame._tag === 'event')).toBe(true)
    expect(phoneHeard.map((frame) => frame._tag === 'event' && frame.event._tag)).not.toContain(
      'devices.pairing_requested'
    )
    expect(JSON.stringify(phoneHeard)).not.toContain(pairingId)
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
    for (const path of [
      '/sidebar/overview',
      '/accounts/claude',
      '/accounts/codex',
      '/usage/claude/snapshot',
      '/usage/codex/snapshot',
      '/server/info'
    ]) {
      expect(deviceMayCall('GET', path), path).toBe(true)
      expect(deviceMayCall('POST', path), path).toBe(false)
    }
    expect(deviceMayCall('GET', '/usage/claude')).toBe(false)
    expect(deviceMayCall('GET', '/sidebar/layouts')).toBe(false)
    expect(deviceHearsEvent('session.title_changed')).toBe(true)
    expect(deviceHearsEvent('requests.changed')).toBe(true)
    expect(deviceHearsEvent('usage.claude_read')).toBe(true)
    expect(deviceHearsEvent('sidebar.overview_changed')).toBe(true)
    expect(deviceHearsEvent('accounts.claude_changed')).toBe(false)
    expect(deviceHearsEvent('accounts.login_progressed')).toBe(false)
    expect(deviceHearsEvent('sidebar.layout_changed')).toBe(false)
    expect(deviceHearsEvent('sidebar.layout_removed')).toBe(false)
    expect(deviceHearsEvent('server.upgrade_changed')).toBe(false)
  })
})

describe('the reads a phone’s list and settings show (UX round, 13 November 2026)', () => {
  /** The settings as the Mac holds them, each view carrying a field it must
   *  never send: the boundary encodes the contract's views, which name none. */
  const phoneSettings = (): FakeSettingsSource => {
    const settings = new FakeSettingsSource()
    settings.claude = [
      {
        id: 'default',
        label: 'Machine login',
        hasToken: false,
        tokenSetAt: null,
        tokenExpiresAt: null,
        tokenInvalid: false
      },
      {
        id: 'c-work',
        label: 'Work',
        hasToken: true,
        tokenSetAt: 1762000000000,
        tokenExpiresAt: 1793536000000,
        tokenInvalid: false,
        token: 'sk-ant-oat01-NEVER-SENT'
      } as ClaudeAccount
    ]
    settings.codex = [
      { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
      {
        id: 'x-key',
        label: 'API key',
        kind: 'apiKey',
        hasCredential: true,
        apiKey: 'sk-proj-NEVER-SENT'
      } as CodexAccount
    ]
    const claudeRead = {
      windows: [
        {
          key: 'five_hour',
          label: 'Current session (5h)',
          kind: 'session',
          scope: null,
          usedPercentage: 42,
          resetsAt: 1763125200000,
          severity: 'normal'
        },
        {
          key: 'seven_day',
          label: 'Weekly (all models)',
          kind: 'weekly_all',
          scope: null,
          usedPercentage: 18,
          resetsAt: 1763550000000,
          severity: 'normal'
        },
        {
          key: 'seven_day_oi',
          label: 'Weekly (Fable)',
          kind: 'weekly_scoped',
          scope: 'Fable',
          usedPercentage: 81,
          resetsAt: 1763550000000,
          severity: 'warning'
        }
      ],
      fetchedAt: 1763110000000,
      accessToken: 'NEVER-SENT-either'
    } as UsageRead
    Object.defineProperty(settings, 'usage', {
      value: {
        ...settings.usage,
        claudeSnapshot: () => ({
          default: claudeRead,
          'c-work': { error: 'Claude refused the token.', reason: 'unauthorized' }
        }),
        codexSnapshot: () => ({
          default: {
            windows: [
              {
                key: 'primary-300',
                label: '5h',
                kind: 'session',
                scope: null,
                usedPercentage: 12,
                resetsAt: 1763121000000,
                severity: null
              }
            ],
            fetchedAt: 1763110000000
          }
        })
      }
    })
    return settings
  }

  it('reads the accounts and their last usage with no token or credential, and asks no provider', async () => {
    const settings = phoneSettings()
    const w = await start({ ports: { settings } })
    const { token } = await w.device()
    const claude = await w.json('GET', '/accounts/claude', { token })
    expect(claude.status).toBe(200)
    expect(claude.body).toEqual([
      {
        id: 'default',
        label: 'Machine login',
        hasToken: false,
        tokenSetAt: null,
        tokenExpiresAt: null,
        tokenInvalid: false
      },
      {
        id: 'c-work',
        label: 'Work',
        hasToken: true,
        tokenSetAt: 1762000000000,
        tokenExpiresAt: 1793536000000,
        tokenInvalid: false
      }
    ])
    const codex = await w.json('GET', '/accounts/codex', { token })
    expect(codex.status).toBe(200)
    expect(codex.body).toEqual([
      { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
      { id: 'x-key', label: 'API key', kind: 'apiKey', hasCredential: true }
    ])
    const claudeUsage = await w.json('GET', '/usage/claude/snapshot', { token })
    expect(claudeUsage.status).toBe(200)
    expect(claudeUsage.body).toMatchObject({
      default: {
        fetchedAt: 1763110000000,
        windows: [
          { key: 'five_hour', kind: 'session', usedPercentage: 42 },
          { key: 'seven_day', kind: 'weekly_all', usedPercentage: 18 },
          { key: 'seven_day_oi', scope: 'Fable', usedPercentage: 81, severity: 'warning' }
        ]
      },
      'c-work': { error: 'Claude refused the token.', reason: 'unauthorized' }
    })
    // `force` is not in the snapshot's payload: a phone that sends it still
    // reads the cache, and no live read is asked of the provider.
    const forced = await w.json('GET', '/usage/codex/snapshot?force=true&accountId=default', {
      token
    })
    expect(forced.status).toBe(200)
    expect(forced.body).toEqual({
      default: {
        windows: [
          {
            key: 'primary-300',
            label: '5h',
            kind: 'session',
            scope: null,
            usedPercentage: 12,
            resetsAt: 1763121000000,
            severity: null
          }
        ],
        fetchedAt: 1763110000000
      }
    })
    const everything = JSON.stringify([claude, codex, claudeUsage, forced].map((a) => a.body))
    expect(everything).not.toContain('NEVER-SENT')
    expect(everything).not.toContain('accessToken')
    expect(settings.calls.map((c) => c.method)).not.toContain('usage.readClaude')
    expect(settings.calls.map((c) => c.method)).not.toContain('usage.readCodex')
    // The live read stays the owner's: it is the one that can ask the provider.
    expect((await w.json('GET', '/usage/claude?force=true', { token })).status).toBe(403)
    expect(settings.calls.map((c) => c.method)).not.toContain('usage.readClaude')
  })

  it('reads the Mac’s version and the desktop’s groups, without their terminals or prompts', async () => {
    const storage = memorySidebarStorage()
    storage.documents.set('w1', {
      groups: [
        {
          id: 'g1',
          name: 'Clave',
          sessionIds: ['s1'],
          collapsed: false,
          color: 'purple',
          cwd: '/Users/someone/clave',
          prompt: 'NEVER-SENT prompt',
          workspaceId: 'ws-antasphere',
          terminals: [
            {
              id: 't1',
              command: 'NEVER-SENT=1 npm run dev',
              commandMode: 'auto',
              color: 'blue',
              sessionId: null
            }
          ]
        }
      ],
      displayOrder: ['g1', 's2']
    })
    const sidebar = new SidebarLayouts(storage, noWindowsHost)
    const w = await start({
      ports: {
        sidebar,
        sidebarOverview: layoutsOverviewSource(sidebar, {
          workspaceOf: (key) => (key === 'w1' ? 'ws-antasphere' : null)
        }),
        serverInfo: ServerInfoPort.appRun('3.0.0-beta.23', 'the-mac')
      }
    })
    const { token } = await w.device()
    const info = await w.json('GET', '/server/info', { token })
    expect(info.status).toBe(200)
    expect(info.body).toEqual({
      version: '3.0.0-beta.23',
      installRef: null,
      upgrade: {
        supported: false,
        reason: expect.any(String),
        state: 'idle'
      },
      name: 'the-mac'
    })
    const overview = await w.json('GET', '/sidebar/overview', { token })
    expect(overview.status).toBe(200)
    expect(overview.body).toEqual({
      windows: [
        {
          windowKey: 'w1',
          workspaceId: 'ws-antasphere',
          displayOrder: ['g1', 's2'],
          groups: [
            {
              id: 'g1',
              name: 'Clave',
              color: 'purple',
              collapsed: false,
              workspaceId: 'ws-antasphere',
              sessionIds: ['s1']
            }
          ]
        }
      ]
    })
    expect(JSON.stringify(overview.body)).not.toContain('NEVER-SENT')
    expect(JSON.stringify(overview.body)).not.toContain('/Users/')
    // The layouts themselves, and every edit of them, stay the owner's.
    expect((await w.json('GET', '/sidebar/layouts', { token })).status).toBe(403)
    expect((await w.json('GET', '/sidebar/layout?windowKey=w1', { token })).status).toBe(403)
    expect((await w.json('GET', '/sidebar/layouts')).status).toBe(200)
    expect((await w.json('GET', '/sidebar/overview')).status).toBe(200)
  })

  it('tells a phone that the overview changed with no payload, and never sends it a layout', async () => {
    const storage = memorySidebarStorage()
    storage.documents.set('w1', {
      groups: [{ id: 'g1', name: 'Api', sessionIds: ['s1'], prompt: 'NEVER-SENT' }],
      displayOrder: ['g1']
    })
    const w = await start({ ports: { sidebar: new SidebarLayouts(storage, noWindowsHost) } })
    const { token } = await w.device()
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    expect((await phone.next())._tag).toBe('welcome')
    const mac = new Peer(w.pushUrl())
    await mac.opened
    mac.send({ _tag: 'hello', token: w.server.token })
    expect((await mac.next())._tag).toBe('welcome')
    // The owner folds a group on the Mac: a command on the layout.
    const folded = await w.json('POST', '/sidebar/groups/collapsed', {
      body: { windowKey: 'w1', groupId: 'g1', collapsed: true }
    })
    expect(folded.status).toBe(200)
    const heard = async (peer: Peer, until: string): Promise<unknown[]> => {
      const events: unknown[] = []
      for (let i = 0; i < 6; i++) {
        const frame = await peer.next()
        if (frame._tag !== 'event') continue
        events.push(frame.event)
        if (frame.event._tag === until) break
      }
      return events
    }
    const phoneHeard = await heard(phone, 'sidebar.overview_changed')
    expect(phoneHeard).toContainEqual({ _tag: 'sidebar.overview_changed' })
    while (!(await phone.silence(150))) phoneHeard.push(await phone.next())
    const tags = phoneHeard.map((e) => (e as { _tag?: string })._tag ?? e)
    expect(tags).not.toContain('sidebar.layout_changed')
    expect(JSON.stringify(phoneHeard)).not.toContain('NEVER-SENT')
    // The Mac hears the layout itself, as before.
    const macHeard = await heard(mac, 'sidebar.layout_changed')
    expect(macHeard.map((e) => (e as { _tag: string })._tag)).toContain('sidebar.layout_changed')
    phone.ws.close()
    mac.ws.close()
    await Promise.all([phone.closed, mac.closed])
  })

  it('writes the chat’s model, effort, permission mode, task stop, form draft and interrupt from a phone', async () => {
    const w = await start()
    const { token } = await w.device()
    const inputs = [
      { type: 'set_model', model: 'claude-fable-5-1', remember: false },
      { type: 'set_model', model: null },
      { type: 'set_effort', effort: 'high' },
      { type: 'set_permission_mode', mode: 'acceptEdits' },
      { type: 'stop_task', taskId: 'task-1' },
      { type: 'permission_draft', id: 'clave:form-1', answers: { name: 'Ada', tags: ['a', 'b'] } },
      { type: 'interrupt' }
    ]
    for (const input of inputs) {
      const answer = await w.json('POST', '/sessions/write', { token, body: { id: 's1', input } })
      expect(answer.status, JSON.stringify(input)).toBe(200)
      expect(answer.body).toMatchObject({ status: 'accepted', at: expect.any(Number) })
    }
    expect(w.source.writes).toEqual(inputs.map((input) => ({ id: 's1', input })))
    // A level outside the provider's spelling is refused at the boundary, written nowhere.
    const bad = await w.json('POST', '/sessions/write', {
      token,
      body: { id: 's1', input: { type: 'set_effort', effort: 'MAX!' } }
    })
    expect(bad.status).toBe(400)
    expect(w.source.writes).toHaveLength(inputs.length)
  })
})

describe('the paired phone mobile boundary', () => {
  const knownId = 'phone-known-001'
  const uncertainId = 'phone-uncertain-001'
  const newId = 'phone-new-001'
  const seededLedger = (): ReturnType<typeof memoryWriteLedgerStorage> => {
    const storage = memoryWriteLedgerStorage()
    // Recovery input from a previous process, not a live provider acknowledgement.
    storage.documents.set(
      's1.ledger.json',
      JSON.stringify({
        v: 1,
        complete: true,
        entries: {
          [knownId]: { status: 'accepted', at: 42 },
          [uncertainId]: { status: 'dispatched', at: 41 }
        }
      })
    )
    return storage
  }
  /** The calls the native phone client makes (`ClaveServerClient.kt` on the
   *  `mobile` branch at 691d2789): its paths, its query strings, its bodies,
   *  the bearer it holds, and a failure on any answer outside 2xx. */
  type Upload = { name: string; mimeType: string; size: number; delivery: string; path: string }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const phoneClient = (w: World, token: string) => {
    const call = async <T = unknown>(
      method: 'GET' | 'POST',
      path: string,
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(`${w.server.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const text = await response.text()
      if (response.status < 200 || response.status > 299)
        throw new Error(`The server answered ${response.status}: ${text}`)
      return (text === '' ? null : JSON.parse(text)) as T
    }
    /** A query is a GET with its payload as the query string, absent values left out. */
    const query = <T = unknown>(path: string, params: Record<string, unknown>): Promise<T> => {
      const present = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      const qs = new URLSearchParams(present.map(([k, v]) => [k, String(v)])).toString()
      return call<T>('GET', qs === '' ? path : `${path}?${qs}`)
    }
    return {
      sessions: {
        list: (): Promise<unknown[]> => query('/sessions', {}),
        get: (id: string): Promise<unknown> => query('/sessions/by-id', { id }),
        capabilities: (id: string): Promise<unknown> => query('/sessions/capabilities', { id }),
        history: (id: string, before?: number, limit?: number): Promise<unknown> =>
          query('/sessions/history', { id, before, limit }),
        timeline: (id: string, before?: number, limit?: number): Promise<unknown> =>
          query('/sessions/timeline', { id, before, limit }),
        writeStatus: (id: string, clientMessageId: string): Promise<unknown> =>
          query('/sessions/writes', { id, clientMessageId }),
        write: (id: string, input: unknown): Promise<unknown> =>
          call('POST', '/sessions/write', { id, input }),
        start: (input: unknown): Promise<{ id: string } & Record<string, unknown>> =>
          call('POST', '/sessions/start', input),
        restart: (id: string): Promise<Record<string, unknown>> =>
          call('POST', '/sessions/restart', { id, account: {} }),
        stop: async (id: string): Promise<void> => {
          await call('POST', '/sessions/stop', { id })
        }
      },
      launchProfiles: { list: (): Promise<unknown> => query('/launch-profiles', {}) },
      workspaces: { load: (): Promise<unknown> => query('/workspaces', {}) },
      requests: {
        list: (): Promise<{ revision: number; pending: unknown[] }> =>
          query('/requests/pending', {}),
        resolve: (requestId: string, response: unknown): Promise<{ accepted: boolean }> =>
          call('POST', '/requests/resolve', { requestId, response })
      },
      files: {
        read: (root: string, path: string): Promise<unknown> => query('/files/read', { root, path })
      },
      attachments: {
        prepareUpload: (
          sessionId: string,
          source: { name: string; image: boolean; base64: string }
        ): Promise<Upload> =>
          call<Upload>('POST', '/files/attachments/prepare', {
            sessionId,
            source: { kind: 'upload', ...source }
          })
      }
    }
  }

  it.each([
    [knownId, { status: 'accepted', at: 42 }],
    [uncertainId, { status: 'unknown', reason: STOPPED_AFTER_DISPATCH }],
    [newId, { status: 'absent' }]
  ] as const)(
    'reads canonical write status for %s with a real paired credential',
    async (id, expected) => {
      const w = await start({ ports: { writeLedger: seededLedger() } })
      const { token } = await w.device()
      expect(token).not.toBe(w.server.token)
      const path = `/sessions/writes?id=s1&clientMessageId=${id}`
      const owner = await w.json('GET', path)
      expect(owner.status).toBe(200)
      expect(owner.body).toMatchObject(expected)
      const phone = await w.json('GET', path, { token })
      expect(phone.status, JSON.stringify(phone.body)).toBe(200)
      expect(phone.body).toEqual(owner.body)
      expect(await phoneClient(w, token).sessions.writeStatus('s1', id)).toEqual(owner.body)
      expect((await w.json('GET', path, { token })).body).toEqual(owner.body)
      expect(w.source.writes).toEqual([])
    }
  )

  it('reads seeded sessions, timeline, history, profiles, workspaces and requests through the mobile client', async () => {
    const source = new FakeSource(aSession('s1'))
    source.historyOf = {
      items: [{ event: { type: 'user_message', text: 'Earlier phone message' }, at: 17 }],
      before: 10
    }
    const timeline: TimelinePage = {
      items: [
        {
          ...source.historyOf.items[0],
          position: { generation: 'phone-fixture', sequence: 6 }
        }
      ],
      before: 6,
      cursor: { generation: 'phone-fixture', sequence: 9 },
      truncated: true
    }
    const timelineAsked: unknown[] = []
    Object.assign(source, {
      timeline: (id: string, before?: number, limit?: number) => {
        timelineAsked.push({ id, before, limit })
        return timeline
      }
    })
    const settings = new FakeSettingsSource()
    settings.profiles = {
      ...settings.profiles,
      customProfiles: [
        {
          id: 'phone-profile',
          name: 'Fixture Codex',
          family: 'codex',
          command: ['fixture-codex'],
          additionalArgs: ['--fixture']
        }
      ]
    }
    settings.state = {
      ...settings.state,
      workspaces: [
        {
          id: 'workspace-phone',
          name: 'Phone work',
          rootDir: '/work',
          profileFile: null,
          createdAt: 3
        }
      ]
    }
    const requests = new PendingRequests()
    const pending = requests.create({
      sessionId: 's1',
      kind: 'permission',
      description: 'Read the fixture document?',
      options: [{ id: 'allow', label: 'Allow' }]
    })
    const w = await start({ source, ports: { settings, requests } })
    try {
      const { token, deviceId } = await w.device()
      const client = phoneClient(w, token)
      expect(await client.sessions.list()).toEqual([aSession('s1')])
      expect(await client.sessions.get('s1')).toEqual(aSession('s1'))
      expect(await client.sessions.capabilities('s1')).toEqual({ images: true })
      expect(await client.sessions.history('s1', 20, 5)).toEqual(source.historyOf)
      expect(source.historyAsked).toEqual([{ id: 's1', before: 20, limit: 5 }])
      expect(await client.sessions.timeline('s1', 8, 5)).toEqual(timeline)
      expect(timelineAsked).toEqual([{ id: 's1', before: 8, limit: 5 }])
      expect(await client.launchProfiles.list()).toEqual(settings.profiles)
      expect(await client.workspaces.load()).toEqual(settings.state)
      expect(await client.requests.list()).toEqual({ revision: 1, pending: [pending] })
      expect((await w.json('GET', '/devices/me', { token })).body).toMatchObject({
        id: deviceId,
        ...PHONE
      })
      for (const [path, expected] of [
        ['/sessions/models?id=s1', source.modelsOf],
        ['/sessions/commands?id=s1', source.commandsOf]
      ] as const) {
        const answer = await w.json('GET', path, { token })
        expect(answer.status, path).toBe(200)
        expect(answer.body).toEqual(expected)
      }
      expect(source.writes).toEqual([])
      expect(source.starts).toEqual([])
    } finally {
      await w.server.stop()
      requests.close()
    }
  })

  it('applies intended session, request and own-device writes once under the paired credential', async () => {
    const requests = new PendingRequests()
    const answers: unknown[] = []
    const pending = requests.create(
      {
        sessionId: 's1',
        kind: 'permission',
        description: 'Allow the fixture?',
        options: [{ id: 'allow', label: 'Allow' }]
      },
      async (response) => void answers.push(response)
    )
    const w = await start({ ports: { requests, writeLedger: seededLedger() } })
    try {
      const { token, deviceId } = await w.device()
      const client = phoneClient(w, token)
      const startInput = {
        cwd: '/work/phone-start',
        options: {
          codexMode: true,
          workspaceId: 'workspace-phone',
          launchProfileId: 'phone-profile',
          launchProfile: {
            id: 'phone-profile',
            name: 'Fixture Codex',
            family: 'codex' as const,
            command: ['fixture-codex'],
            additionalArgs: ['--fixture']
          }
        }
      }
      const started = await client.sessions.start(startInput)
      expect(started).toEqual({
        id: 'started-1',
        cwd: '/work/phone-start',
        folderName: 'phone-start',
        alive: true,
        claudeSessionId: null,
        piSessionId: null
      })
      expect(w.source.starts).toEqual([startInput])
      expect(w.source.sessions.has(started.id)).toBe(true)
      const input = {
        type: 'user_message' as const,
        text: 'One fixture reply',
        clientMessageId: 'phone-send-001'
      }
      const written = await client.sessions.write('s1', input)
      expect(written).toMatchObject({ status: 'accepted', at: expect.any(Number) })
      expect(await client.sessions.write('s1', input)).toEqual(written)
      expect(await client.sessions.writeStatus('s1', input.clientMessageId)).toEqual(written)
      expect(w.source.writes).toEqual([{ id: 's1', input }])
      expect(
        (
          await w.json('POST', '/sessions/resize', {
            token,
            body: { id: 's1', cols: 90, rows: 30 }
          })
        ).status
      ).toBe(204)
      expect(w.source.resizes).toEqual([{ id: 's1', cols: 90, rows: 30 }])
      const viewed = await w.json('POST', '/sessions/view', {
        token,
        body: { id: 's1', viewId: 'fixture/chat' }
      })
      expect(viewed.status).toBe(200)
      expect(viewed.body).toMatchObject({ id: 's1', viewId: 'fixture/chat' })
      expect(w.source.views).toEqual([{ id: 's1', viewId: 'fixture/chat' }])
      expect(
        (await w.json('POST', '/sessions/view', { token, body: { id: 's1', viewId: null } })).body
      ).not.toHaveProperty('viewId')
      expect(w.source.views.at(-1)).toEqual({ id: 's1', viewId: null })
      expect(await client.sessions.restart('s1')).toMatchObject({ id: 's1', alive: true })
      expect(w.source.restarts).toEqual([{ id: 's1', account: {}, resendRejected: false }])
      const response = { type: 'permission' as const, optionId: 'allow' }
      expect(await client.requests.resolve(pending.id, response)).toEqual({ accepted: true })
      expect(await client.requests.resolve(pending.id, response)).toEqual({ accepted: false })
      expect(answers).toEqual([response])
      expect((await client.requests.list()).pending).toEqual([])
      expect(requests.result(pending.id, 's1').status).toBe('completed')
      const other = await w.device()
      expect(
        (
          await w.json('POST', '/devices/me/push-token', {
            token: other.token,
            body: { token: 'other-fixture-apns', platform: 'ios' }
          })
        ).status
      ).toBe(204)
      expect(
        (
          await w.json('POST', '/devices/me/push-token', {
            token,
            body: { token: 'fixture-apns', platform: 'ios' }
          })
        ).status
      ).toBe(204)
      expect(await runList(freshService(w))).toEqual(
        expect.arrayContaining([
          { deviceId, platform: 'ios', token: 'fixture-apns' },
          { deviceId: other.deviceId, platform: 'ios', token: 'other-fixture-apns' }
        ])
      )
      expect(
        (await w.json('POST', '/devices/me/push-token/clear', { token, body: {} })).status
      ).toBe(204)
      expect(await runList(freshService(w))).toEqual([
        { deviceId: other.deviceId, platform: 'ios', token: 'other-fixture-apns' }
      ])
      await client.sessions.stop(started.id)
      expect(w.source.stops).toEqual(['started-1'])
      expect(w.source.sessions.has(started.id)).toBe(false)
    } finally {
      await w.server.stop()
      requests.close()
    }
  })

  it('reads a document and prepares bounded attachment bytes while generic file writes stay forbidden', async () => {
    ensureFileHelper()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'clave-phone-scope-')))
    const content = 'Only the seeded document.\n'
    await writeFile(join(root, 'document.md'), content)
    const files = createServerFiles({ attachmentsRoot: join(root, 'attachments'), roots: [root] })
    let w: World | undefined
    try {
      w = await start({ ports: { files, writeLedger: seededLedger() } })
      const { token } = await w.device()
      expect(await phoneClient(w, token).files.read(root, 'document.md')).toEqual({
        content,
        size: Buffer.byteLength(content),
        binary: false,
        truncated: false
      })
      const bytes = Buffer.from('A bounded fixture attachment.\n')
      const attachment = await phoneClient(w, token).attachments.prepareUpload('s1', {
        name: 'Fixture.txt',
        image: false,
        base64: bytes.toString('base64')
      })
      expect(attachment).toMatchObject({
        name: 'Fixture.txt',
        mimeType: 'text/plain',
        size: bytes.length,
        delivery: 'reference'
      })
      expect(attachment.path.startsWith(join(root, 'attachments', 's1') + '/')).toBe(true)
      expect(await readFile(attachment.path)).toEqual(bytes)
      const attachedInput = {
        type: 'user_message' as const,
        text: 'Read the fixture attachment',
        clientMessageId: 'phone-attached-001',
        attachments: [attachment]
      }
      expect(await phoneClient(w, token).sessions.write('s1', attachedInput)).toMatchObject({
        status: 'accepted'
      })
      expect(w.source.writes).toEqual([{ id: 's1', input: attachedInput }])
      for (const path of [
        '/files/write',
        '/files/upload',
        '/files/create',
        '/files/mkdir',
        '/files/attachments/prepare/extra'
      ]) {
        const denied = await w.json('POST', path, {
          token,
          body: { root, path: 'document.md', content: 'Changed' }
        })
        expect(denied.status, path).toBe(403)
      }
      expect(await readFile(join(root, 'document.md'), 'utf8')).toBe(content)
    } finally {
      await w?.server.stop()
      files.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps near paths, other methods, desktop metadata and administration forbidden, and rejects invalid or revoked credentials', async () => {
    const settings = new FakeSettingsSource()
    const w = await start({ ports: { settings, writeLedger: seededLedger() } })
    const { token, deviceId } = await w.device()
    for (const path of [
      '/sessions/writes/',
      '/sessions/writes/extra',
      '/sessions/writes-extra',
      '/sessions/write-status',
      '/sessions/records?ids=s1',
      '/sessions/records',
      '/devices',
      '/plugins',
      // The reads this round opened, each exactly: a near path stays the owner's.
      '/accounts/claude/',
      '/accounts/claude/x',
      '/accounts/claude/migrated',
      '/accounts/codex/x',
      '/accounts/claudex',
      '/accounts/login',
      '/usage/claude',
      '/usage/codex',
      '/usage/claude/snapshot/',
      '/usage/claude/snapshot/x',
      '/usage/claude/snapshots',
      '/usage/pi',
      '/sidebar/layout',
      '/sidebar/layout?windowKey=w1',
      '/sidebar/layouts',
      '/sidebar/overview/',
      '/sidebar/overview/x',
      '/server/info/',
      '/server/info/x'
    ]) {
      const answer = await w.json('GET', path, { token })
      expect(answer.status, path).toBe(403)
      expect(answer.body).toEqual({ error: 'Forbidden', message: DEVICE_FORBIDDEN_MESSAGE })
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const) {
      expect(
        (
          await w.json(method, '/sessions/writes', {
            token,
            ...(method === 'HEAD' ? {} : { body: {} })
          })
        ).status,
        method
      ).toBe(403)
    }
    for (const path of [
      '/workspaces/registry',
      '/launch-profiles',
      '/accounts/claude',
      '/accounts/codex',
      '/usage/claude/snapshot',
      '/sidebar/overview',
      '/server/info',
      '/preferences/app-icon',
      '/devices/revoke'
    ]) {
      expect((await w.json('POST', path, { token, body: {} })).status, path).toBe(403)
    }
    expect(settings.calls).toEqual([])
    expect(w.source.writes).toEqual([])
    expect(w.source.starts).toEqual([])
    const path = `/sessions/writes?id=s1&clientMessageId=${knownId}`
    for (const bad of [null, '', 'a'.repeat(64)]) {
      expect((await w.json('GET', path, { token: bad })).status).toBe(401)
    }
    expect((await w.json('POST', '/devices/revoke', { body: { deviceId } })).status).toBe(204)
    expect((await w.json('GET', path, { token })).status).toBe(401)
    expect((await w.json('GET', '/sessions', { token })).status).toBe(401)
  })
})

describe('a phone is the account that approved it (PRDCT-4448)', () => {
  it('lets only the asking account approve a pending phone, and hands its session to that account only', async () => {
    const w = await start()
    const { pairingId } = await w.pair()
    w.owner.subject = 'another-account'
    expect((await w.json('GET', '/devices')).body).toMatchObject({ pending: [] })
    expect((await w.json('POST', '/devices/approve', { body: { pairingId } })).status).toBe(422)
    w.owner.subject = null
    expect((await w.json('POST', '/devices/approve', { body: { pairingId } })).status).toBe(422)
    w.owner.subject = OWNER
    expect((await w.json('POST', '/devices/approve', { body: { pairingId } })).status).toBe(200)
    // Approved, then its account signed out before the phone read: the session waits, kept.
    w.owner.subject = null
    const held = await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })
    expect(held.body).toEqual({ status: 'pending' })
    w.owner.subject = OWNER
    const read = await w.json('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`, { token: null })
    expect(read.body).toMatchObject({
      status: 'approved',
      deviceSession: { token: expect.any(String) }
    })
  })

  it('suspends an approved phone while another account or none is signed in, and lets it back with the same account', async () => {
    const w = await start()
    const { token } = await w.device()
    const sessions = (): Promise<{ status: number; body: unknown }> =>
      w.json('GET', '/sessions', { token })
    expect((await sessions()).status).toBe(200)
    const open = new Peer(w.pushUrl())
    await open.opened
    open.send({ _tag: 'hello', token })
    expect((await open.next())._tag).toBe('welcome')
    w.owner.subject = null
    const refused = await sessions()
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.body)).toContain('another Antasphere account')
    // Its open socket closes with the code a phone retries on (never 4001 or 4011).
    expect((await open.closed).code).toBe(CLOSE_DEVICE_SUSPENDED)
    const hello = new Peer(w.pushUrl())
    await hello.opened
    hello.send({ _tag: 'hello', token })
    expect((await hello.closed).code).toBe(CLOSE_DEVICE_SUSPENDED)
    w.owner.subject = 'another-account'
    expect((await sessions()).status).toBe(403)
    expect((await w.json('GET', '/devices')).body).toMatchObject({ devices: [] })
    // The same account back: the phone works again, with no new pairing.
    w.owner.subject = OWNER
    expect((await sessions()).status).toBe(200)
    const back = new Peer(w.pushUrl())
    await back.opened
    back.send({ _tag: 'hello', token })
    expect((await back.next())._tag).toBe('welcome')
    back.ws.close()
  })

  it('refuses a phone record bound to no owner, as one paired before the binding: it pairs again', async () => {
    const token = 'a'.repeat(64)
    const legacy = JSON.stringify({
      v: 1,
      devices: [
        {
          id: 'dev-legacy',
          name: 'Old phone',
          platform: 'android',
          appVersion: '0.9.0',
          createdAt: 1,
          lastSeenAt: null,
          tokenHash: hashToken(token),
          push: null
        }
      ]
    })
    const server = await startEmbedded({
      ports: {
        sessions: new FakeSource(aSession('s1')),
        devices: {
          storage: memoryDeviceStorage(legacy),
          owner: () => OWNER,
          issuer: provider.issuer,
          serverName: () => 'the-mac'
        }
      }
    })
    try {
      const answer = await fetch(`${server.url}/sessions`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(answer.status).toBe(401)
      const peer = new Peer(server.url.replace('http:', 'ws:') + '/push')
      await peer.opened
      peer.send({ _tag: 'hello', token })
      // Final for the phone: this record admits nobody, whoever signs in.
      expect((await peer.closed).code).toBe(CLOSE_UNAUTHORIZED)
    } finally {
      await server.stop()
    }
  })
})

// ── PRDCT-4448: the owner as the server reads it, and its word reaching a phone at once ──

/** A phone record bound to `subject`, under a token the test knows. */
const BOUND_TOKEN = 'b'.repeat(64)
const BOUND_ID = 'dev-bound'
const boundDocument = (subject: string): string =>
  JSON.stringify({
    v: 1,
    devices: [
      {
        id: BOUND_ID,
        name: 'A phone',
        platform: 'android',
        appVersion: '1.0.0',
        createdAt: 1,
        lastSeenAt: null,
        tokenHash: hashToken(BOUND_TOKEN),
        push: null,
        owner: subject
      }
    ]
  })

/** A port whose owner reads may be held: each read samples the owner as it starts and
 *  answers when the test lets it (an entry whose read waits on something). With `notices`,
 *  `change` is the account manager's word: the owner changes and the listeners hear it. */
function holdingPort(
  initial: string | null,
  options: { notices?: boolean; document?: string } = {}
): {
  port: DevicesPortService
  state: { subject: string | null; holding: boolean }
  held: Array<() => void>
  listeners: Set<(owner: string | null) => void>
  change: (subject: string | null) => void
} {
  const state = { subject: initial, holding: false }
  const held: Array<() => void> = []
  const listeners = new Set<(owner: string | null) => void>()
  const port: DevicesPortService = {
    storage: memoryDeviceStorage(options.document ?? null),
    owner: () => {
      const sampled = state.subject
      if (!state.holding) return sampled
      return new Promise<string | null>((resolve) => held.push(() => resolve(sampled)))
    },
    issuer: provider.issuer,
    serverName: () => 'the-mac',
    ...(options.notices && {
      onOwnerChanged: (listener: (owner: string | null) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    })
  }
  return {
    port,
    state,
    held,
    listeners,
    change: (subject) => {
      state.subject = subject
      for (const listener of [...listeners]) listener(subject)
    }
  }
}

/** Everything already queued has run: the callbacks, and the promises they settled. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Read a peer's frames up to the first of `tag`, and answer it. */
async function until(peer: Peer, tag: ServerFrame['_tag']): Promise<ServerFrame> {
  for (;;) {
    const frame = await peer.next()
    if (frame._tag === tag) return frame
  }
}

/** The frames a peer received and nobody read yet, once nothing more comes for a moment. */
async function drained(peer: Peer): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = []
  for (;;) {
    try {
      frames.push(await peer.next(50))
    } catch {
      return frames
    }
  }
}

describe('the owner as the server reads it (PRDCT-4448)', () => {
  it('never lets an older read of the owner land over a newer one', async () => {
    const h = holdingPort('account-a', { document: boundDocument('account-a') })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    h.state.holding = true
    // The first read samples account-a; account-b signs in; the second read samples it.
    const first = devices.authenticate(BOUND_TOKEN)
    h.state.subject = 'account-b'
    const second = devices.authenticate(BOUND_TOKEN)
    expect(h.held).toHaveLength(2)
    h.held[1]()
    expect(await second).toEqual({ deviceId: BOUND_ID, suspended: true })
    // The older read answers last, still saying account-a: it changes nothing.
    h.held[0]()
    expect(await first).toEqual({ deviceId: BOUND_ID, suspended: true })
    expect(devices.isSuspended(BOUND_ID)).toBe(true)
  })

  it('listens to the account manager’s word while anyone listens to the owner, and only then', () => {
    const h = holdingPort('account-a', { notices: true })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    expect(h.listeners.size).toBe(0)
    const offFirst = devices.onOwnerChanged(() => {})
    const offSecond = devices.onOwnerChanged(() => {})
    expect(h.listeners.size).toBe(1)
    offFirst()
    expect(h.listeners.size).toBe(1)
    offSecond()
    expect(h.listeners.size).toBe(0)
  })

  it('takes the owner the account manager tells at once, before any read answers', async () => {
    const h = holdingPort('account-a', { notices: true, document: boundDocument('account-a') })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    const told: string[] = []
    const off = devices.onOwnerChanged(() => told.push('changed'))
    await settle()
    expect(devices.isSuspended(BOUND_ID)).toBe(false)
    // No read answers from here on: only the word can move the owner.
    h.state.holding = true
    h.change('account-b')
    expect(devices.isSuspended(BOUND_ID)).toBe(true)
    h.change(null)
    expect(devices.isSuspended(BOUND_ID)).toBe(true)
    h.change('account-a')
    expect(devices.isSuspended(BOUND_ID)).toBe(false)
    expect(told).toEqual(['changed', 'changed', 'changed'])
    off()
  })

  it('reads the owner again when the account manager tells of a change while a read is out', async () => {
    const h = holdingPort('account-a', { notices: true, document: boundDocument('account-a') })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    // The push channel listens, as it does for the whole life of a server.
    const off = devices.onOwnerChanged(() => {})
    await settle()
    h.state.holding = true
    const pending = devices.authenticate(BOUND_TOKEN)
    h.change('account-b')
    // Its answer was sampled before the change: not trusted, the owner is read again.
    h.held[0]()
    await settle()
    expect(h.held).toHaveLength(2)
    h.held[1]()
    expect(await pending).toEqual({ deviceId: BOUND_ID, suspended: true })
    off()
  })

  it('counts nobody when the account keeps changing under every read', async () => {
    const h = holdingPort('account-a', { notices: true, document: boundDocument('account-a') })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    const off = devices.onOwnerChanged(() => {})
    await settle()
    h.state.holding = true
    const pending = devices.authenticate(BOUND_TOKEN)
    // Every read is overtaken by a word; the last word names the phone's own account.
    for (const [read, next] of [
      [0, 'account-b'],
      [1, 'account-c'],
      [2, 'account-a']
    ] as const) {
      h.change(next)
      h.held[read]()
      await settle()
    }
    expect(h.held).toHaveLength(OWNER_READ_ATTEMPTS)
    expect(await pending).toEqual({ deviceId: BOUND_ID, suspended: true })
    off()
  })

  it('asks an entry that can answer at once for the owner at the moment of every check', async () => {
    const state = { subject: 'account-a' as string | null }
    const devices = makeDeviceSessions(
      {
        storage: memoryDeviceStorage(boundDocument('account-a')),
        // A read that lags: it says account-a whatever happened since.
        owner: () => Promise.resolve('account-a'),
        ownerNow: () => state.subject,
        issuer: provider.issuer,
        serverName: () => 'the-mac'
      },
      { serverId: 'srv' }
    )
    expect(await devices.authenticate(BOUND_TOKEN)).toEqual({
      deviceId: BOUND_ID,
      suspended: false
    })
    state.subject = 'account-b'
    expect(devices.isSuspended(BOUND_ID)).toBe(true)
    expect(await devices.authenticate(BOUND_TOKEN)).toEqual({ deviceId: BOUND_ID, suspended: true })
    state.subject = null
    expect(devices.isSuspended(BOUND_ID)).toBe(true)
    state.subject = 'account-a'
    expect(devices.isSuspended(BOUND_ID)).toBe(false)
  })

  it('approves, and hands out, a pairing only by a read made after the account changed', async () => {
    const h = holdingPort(OWNER, { notices: true })
    const devices = makeDeviceSessions(h.port, { serverId: 'srv' })
    const off = devices.onOwnerChanged(() => {})
    const { pairingId } = await devices.requestPairing({
      ...(await mintIdToken(provider)),
      device: PHONE
    })
    // Another account signs in while the approval reads the owner.
    h.state.holding = true
    const approval = devices.approve(pairingId)
    h.change('another-account')
    h.held[0]()
    await settle()
    h.held[1]?.()
    await expect(approval).rejects.toThrow('no longer waiting')
    // Approved under its own account, which then signs out while the phone reads the answer.
    h.state.holding = false
    h.change(OWNER)
    await devices.approve(pairingId)
    h.state.holding = true
    const read = devices.readPairing(pairingId)
    h.change(null)
    h.held[2]()
    await settle()
    h.held[3]?.()
    expect(await read).toEqual({ status: 'pending' })
    // The same account back: the session waited for it, kept.
    h.state.holding = false
    h.change(OWNER)
    expect(await devices.readPairing(pairingId)).toMatchObject({
      status: 'approved',
      deviceSession: { token: expect.any(String) }
    })
    off()
  })
})

describe('the owner’s word reaches a phone at once (PRDCT-4448)', () => {
  it('listens to the owner’s word for as long as the server runs', async () => {
    const w = await start({ notices: true })
    expect(w.noticeListeners.size).toBe(1)
    await w.server.stop()
    world = null
    expect(w.noticeListeners.size).toBe(0)
  })

  it.each([
    ['signs out', null],
    ['gives way to another account', 'another-account']
  ])(
    'closes an open phone the moment its account %s, before it hears one more frame',
    async (_, next) => {
      const w = await start({ notices: true })
      const { token, deviceId } = await w.device()
      const phone = new Peer(w.pushUrl())
      await phone.opened
      phone.send({ _tag: 'hello', token })
      await until(phone, 'welcome')
      phone.send({ _tag: 'subscribe', sessionId: 's1' })
      await until(phone, 'subscribed')
      // The account manager's word, then a frame at once: no poll ran in between.
      w.changeOwner(next)
      w.source.emit('s1', { kind: 'pty', data: new Uint8Array([104, 105]) })
      expect((await phone.closed).code).toBe(CLOSE_DEVICE_SUSPENDED)
      expect((await drained(phone)).filter((frame) => frame._tag === 'stream')).toEqual([])
      // Paused, not revoked: the record is kept for the account to come back to.
      expect(w.storage.read()).toContain(deviceId)
    }
  )

  it('closes an open phone within a second of its account leaving, when the entry gives no word', async () => {
    // No word and no other call: only the backstop read can see the change.
    const w = await start()
    const { token } = await w.device()
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    await until(phone, 'welcome')
    const left = Date.now()
    w.owner.subject = null
    expect((await phone.closed).code).toBe(CLOSE_DEVICE_SUSPENDED)
    expect(Date.now() - left).toBeLessThan(3000)
  })

  it('stops every frame to a phone the moment its account is gone, before the word arrives', async () => {
    const w = await start({ notices: true, fresh: true })
    const { token } = await w.device()
    const phone = new Peer(w.pushUrl())
    await phone.opened
    phone.send({ _tag: 'hello', token })
    await until(phone, 'welcome')
    phone.send({ _tag: 'subscribe', sessionId: 's1' })
    await until(phone, 'subscribed')
    // A sign-out drops the session first, clears the keychain, and only then says so.
    w.owner.subject = null
    w.source.emit('s1', { kind: 'pty', data: new Uint8Array([104, 105]) })
    expect((await drained(phone)).filter((frame) => frame._tag === 'stream')).toEqual([])
    w.changeOwner(null)
    expect((await phone.closed).code).toBe(CLOSE_DEVICE_SUSPENDED)
  })

  it('answers 403 to a phone’s read that its account left while the read was answered', async () => {
    const w = await start({ notices: true, fresh: true })
    const { token } = await w.device()
    let entered!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const models = w.source.models
    w.source.models = async (id) => {
      entered()
      await held
      return models(id)
    }
    const answer = w.json('GET', '/sessions/models?id=s1', { token })
    await reached
    w.changeOwner('another-account')
    release()
    const { status, body } = await answer
    expect(status).toBe(403)
    expect(JSON.stringify(body)).toContain('another Antasphere account')
    // Its own account back, the same read answers.
    w.changeOwner(OWNER)
    expect((await w.json('GET', '/sessions/models?id=s1', { token })).status).toBe(200)
  })

  it('keeps the true answer of a phone’s write its account left while the write was made', async () => {
    const w = await start({ notices: true, fresh: true })
    const { token } = await w.device()
    let entered!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const write = w.source.write
    w.source.write = async (id, input) => {
      entered()
      await held
      return write(id, input)
    }
    const answer = w.json('POST', '/sessions/write', {
      token,
      body: { id: 's1', input: { type: 'bytes', data: 'aGk=' } }
    })
    await reached
    w.changeOwner('another-account')
    release()
    // The write landed: its answer says so, whoever is signed in now.
    expect((await answer).status).toBe(200)
    expect(w.source.writes).toHaveLength(1)
  })

  it('never binds a record of no owner to an account that signs in', async () => {
    const token = 'c'.repeat(64)
    const storage = memoryDeviceStorage(
      JSON.stringify({
        v: 1,
        devices: [
          {
            id: 'dev-legacy',
            name: 'Old phone',
            platform: 'android',
            appVersion: '0.9.0',
            createdAt: 1,
            lastSeenAt: null,
            tokenHash: hashToken(token),
            push: null
          }
        ]
      })
    )
    const owner = { subject: null as string | null }
    const listeners = new Set<(owner: string | null) => void>()
    const server = await startEmbedded({
      ports: {
        sessions: new FakeSource(aSession('s1')),
        devices: {
          storage,
          owner: () => owner.subject,
          ownerNow: () => owner.subject,
          onOwnerChanged: (listener) => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
          },
          issuer: provider.issuer,
          serverName: () => 'the-mac'
        }
      }
    })
    try {
      owner.subject = OWNER
      for (const listener of [...listeners]) listener(OWNER)
      const answer = await fetch(`${server.url}/sessions`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(answer.status).toBe(401)
      const listed = await fetch(`${server.url}/devices`, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      expect(await listed.json()).toMatchObject({ devices: [] })
      expect(JSON.parse(storage.read()!).devices[0].owner).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})
