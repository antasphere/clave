import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import { EnrollmentClient, EnrollmentError, type DeviceDescription } from './client'
import { pair, type PairingPorts, type PairingState } from './pairing'
import { EnrollmentRecords } from './records'

/**
 * A stub of lane A's device routes, speaking them as its brief and its
 * contract define them, scripted by the device's name: what the owner does
 * on the Mac is what the name says. Nothing of lane A's code runs here; the
 * stub is the wire, and lane A's own tests hold its server to the same wire.
 */
interface Pairing {
  readonly name: string
  reads: number
}
const state = {
  requests: [] as { headers: IncomingMessage['headers']; body: unknown }[],
  pairings: new Map<string, Pairing>(),
  sessions: new Set<string>(),
  revoked: new Set<string>(),
  pushTokens: [] as { bearer: string; body: unknown }[],
  clears: [] as string[],
  ttlMs: 600_000
}
let server: Server
let url = ''
let serial = 0

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const bearerOf = (req: IncomingMessage): string | null => {
  const auth = req.headers.authorization
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null
}
const session = (pairingId: string): Record<string, string> => ({
  token: `ds-${pairingId}`,
  deviceId: `dev-${pairingId}`,
  serverId: 'srv-1',
  serverName: 'Valentin’s Mac'
})

function readPairing(res: ServerResponse, id: string, pairing: Pairing | undefined): void {
  if (!pairing) return json(res, 200, { status: 'expired' })
  pairing.reads += 1
  const n = pairing.reads
  switch (pairing.name) {
    case 'approve-me':
      if (n < 3) return json(res, 200, { status: 'pending' })
      if (n === 3) {
        state.sessions.add(`ds-${id}`)
        return json(res, 200, { status: 'approved', deviceSession: session(id) })
      }
      return json(res, 200, { status: 'approved' })
    case 'refuse-me':
      return json(res, 200, { status: n < 2 ? 'pending' : 'refused' })
    case 'expire-me':
      return json(res, 200, { status: 'expired' })
    case 'consumed':
      return json(res, 200, { status: 'approved' })
    case 'drop-once':
      if (n === 1) {
        res.socket?.destroy()
        return
      }
      state.sessions.add(`ds-${id}`)
      return json(res, 200, { status: 'approved', deviceSession: session(id) })
    case 'forever':
      return json(res, 200, { status: 'pending' })
    default:
      return json(res, 200, { status: 'pending' })
  }
}

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const u = new URL(req.url ?? '/', 'http://x')
  let body: unknown = undefined
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      return json(res, 400, { error: 'Bad JSON' })
    }
  }
  const route = `${req.method} ${u.pathname}`
  if (route === 'POST /devices/pair') {
    state.requests.push({ headers: req.headers, body })
    const b = body as { idToken?: unknown; clientId?: unknown; device?: DeviceDescription }
    if (
      typeof b?.idToken !== 'string' ||
      typeof b.clientId !== 'string' ||
      typeof b.device?.name !== 'string' ||
      !['ios', 'android'].includes(b.device.platform) ||
      typeof b.device.appVersion !== 'string'
    )
      return json(res, 400, { error: 'Invalid pairing request.' })
    if (b.device.name === 'hang') return
    if (b.idToken === 'bad-token')
      return json(res, 422, {
        _tag: 'DevicePairingRefused',
        check: 'signature',
        message: 'The sign-in was refused by the signature check.'
      })
    if (b.idToken === 'no-owner')
      return json(res, 422, {
        _tag: 'CapabilityUnavailable',
        capability: 'devices',
        message: 'No Antasphere account is signed in on this server.'
      })
    const id = `p-${++serial}`
    state.pairings.set(id, { name: b.device.name, reads: 0 })
    return json(res, 200, { pairingId: id, expiresAt: Date.now() + state.ttlMs })
  }
  if (route === 'GET /devices/pair') {
    const id = u.searchParams.get('id') ?? ''
    return readPairing(res, id, state.pairings.get(id))
  }
  const bearer = bearerOf(req)
  if (!bearer || !state.sessions.has(bearer)) return json(res, 401, { error: 'Unauthenticated' })
  if (state.revoked.has(bearer))
    return json(res, 422, { _tag: 'DeviceNotFound', id: 'x', message: 'No such device.' })
  switch (route) {
    case 'GET /devices/me':
      return json(res, 200, {
        id: `dev-${bearer.slice(3)}`,
        name: 'iPhone Air',
        platform: 'ios',
        appVersion: '0.1.0',
        createdAt: 1,
        lastSeenAt: null
      })
    case 'POST /devices/me/push-token':
      state.pushTokens.push({ bearer, body })
      res.writeHead(204)
      res.end()
      return
    case 'POST /devices/me/push-token/clear':
      state.clears.push(bearer)
      res.writeHead(204)
      res.end()
      return
    default:
      return json(res, 404, { error: 'Not found' })
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  serial = 0
  state.requests = []
  state.pairings.clear()
  state.sessions.clear()
  state.revoked.clear()
  state.pushTokens = []
  state.clears = []
  state.ttlMs = 600_000
})

