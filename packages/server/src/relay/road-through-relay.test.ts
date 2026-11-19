/**
 * The relay client beside dev's phone support (issue #407, criterion 2): a
 * real Clave server with its devices domain, a relay (the test fixture that
 * speaks antasphere/relay's protocol), the client between them, and a phone
 * paired with the server reaching it through `<relay>/m/<id>/`. A request the
 * relay forwards is authenticated by the server's own listener exactly as a
 * direct one: the device session reaches what its scope allows and nothing
 * else, the owner binding holds, the `Origin` header never reaches the
 * listener, and nothing the machine sends the relay carries the server's own
 * bearer token.
 */
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { DEVICE_PAIR_PATH } from '@clave/contract/devices'
import type { MachineRecord } from '@clave/contract/relay'
import {
  startOidcProvider,
  type OidcProvider
} from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { startRelay, type Relay } from '../../../../tests/e2e/fixtures/relay/relay'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, aSession, sleep } from '../test-support'
import { memoryDeviceStorage, type DevicesPortService } from '../devices/port'
import {
  startRelayClient,
  type RelayClient,
  type RelayCredential,
  type RelayCredentialStore
} from './client'

const PHONE = { name: 'A test phone', platform: 'ios' as const, appVersion: '0.1.0' }
const RECORD: MachineRecord = {
  name: 'the-mac',
  platform: 'macos',
  version: '3.0.0-test',
  direct: []
}

let provider: OidcProvider
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${what}: not within ${timeoutMs} ms`)
    await sleep(10)
  }
}

/** An id token of the provider's person, as a phone signs in to pair. */
async function mintIdToken(): Promise<{ idToken: string; clientId: string }> {
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
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid profile email',
    state: 's',
    nonce: 'n',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  }))
    authorize.searchParams.set(key, value)
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

class MemoryStore implements RelayCredentialStore {
  credential: RelayCredential | null = null
  load(): RelayCredential | null {
    return this.credential
  }
  save(credential: RelayCredential): void {
    this.credential = credential
  }
  clear(): void {
    this.credential = null
  }
}

interface World {
  server: EmbeddedServer
  relay: Relay
  client: RelayClient
  machineId: string
  owner: { subject: string | null }
  /** Every byte the machine sent the relay: the claim, the frames. */
  sent: string[]
  /** The headers of every request the server's listener received. */
  seen: Array<Record<string, string>>
  /** A request through the relay's road to this machine. */
  road: (
    method: string,
    pathname: string,
    o?: { token?: string | null; headers?: Record<string, string>; body?: unknown }
  ) => Promise<{ status: number; body: unknown }>
  /** A request straight to the server's listener. */
  direct: (
    method: string,
    pathname: string,
    o?: { token?: string | null; body?: unknown }
  ) => Promise<{ status: number; body: unknown }>
}

async function start(): Promise<World> {
  const owner = { subject: provider.state.user.sub as string | null }
  const port: DevicesPortService = {
    storage: memoryDeviceStorage(),
    owner: () => owner.subject,
    ownerNow: () => owner.subject,
    issuer: provider.issuer,
    serverName: () => 'the-mac'
  }
  const server = await startEmbedded({
    ports: { sessions: new FakeSource(aSession('s1')), devices: port },
    testFixtures: true
  })
  cleanups.push(() => server.stop().then(() => undefined))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-road-relay-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const relay = await startRelay({ issuer: provider.issuer, dataDir: dir })
  cleanups.push(() => relay.close())

  // What reaches the server's listener, seen in front of it: a loopback
  // proxy the client is pointed at, recording each request's headers.
  const seen: World['seen'] = []
  const { createServer, request } = await import('node:http')
  const front = createServer((req, res) => {
    seen.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
    const target = new URL(req.url ?? '/', server.url)
    const forwarded = request(target, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    forwarded.on('error', () => res.destroy())
    req.pipe(forwarded)
  })
  // A push socket goes through as raw bytes once its upgrade head is seen.
  const { connect } = await import('node:net')
  front.on('upgrade', (req, socket, head) => {
    seen.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
    const target = new URL(server.url)
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => front.close(() => resolve())))
  const frontUrl = `http://127.0.0.1:${(front.address() as { port: number }).port}`

  // Everything the machine sends the relay, as bytes: the claim's request
  // and every frame of the control socket.
  const sent: string[] = []
  class RecordingWebSocket extends WebSocket {
    override send(data: unknown, ...rest: unknown[]): void {
      sent.push(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      ;(super.send as (...args: unknown[]) => void)(data, ...rest)
    }
  }
  // The machine's credential is its owner's; the server's owner below is
  // what the devices domain binds a phone to, and a test changes it alone.
  const machineOwner = provider.state.user.sub
  const client = startRelayClient({
    address: () => relay.url,
    owner: () => machineOwner,
    accessToken: async () => provider.mintAccessToken(),
    record: () => RECORD,
    credentials: new MemoryStore(),
    local: { url: frontUrl },
    log: () => {},
    fetch: async (input, init) => {
      sent.push(
        `${String(input)} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? '')}`
      )
      return globalThis.fetch(input, init)
    },
    WebSocket: RecordingWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 50, maxMs: 200 },
    idleRetryMs: 50
  })
  cleanups.push(() => client.stop())
  await until(() => client.status().state === 'connected', 'connected')
  const machineId = client.status().machineId!

  const call =
    (base: string) =>
    async (
      method: string,
      pathname: string,
      o: { token?: string | null; headers?: Record<string, string>; body?: unknown } = {}
    ): Promise<{ status: number; body: unknown }> => {
      const token = o.token === undefined ? null : o.token
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...o.headers
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined
      })
      const text = await response.text()
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        /* a text answer */
      }
      return { status: response.status, body }
    }
  return {
    server,
    relay,
    client,
    machineId,
    owner,
    sent,
    seen,
    road: call(`${relay.url}/m/${machineId}`),
    direct: call(server.url)
  }
}