const device: DeviceDescription = { name: 'approve-me', platform: 'ios', appVersion: '0.1.0' }
const client = (): EnrollmentClient => new EnrollmentClient(url, { build: 'development' })

describe('EnrollmentClient', () => {
  it('asks to pair with the ID token, the client id and the device, and no bearer', async () => {
    const ticket = await client().requestPairing({ idToken: 'id-1', clientId: 'c-1', device })
    expect(ticket.pairingId).toMatch(/^p-/)
    expect(ticket.expiresAt).toBeGreaterThan(Date.now())
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.headers.authorization).toBeUndefined()
    expect(state.requests[0]!.body).toEqual({
      idToken: 'id-1',
      clientId: 'c-1',
      device: { name: 'approve-me', platform: 'ios', appVersion: '0.1.0' }
    })
  })

  it('a token the server refuses is said with the check that refused it', async () => {
    const error = await client()
      .requestPairing({ idToken: 'bad-token', clientId: 'c-1', device })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EnrollmentError)
    expect((error as EnrollmentError).kind).toBe('refused')
    expect((error as EnrollmentError).check).toBe('signature')
    expect((error as EnrollmentError).message).not.toContain('bad-token')
  })

  it('a server nobody owns admits no phone', async () => {
    const error = await client()
      .requestPairing({ idToken: 'no-owner', clientId: 'c-1', device })
      .catch((e: unknown) => e)
    expect((error as EnrollmentError).kind).toBe('no-owner')
  })

  it('reads the pairing, the session carried once', async () => {
    const c = client()
    const { pairingId } = await c.requestPairing({ idToken: 'id-1', clientId: 'c-1', device })
    expect(await c.readPairing(pairingId)).toEqual({ status: 'pending' })
    expect(await c.readPairing(pairingId)).toEqual({ status: 'pending' })
    const approved = await c.readPairing(pairingId)
    expect(approved.status).toBe('approved')
    expect(approved.deviceSession).toEqual({
      token: `ds-${pairingId}`,
      deviceId: `dev-${pairingId}`,
      serverId: 'srv-1',
      serverName: 'Valentin’s Mac'
    })
    expect(await c.readPairing(pairingId)).toEqual({ status: 'approved' })
    expect(await c.readPairing('never')).toEqual({ status: 'expired' })
  })

  it("the device's own routes carry the device session as the bearer", async () => {
    state.sessions.add('ds-ok')
    const c = client()
    expect(await c.me('ds-ok')).toEqual({
      id: 'dev-ok',
      name: 'iPhone Air',
      platform: 'ios',
      appVersion: '0.1.0',
      createdAt: 1,
      lastSeenAt: null
    })
    await c.setPushToken('ds-ok', 'apns-token-1', 'ios')
    await c.clearPushToken('ds-ok')
    expect(state.pushTokens).toEqual([
      { bearer: 'ds-ok', body: { token: 'apns-token-1', platform: 'ios' } }
    ])
    expect(state.clears).toEqual(['ds-ok'])
  })

  it('a session the server does not know is unauthenticated; a revoked phone is revoked', async () => {
    const c = client()
    const unknown = await c.me('ds-nope').catch((e: unknown) => e)
    expect((unknown as EnrollmentError).kind).toBe('unauthenticated')
    state.sessions.add('ds-gone')
    state.revoked.add('ds-gone')
    const gone = await c.me('ds-gone').catch((e: unknown) => e)
    expect((gone as EnrollmentError).kind).toBe('revoked')
  })

  it('a release build sends no credential to a plain-http address', () => {
    expect(() => new EnrollmentClient(url, { build: 'release' })).toThrow(EnrollmentError)
    try {
      new EnrollmentClient(url, { build: 'release' })
    } catch (error) {
      expect((error as EnrollmentError).kind).toBe('policy')
    }
    expect(() => new EnrollmentClient('https://relay.example/m/abc', {})).not.toThrow()
  })

  it('an unreachable machine is a network failure, a silent one a timeout', async () => {
    const dead = new EnrollmentClient('http://127.0.0.1:1', { build: 'development' })
    const network = await dead
      .requestPairing({ idToken: 'id', clientId: 'c', device })
      .catch((e: unknown) => e)
    expect((network as EnrollmentError).kind).toBe('network')
    const slow = new EnrollmentClient(url, { build: 'development', timeoutMs: 50 })
    const timeout = await slow
      .requestPairing({ idToken: 'id', clientId: 'c', device: { ...device, name: 'hang' } })
      .catch((e: unknown) => e)
    expect((timeout as EnrollmentError).kind).toBe('timeout')
  })
})

describe('pair', () => {
  const machine = { id: 'm-1', baseUrl: '' }
  let credentials: SecureCredentialStore
  let records: EnrollmentRecords
  let states: PairingState[]
  let sleeps: number[]
  const ports = (overrides: Partial<PairingPorts> = {}): PairingPorts => ({
    client: client(),
    credentials,
    records,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: () => Date.now(),
    onState: (s) => states.push(s),
    ...overrides
  })

  beforeEach(() => {
    credentials = new SecureCredentialStore(new MemorySecureStore())
    records = new EnrollmentRecords(new MemoryKeyValueStore())
    states = []
    sleeps = []
    machine.baseUrl = url
  })

  it('waits two seconds between reads, then keeps the session under the machine id', async () => {
    const end = await pair({ machine, idToken: 'id-1', clientId: 'c-1', device }, ports())
    expect(end.kind).toBe('approved')
    expect(states.map((s) => s.kind)).toEqual([
      'requesting',
      'waiting',
      'waiting',
      'waiting',
      'approved'
    ])
    expect(sleeps).toEqual([2000, 2000, 2000])
    const credential = await credentials.get('m-1')
    expect(credential).toEqual({ serverUrl: url, bearer: 'ds-p-1' })
    expect(await credentials.mainMachineId()).toBe('m-1')
    const record = await records.get('m-1')
    expect(record).toMatchObject({
      machineId: 'm-1',
      deviceId: 'dev-p-1',
      serverId: 'srv-1',
      serverName: 'Valentin’s Mac'
    })
    expect(await records.byServerId('srv-1')).toEqual(record)
    if (end.kind === 'approved') expect(end.record).toEqual(record)
  })

  it('a refusal on the Mac is refused here, nothing kept', async () => {
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device: { ...device, name: 'refuse-me' } },
      ports()
    )
    expect(end).toEqual({ kind: 'refused' })
    expect(await credentials.get('m-1')).toBeNull()
    expect(await records.get('m-1')).toBeNull()
  })

  it('a pairing the server let lapse is expired', async () => {
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device: { ...device, name: 'expire-me' } },
      ports()
    )
    expect(end).toEqual({ kind: 'expired' })
  })

  it('a pairing still pending past the deadline and the grace is expired here', async () => {
    state.ttlMs = 0
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device: { ...device, name: 'forever' } },
      ports({ now: () => Date.now() + 1 }),
      { graceMs: 0 }
    )
    expect(end).toEqual({ kind: 'expired' })
  })

  it('an approval already handed out is a failure that says to pair again', async () => {
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device: { ...device, name: 'consumed' } },
      ports()
    )
    expect(end).toMatchObject({ kind: 'failed', failure: 'consumed' })
    expect(await credentials.get('m-1')).toBeNull()
  })

  it('a read the network loses keeps the wait, and the approval still lands', async () => {
    let dropped = false
    const unreliable = new EnrollmentClient(url, {
      build: 'development',
      fetch: async (input, init) => {
        if (init?.method === 'GET' && !dropped) {
          dropped = true
          throw new Error('fixture connection lost')
        }
        return fetch(input, init)
      }
    })
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device: { ...device, name: 'drop-once' } },
      ports({ client: unreliable })
    )
    expect(end.kind).toBe('approved')
    expect(dropped).toBe(true)
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    expect(await credentials.get('m-1')).not.toBeNull()
  })

  it('leaving the screen stops the polling', async () => {
    const end = await pair(
      { machine, idToken: 'id-1', clientId: 'c-1', device },
      ports({ cancelled: () => sleeps.length >= 1 })
    )
    expect(end).toEqual({ kind: 'cancelled' })
    expect(state.pairings.get('p-1')?.reads).toBe(0)
  })

  it('a refused token fails with the check named', async () => {
    const end = await pair({ machine, idToken: 'bad-token', clientId: 'c-1', device }, ports())
    expect(end).toMatchObject({ kind: 'failed', failure: 'refused', check: 'signature' })
    expect(sleeps).toEqual([])
  })
})

describe('EnrollmentRecords', () => {
  it('keeps one record per machine, finds the latest by server, survives a restart', async () => {
    const kv = new MemoryKeyValueStore()
    const first = new EnrollmentRecords(kv)
    await first.set({
      machineId: 'm-1',
      deviceId: 'd-1',
      serverId: 's-1',
      serverName: 'A',
      pairedAt: 1
    })
    await first.set({
      machineId: 'm-2',
      deviceId: 'd-2',
      serverId: 's-1',
      serverName: 'A',
      pairedAt: 2
    })
    await first.set({
      machineId: 'm-1',
      deviceId: 'd-3',
      serverId: 's-1',
      serverName: 'A',
      pairedAt: 3
    })
    const second = new EnrollmentRecords(kv)
    expect((await second.list()).map((r) => r.machineId)).toEqual(['m-2', 'm-1'])
    expect((await second.byServerId('s-1'))?.machineId).toBe('m-1')
    expect(await second.byServerId('s-9')).toBeNull()
    await second.remove('m-1')
    expect((await second.byServerId('s-1'))?.machineId).toBe('m-2')
    await second.remove('m-2')
    expect(await kv.getItem('clave.enrollments')).toBeNull()
  })
})

it('concurrent approvals retain both enrollment records', async () => {
  const records = new EnrollmentRecords(new MemoryKeyValueStore())
  await Promise.all(
    ['m-1', 'm-2'].map((machineId) =>
      records.set({
        machineId,
        serverId: machineId,
        deviceId: 'd-1',
        serverName: 'Fixture',
        pairedAt: 1
      })
    )
  )
  expect((await records.list()).map((r) => r.machineId)).toEqual(['m-1', 'm-2'])
})