/** A phone paired with the world's server: its device session's bearer. */
async function pairedPhone(w: World): Promise<string> {
  const pairing = await w.direct('POST', DEVICE_PAIR_PATH, {
    body: { ...(await mintIdToken()), device: PHONE }
  })
  expect(pairing.status, JSON.stringify(pairing.body)).toBe(200)
  const { pairingId } = pairing.body as { pairingId: string }
  const approved = await w.direct('POST', '/devices/approve', {
    token: w.server.token,
    body: { pairingId }
  })
  expect(approved.status).toBe(200)
  const read = await w.direct('GET', `${DEVICE_PAIR_PATH}?id=${pairingId}`)
  return (read.body as { deviceSession: { token: string } }).deviceSession.token
}

describe('a request the relay forwards meets the server’s own listener', () => {
  it('is held to the device scope exactly as a direct one', async () => {
    const w = await start()
    const phone = await pairedPhone(w)
    // What the scope allows a phone, through the relay as directly.
    const sessions = await w.road('GET', '/sessions', { token: phone })
    expect(sessions.status, JSON.stringify(sessions.body)).toBe(200)
    expect((await w.direct('GET', '/sessions', { token: phone })).status).toBe(200)
    // What the scope keeps for the owner: refused the same way on both roads.
    for (const [method, pathname] of [
      ['GET', '/devices'],
      ['GET', '/devices/relay'],
      ['GET', '/devices/relay/status'],
      ['GET', '/sidebar/layouts']
    ] as const) {
      const viaRelay = await w.road(method, pathname, { token: phone })
      const direct = await w.direct(method, pathname, { token: phone })
      expect(viaRelay.status, `${method} ${pathname} through the relay`).toBe(403)
      expect(direct.status, `${method} ${pathname} directly`).toBe(403)
    }
    // No bearer, or one the server never issued: refused by the listener.
    expect((await w.road('GET', '/sessions')).status).toBe(401)
    expect((await w.road('GET', '/sessions', { token: 'a'.repeat(64) })).status).toBe(401)
  })

  it('keeps the owner binding: the phone of an owner who left is refused', async () => {
    const w = await start()
    const phone = await pairedPhone(w)
    expect((await w.road('GET', '/sessions', { token: phone })).status).toBe(200)
    w.owner.subject = 'another-person'
    const refused = await w.road('GET', '/sessions', { token: phone })
    const direct = await w.direct('GET', '/sessions', { token: phone })
    expect(refused.status).toBe(direct.status)
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.body)).toMatch(/another Antasphere account/)
    w.owner.subject = provider.state.user.sub
    expect((await w.road('GET', '/sessions', { token: phone })).status).toBe(200)
  })

  it('drops the Origin header on the way in', async () => {
    const w = await start()
    const phone = await pairedPhone(w)
    const answer = await w.road('GET', '/sessions', {
      token: phone,
      headers: { origin: 'https://evil.example' }
    })
    expect(answer.status).toBe(200)
    const last = w.seen.at(-1)!
    expect(last.authorization).toBe(`Bearer ${phone}`)
    expect(last.origin).toBeUndefined()
  })

  it('never carries the server’s own bearer token to the relay', async () => {
    const w = await start()
    const phone = await pairedPhone(w)
    // Traffic both ways: a request and its answer, a push socket's frames.
    expect((await w.road('GET', '/sessions', { token: phone })).status).toBe(200)
    const push = new WebSocket(`${w.relay.url.replace('http', 'ws')}/m/${w.machineId}/push`)
    const frames: string[] = []
    push.on('message', (data: RawData) => frames.push(String(data)))
    await new Promise<void>((resolve, reject) => {
      push.once('open', () => resolve())
      push.once('error', reject)
    })
    push.send(JSON.stringify({ _tag: 'hello', token: phone, client: 'phone-1' }))
    await until(() => frames.length > 0, 'a frame through the tunnel')
    expect(JSON.parse(frames[0]!)._tag).toBe('welcome')
    push.close()
    expect(w.sent.length).toBeGreaterThan(2)
    const everything = w.sent.join('\n')
    expect(everything).not.toContain(w.server.token)
    // And no request the listener received carried it either.
    expect(JSON.stringify(w.seen)).not.toContain(w.server.token)
  })
})
