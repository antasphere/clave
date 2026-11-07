/**
 * The relay (lane E of the mobile wave) against a local OIDC provider standing
 * in for the hub (tests/e2e/fixtures/oidc-provider.mjs) and against fake
 * machines: ws clients on `/machines/connect` that speak the frames of
 * `@clave/contract/relay` by hand. Everything listens on 127.0.0.1, port 0.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, type RawData } from 'ws'
import { Effect, Either, Layer } from 'effect'
import { run } from '@structure-ai/fixtures'
import { HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { relayFixtureCatalog } from './relay.fixtures'
import {
  decodeRelayFrame,
  encodeMachineFrame,
  type MachineCredential,
  type MachineFrame,
  type MachineRecord,
  type MachineView,
  type RelayFrame
} from '@clave/contract/relay'
import {
  startOidcProvider,
  type OidcProvider
} from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { sleep } from '../test-support'
import { startRelay, type Relay, type RelayOptions } from './relay'

vi.setConfig({ testTimeout: 20_000 })

let provider: OidcProvider
const relays: Relay[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const RECORD: MachineRecord = {
  name: 'Ada’s Mac',
  platform: 'macos',
  version: '1.2.3',
  direct: [{ url: 'http://192.168.1.20:4100' }]
}

interface Closed {
  readonly code: number
  readonly reason: string
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-relay-test-'))
  dirs.push(dir)
  return dir
}

async function relayFor(options: Partial<RelayOptions> = {}): Promise<Relay> {
  const relay = await startRelay({
    issuer: provider.issuer,
    ...options,
    dataDir: options.dataDir ?? tempDir()
  })
  relays.push(relay)
  return relay
}

/** A loopback port nothing listens on. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const wsUrl = (relay: Relay, route: string): string => `${relay.url.replace(/^http/, 'ws')}${route}`
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const base64 = (text: string): string => Buffer.from(text).toString('base64')
const textOf = (data: RawData): string =>
  (Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data)
  ).toString('utf8')

function claim(relay: Relay, token: string, record: MachineRecord = RECORD): Promise<Response> {
  return fetch(`${relay.url}/machines/claim`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(record)
  })
}

async function claimed(
  relay: Relay,
  token: string,
  record: MachineRecord = RECORD
): Promise<MachineCredential> {
  const response = await claim(relay, token, record)
  expect(response.status).toBe(201)
  return (await response.json()) as MachineCredential
}

async function machinesOf(relay: Relay, token: string): Promise<MachineView[]> {
  const response = await fetch(`${relay.url}/machines`, { headers: bearer(token) })
  expect(response.status).toBe(200)
  return ((await response.json()) as { machines: MachineView[] }).machines
}

function forget(relay: Relay, token: string, machineId: string): Promise<Response> {
  return fetch(`${relay.url}/machines/forget`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ machineId })
  })
}

/** Read until `accept` holds or the time is up; the last reading either way. */
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value) && Date.now() < deadline) {
    await sleep(20)
    value = await read()
  }
  return value
}

/** The promise, or a failure naming what did not happen in time. */
function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: not within ${timeoutMs} ms`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

type RelayTag = RelayFrame['_tag']
type RelayFrameOf<T extends RelayTag> = Extract<RelayFrame, { _tag: T }>

/** A machine played by hand: a ws client on `/machines/connect` that keeps
 *  every frame the relay sends, decoded, and hands them back by tag. */
interface FakeMachine {
  readonly socket: WebSocket
  /** Every frame received, in order. */
  readonly frames: RelayFrame[]
  /** How the socket closed, once it has. */
  closed(timeoutMs?: number): Promise<Closed>
  /** The next frame of that tag not yet read. */
  next<T extends RelayTag>(tag: T, timeoutMs?: number): Promise<RelayFrameOf<T>>
  send(frame: MachineFrame): void
}

/** The control socket, open, nothing said yet. */
async function openControl(
  relay: Relay,
  options: { answerPings?: boolean } = {}
): Promise<FakeMachine> {
  const socket = new WebSocket(wsUrl(relay, '/machines/connect'))
  sockets.push(socket)
  const frames: RelayFrame[] = []
  const unread = new Map<RelayTag, RelayFrame[]>()
  const waiting = new Map<RelayTag, Array<(frame: RelayFrame) => void>>()
  const closing = new Promise<Closed>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  // A refused hello ends in a close code, read through `closed`.
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const decoded = decodeRelayFrame(textOf(data))
    if (Either.isLeft(decoded)) throw new Error(`An undecodable relay frame: ${textOf(data)}`)
    const frame = decoded.right
    frames.push(frame)
    if (options.answerPings && frame._tag === 'ping')
      socket.send(encodeMachineFrame({ _tag: 'pong' }))
    const waiter = waiting.get(frame._tag)?.shift()
    if (waiter) waiter(frame)
    else unread.set(frame._tag, [...(unread.get(frame._tag) ?? []), frame])
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return {
    socket,
    frames,
    closed: (timeoutMs = 3_000) => within(closing, timeoutMs, 'The control socket closing'),
    next: <T extends RelayTag>(tag: T, timeoutMs = 3_000): Promise<RelayFrameOf<T>> => {
      const queued = unread.get(tag)?.shift()
      if (queued) return Promise.resolve(queued as RelayFrameOf<T>)
      return new Promise((resolve, reject) => {
        const list = waiting.get(tag) ?? []
        waiting.set(tag, list)
        const timer = setTimeout(() => {
          const at = list.indexOf(waiter)
          if (at >= 0) list.splice(at, 1)
          reject(new Error(`No ${tag} frame within ${timeoutMs} ms`))
        }, timeoutMs)
        const waiter = (frame: RelayFrame): void => {
          clearTimeout(timer)
          resolve(frame as RelayFrameOf<T>)
        }
        list.push(waiter)
      })
    },
    send: (frame) => socket.send(encodeMachineFrame(frame))
  }
}

/** A machine that said hello with its credential and was welcomed. */
async function connectMachine(
  relay: Relay,
  credential: MachineCredential,
  options: { answerPings?: boolean } = {}
): Promise<FakeMachine> {
  const machine = await openControl(relay, options)
  machine.send({ _tag: 'hello', ...credential, record: RECORD })
  expect(await machine.next('welcome')).toEqual({
    _tag: 'welcome',
    machineId: credential.machineId,
    protocol: 1
  })
  return machine
}

/** A phone's push socket through the relay. */
interface Phone {
  readonly socket: WebSocket
  readonly opened: Promise<void>
  closed(timeoutMs?: number): Promise<Closed>
  nextMessage(timeoutMs?: number): Promise<{ text: string; binary: boolean }>
}

function openPhone(url: string): Phone {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const unread: Array<{ text: string; binary: boolean }> = []
  const waiting: Array<(message: { text: string; binary: boolean }) => void> = []
  socket.on('error', () => {})
  socket.on('message', (data, binary) => {
    const message = { text: textOf(data), binary }
    const waiter = waiting.shift()
    if (waiter) waiter(message)
    else unread.push(message)
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  // Awaited where it matters; never an unhandled rejection where it does not.
  opened.catch(() => {})
  const closing = new Promise<Closed>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  return {
    socket,
    opened,
    closed: (timeoutMs = 3_000) => within(closing, timeoutMs, 'The push socket closing'),
    nextMessage: (timeoutMs = 3_000) => {
      const queued = unread.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No message within ${timeoutMs} ms`)),
          timeoutMs
        )
        waiting.push((message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    }
  }
}

/** The status of a refused upgrade. With a listener on 'unexpected-response'
 *  ws hands the answer there and leaves the handshake to end by hand. */
function upgradeStatus(url: string): Promise<number> {
  const refused = new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url)
    sockets.push(socket)
    socket.on('error', () => {})
    socket.once('open', () => reject(new Error(`The upgrade to ${url} was accepted`)))
    socket.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
      socket.terminate()
    })
  })
  return within(refused, 3_000, `The upgrade to ${url} answering`)
}

interface Answer {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

/** One request through node:http, for what fetch will not send: a TRACE, a
 *  CONNECT, a body in chunks with no length. */
function call(url: string, options: { method: string; chunks?: Buffer[] }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: options.method,
      ...(options.chunks && { headers: { 'transfer-encoding': 'chunked' } })
    })
    const answer = (res: IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      )
      res.on('error', reject)
    }
    req.on('response', answer)
    // node:http hands the answer to a CONNECT here, whatever its status.
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.alloc(0) })
    })
    // Settled or not, a late error (the relay ending the socket) lands here.
    req.on('error', reject)
    for (const chunk of options.chunks ?? []) req.write(chunk)
    req.end()
  })
}

describe('the directory of machines', () => {
  it('lists to each subject the machines it claimed, and only those', async () => {
    const relay = await relayFor()
    const a = provider.mintAccessToken({ sub: 'subject-a' })
    const b = provider.mintAccessToken({ sub: 'subject-b' })
    const claimA = await claim(relay, a)
    expect(claimA.status).toBe(201)
    const ofA = (await claimA.json()) as MachineCredential
    expect(ofA.machineId).toMatch(/^m_/)
    expect(ofA.machineSecret).toMatch(/^cms_/)
    const recordB: MachineRecord = {
      name: 'Build box',
      platform: 'linux',
      version: '2.0.0',
      direct: []
    }
    const claimB = await claim(relay, b, recordB)
    expect(claimB.status).toBe(201)
    const ofB = (await claimB.json()) as MachineCredential
    expect(ofB.machineId).toMatch(/^m_/)
    expect(ofB.machineSecret).toMatch(/^cms_/)
    expect(ofB.machineId).not.toBe(ofA.machineId)

    expect(await machinesOf(relay, a)).toEqual([
      {
        id: ofA.machineId,
        name: 'Ada’s Mac',
        platform: 'macos',
        version: '1.2.3',
        online: false,
        lastSeen: null,
        direct: [{ url: 'http://192.168.1.20:4100' }]
      }
    ])
    expect(await machinesOf(relay, b)).toEqual([
      {
        id: ofB.machineId,
        name: 'Build box',
        platform: 'linux',
        version: '2.0.0',
        online: false,
        lastSeen: null,
        direct: []
      }
    ])
  })

  it('refuses a missing, unknown, expired or foreign bearer, and a forget of another subject’s machine', async () => {
    const relay = await relayFor()
    const a = provider.mintAccessToken({ sub: 'subject-a' })
    const b = provider.mintAccessToken({ sub: 'subject-b' })
    const ofB = await claimed(relay, b)

    expect((await fetch(`${relay.url}/machines`)).status).toBe(401)
    const anonymousClaim = await fetch(`${relay.url}/machines/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(RECORD)
    })
    expect(anonymousClaim.status).toBe(401)
    const madeUp = await fetch(`${relay.url}/machines`, { headers: bearer('at-made-up-0123456') })
    expect(madeUp.status).toBe(401)

    // Refused on sight: the hub is not asked.
    const before = provider.state.counts.userinfo
    const expired = provider.mintAccessToken({ sub: 'subject-a', jwt: true, expiresInSec: -10 })
    expect((await fetch(`${relay.url}/machines`, { headers: bearer(expired) })).status).toBe(401)
    expect(provider.state.counts.userinfo).toBe(before)
    const foreign = provider.mintAccessToken({
      sub: 'subject-a',
      jwt: true,
      iss: 'https://other.example'
    })
    expect((await fetch(`${relay.url}/machines`, { headers: bearer(foreign) })).status).toBe(401)
    expect(provider.state.counts.userinfo).toBe(before)
    // The control: a current JWT of this hub is asked about, and accepted.
    const current = provider.mintAccessToken({ sub: 'subject-a', jwt: true })
    expect(await machinesOf(relay, current)).toEqual([])
    expect(provider.state.counts.userinfo).toBe(before + 1)

    const refused = await forget(relay, a, ofB.machineId)
    expect(refused.status).toBe(404)
    expect((await machinesOf(relay, b)).map((m) => m.id)).toEqual([ofB.machineId])
  })

  it('asks the hub once per bearer, and again for another bearer of the same subject', async () => {
    const relay = await relayFor()
    const first = provider.mintAccessToken({ sub: 'subject-c' })
    const before = provider.state.counts.userinfo
    await machinesOf(relay, first)
    await machinesOf(relay, first)
    expect(provider.state.counts.userinfo - before).toBe(1)
    const second = provider.mintAccessToken({ sub: 'subject-c' })
    await machinesOf(relay, second)
    expect(provider.state.counts.userinfo - before).toBe(2)
  })

  it('answers 503, not 401, when the hub does not answer', async () => {
    const relay = await relayFor({ issuer: `http://127.0.0.1:${await freePort()}` })
    for (const token of [provider.mintAccessToken({ sub: 'subject-a' }), 'at-anything-at-all']) {
      const response = await fetch(`${relay.url}/machines`, { headers: bearer(token) })
      expect(response.status).toBe(503)
    }
  })

  it('keeps machines.json private, with the id and the owner and no secret in clear', async () => {
    // A directory the relay creates itself, so its mode is the relay's doing.
    const dataDir = path.join(tempDir(), 'relay-data')
    const relay = await relayFor({ dataDir })
    const token = provider.mintAccessToken({ sub: 'subject-d' })
    const credential = await claimed(relay, token)
    const file = path.join(dataDir, 'machines.json')
    const check = (): void => {
      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toContain(credential.machineId)
      expect(text).toContain('subject-d')
      expect(text).not.toContain('cms_')
      expect(text).not.toContain(credential.machineSecret)
    }
    check()
    // Written again whole at every connect: still private, still no secret.
    await connectMachine(relay, credential)
    check()
  })

  it('answers a machine secret once, at its claim, and a second claim is another machine', async () => {
    const relay = await relayFor()
    const token = provider.mintAccessToken({ sub: 'subject-e' })
    const first = await claimed(relay, token)
    const answers = [
      await fetch(`${relay.url}/machines`, { headers: bearer(token) }),
      await fetch(`${relay.url}/health`),
      await fetch(`${relay.url}/machines/claim`, { headers: bearer(token) }),
      await fetch(`${relay.url}/m/${first.machineId}/machines`, { headers: bearer(token) })
    ]
    for (const answer of answers) {
      const text = await answer.text()
      expect(text).not.toContain(first.machineSecret)
      expect(text).not.toContain('cms_')
    }
    const second = await claimed(relay, token)
    expect(second.machineId).toMatch(/^m_/)
    expect(second.machineSecret).toMatch(/^cms_/)
    expect(second.machineId).not.toBe(first.machineId)
    expect(second.machineSecret).not.toBe(first.machineSecret)
    expect((await machinesOf(relay, token)).map((m) => m.id).sort()).toEqual(
      [first.machineId, second.machineId].sort()
    )
  })
})

describe('the control socket', () => {
  it('closes a wrong hello, a frame before the hello and a silent socket, and welcomes a right hello', async () => {
    const relay = await relayFor({ helloTimeoutMs: 300 })
    const token = provider.mintAccessToken({ sub: 'subject-f' })
    const credential = await claimed(relay, token)

    const wrong = await openControl(relay)
    wrong.send({
      _tag: 'hello',
      machineId: credential.machineId,
      machineSecret: `cms_${'0'.repeat(48)}`,
      record: RECORD
    })
    expect((await wrong.closed()).code).toBe(4001)

    const early = await openControl(relay)
    early.send({ _tag: 'pong' })
    expect((await early.closed()).code).toBe(4002)
    const garbled = await openControl(relay)
    garbled.socket.send('not a frame')
    expect((await garbled.closed()).code).toBe(4002)

    const silent = await openControl(relay)
    const openedAt = Date.now()
    expect((await silent.closed()).code).toBe(4008)
    expect(Date.now() - openedAt).toBeGreaterThanOrEqual(200)

    for (const refused of [wrong, early, garbled, silent]) expect(refused.frames).toEqual([])
    expect(relay.online()).toEqual([])

    const machine = await openControl(relay)
    machine.send({ _tag: 'hello', ...credential, record: RECORD })
    expect(await machine.next('welcome')).toEqual({
      _tag: 'welcome',
      machineId: credential.machineId,
      protocol: 1
    })
    expect(await machinesOf(relay, token)).toEqual([
      expect.objectContaining({ id: credential.machineId, online: true })
    ])
    expect(relay.online()).toEqual([credential.machineId])
  })

  it('welcomes a newer socket of the same machine and closes the older one with 4009', async () => {
    const relay = await relayFor()
    const token = provider.mintAccessToken({ sub: 'subject-g' })
    const credential = await claimed(relay, token)
    const older = await connectMachine(relay, credential)
    const newer = await connectMachine(relay, credential)
    expect((await older.closed()).code).toBe(4009)
    expect(newer.socket.readyState).toBe(WebSocket.OPEN)
    expect(relay.online()).toEqual([credential.machineId])
    // The road now leads to the newer socket.
    const answered = fetch(`${relay.url}/m/${credential.machineId}/health/live`)
    const request = await newer.next('request')
    newer.send({ _tag: 'response', id: request.id, status: 200, headers: {}, body: base64('live') })
    const response = await answered
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('live')
  })

  it('ends a machine that never answers the pings with 4011, and keeps one that does', async () => {
    const relay = await relayFor({ pingMs: 100, offlineMs: 400 })
    const token = provider.mintAccessToken({ sub: 'subject-h' })
    const quiet = await claimed(relay, token, { ...RECORD, name: 'Quiet' })
    const lively = await claimed(relay, token, { ...RECORD, name: 'Lively' })
    const mute = await connectMachine(relay, quiet)
    const answering = await connectMachine(relay, lively, { answerPings: true })
    const since = Date.now()

    expect((await mute.closed()).code).toBe(4011)
    expect(mute.frames.some((frame) => frame._tag === 'ping')).toBe(true)
    const row = (await machinesOf(relay, token)).find((m) => m.id === quiet.machineId)
    expect(row?.online).toBe(false)
    expect(typeof row?.lastSeen).toBe('number')

    await sleep(Math.max(0, 1_100 - (Date.now() - since)))
    expect(answering.socket.readyState).toBe(WebSocket.OPEN)
    expect(answering.frames.filter((frame) => frame._tag === 'ping').length).toBeGreaterThan(5)
    expect(relay.online()).toEqual([lively.machineId])
    const kept = (await machinesOf(relay, token)).find((m) => m.id === lively.machineId)
    expect(kept?.online).toBe(true)
  })

  it('lists a machine offline as soon as it closes its socket', async () => {
    const relay = await relayFor()
    const token = provider.mintAccessToken({ sub: 'subject-i' })
    const credential = await claimed(relay, token)
    const machine = await connectMachine(relay, credential)
    expect((await machinesOf(relay, token))[0].online).toBe(true)
    machine.socket.close(1000, 'quitting')
    expect((await machine.closed()).code).toBe(1000)
    // Pings every 25 s and 60 s of silence by default: only the close explains this.
    const rows = await eventually(
      () => machinesOf(relay, token),
      (list) => list[0]?.online === false,
      500
    )
    expect(rows).toEqual([
      expect.objectContaining({
        id: credential.machineId,
        online: false,
        lastSeen: expect.any(Number)
      })
    ])
    expect(relay.online()).toEqual([])
  })
})

describe('the road to a machine', () => {
  it('carries a request to the machine as it came and its whole answer back', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-j' }))
    const machine = await connectMachine(relay, credential)
    const answered = fetch(`${relay.url}/m/${credential.machineId}/sessions?windowKey=w1`, {
      headers: { authorization: 'Bearer phone-token', 'x-extra': '1' }
    })
    const request = await machine.next('request')
    const saw = JSON.stringify(request)
    machine.send({
      _tag: 'response',
      id: request.id,
      status: 200,
      headers: { 'content-type': 'application/json', 'x-answered': 'yes' },
      body: base64(saw)
    })
    const response = await answered
    expect(response.status).toBe(200)
    expect(response.headers.get('x-answered')).toBe('yes')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(request.method).toBe('GET')
    expect(request.path).toBe('/sessions?windowKey=w1')
    expect(request.headers.authorization).toBe('Bearer phone-token')
    expect(request.headers['x-extra']).toBe('1')
    expect(request.headers).not.toHaveProperty('host')
    expect(request.headers).not.toHaveProperty('connection')
    expect(await response.json()).toEqual(JSON.parse(saw))
  })

  it('carries a request body to the machine byte for byte', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-k' }))
    const machine = await connectMachine(relay, credential)
    const payload = JSON.stringify({ id: 's1', input: { type: 'user_message', text: 'héllo ✓' } })
    const answered = fetch(`${relay.url}/m/${credential.machineId}/sessions/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    const request = await machine.next('request')
    machine.send({ _tag: 'response', id: request.id, status: 204, headers: {}, body: '' })
    expect((await answered).status).toBe(204)
    expect(request.method).toBe('POST')
    expect(request.headers['content-type']).toBe('application/json')
    expect(Buffer.from(request.body, 'base64').equals(Buffer.from(payload))).toBe(true)
  })

  it('streams an answer sent as a head, chunks and an end', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-l' }))
    const machine = await connectMachine(relay, credential)
    const bytes = randomBytes(200 * 1024)
    const answered = fetch(`${relay.url}/m/${credential.machineId}/files/blob`)
    const request = await machine.next('request')
    machine.send({
      _tag: 'response-head',
      id: request.id,
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })
    const piece = 48 * 1024
    for (let at = 0; at < bytes.length; at += piece)
      machine.send({
        _tag: 'response-chunk',
        id: request.id,
        data: bytes.subarray(at, at + piece).toString('base64')
      })
    machine.send({ _tag: 'response-end', id: request.id })
    const response = await answered
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    const received = Buffer.from(await response.arrayBuffer())
    expect(received.length).toBe(204800)
    expect(received.equals(bytes)).toBe(true)
  })

  it('answers 404, 503, 413, 502, 504 and 405 where the road cannot carry a request', async () => {
    const relay = await relayFor({ maxBodyBytes: 1024, requestTimeoutMs: 500 })
    const token = provider.mintAccessToken({ sub: 'subject-m' })
    const online = await claimed(relay, token, { ...RECORD, name: 'Online' })
    const offline = await claimed(relay, token, { ...RECORD, name: 'Offline' })
    const machine = await connectMachine(relay, online)
    const road = (machineId: string): string => `${relay.url}/m/${machineId}/x`
    const forwarded = (): number => machine.frames.filter((f) => f._tag === 'request').length

    expect((await fetch(road('m_0000000000000000'))).status).toBe(404)
    expect((await fetch(road(offline.machineId))).status).toBe(503)
    const announced = await fetch(road(online.machineId), {
      method: 'POST',
      body: Buffer.alloc(2048, 1)
    })
    expect(announced.status).toBe(413)
    const chunked = await call(road(online.machineId), {
      method: 'POST',
      chunks: [Buffer.alloc(700, 2), Buffer.alloc(700, 3)]
    })
    expect(chunked.status).toBe(413)
    expect(forwarded()).toBe(0)

    const failing = fetch(road(online.machineId))
    const request = await machine.next('request')
    machine.send({ _tag: 'response-error', id: request.id, message: 'the listener is down' })
    expect((await failing).status).toBe(502)

    const startedAt = Date.now()
    const unanswered = await fetch(road(online.machineId))
    expect(unanswered.status).toBe(504)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450)
    expect(forwarded()).toBe(2)

    expect((await call(road(online.machineId), { method: 'TRACE' })).status).toBe(405)
    const connect = await call(road(online.machineId), { method: 'CONNECT' }).then(
      (answer) => answer.status,
      (error: Error) => `no answer: ${error.message}`
    )
    expect(forwarded()).toBe(2)
    expect(connect).toBe(405)
  })

  it('counts chunked uploads before their bodies finish', async () => {
    const relay = await relayFor({ maxRequests: 2, requestTimeoutMs: 3_000 })
    const credential = await claimed(relay, provider.mintAccessToken())
    const machine = await connectMachine(relay, credential)
    const uploads = Array.from({ length: 3 }, () => {
      const req = httpRequest(`${relay.url}/m/${credential.machineId}/upload`, { method: 'POST' })
      const answer = new Promise<number>((resolve, reject) => {
        req.on('response', (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
      })
      req.write('first part')
      return { req, answer }
    })
    try {
      await sleep(150)
      const overloaded = await Promise.race([uploads[2].answer, sleep(1000).then(() => 0)])
      for (const { req } of uploads) req.end('last part')
      const one = await machine.next('request')
      const two = await machine.next('request')
      for (const request of [one, two])
        machine.send({ _tag: 'response', id: request.id, status: 200, headers: {}, body: '' })
      const statuses = await Promise.all(uploads.map(({ answer }) => answer))
      expect(overloaded).toBe(503)
      expect(statuses).toEqual([200, 200, 503])
      expect(machine.frames.filter((f) => f._tag === 'request')).toHaveLength(2)
    } finally {
      for (const { req, answer } of uploads) {
        req.destroy()
        void answer.catch(() => {})
      }
    }
  })

  it('cancels the local request when the response deadline expires', async () => {
    const relay = await relayFor({ requestTimeoutMs: 150 })
    const credential = await claimed(relay, provider.mintAccessToken())
    const machine = await connectMachine(relay, credential)
    const answered = fetch(`${relay.url}/m/${credential.machineId}/never-ending`)
    const request = await machine.next('request')
    expect((await answered).status).toBe(504)
    const abort = await machine.next('request-abort', 1000)
    expect(abort.id).toBe(request.id)
  })

  it('answers 503 past the cap of requests in flight, and lets one through again once answered', async () => {
    // A request let through past the cap would end in a 504, not hang the test.
    const relay = await relayFor({ maxRequests: 2, requestTimeoutMs: 3_000 })
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-n' }))
    const machine = await connectMachine(relay, credential)
    const road = `${relay.url}/m/${credential.machineId}/slow`
    const first = fetch(road)
    const second = fetch(road)
    const held = [await machine.next('request'), await machine.next('request')]
    const third = await fetch(road)
    expect(third.status).toBe(503)
    expect(machine.frames.filter((f) => f._tag === 'request')).toHaveLength(2)
    for (const request of held)
      machine.send({
        _tag: 'response',
        id: request.id,
        status: 200,
        headers: {},
        body: base64('done')
      })
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    const fourth = fetch(road)
    const request = await machine.next('request')
    machine.send({
      _tag: 'response',
      id: request.id,
      status: 200,
      headers: {},
      body: base64('done')
    })
    const response = await fourth
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('done')
  })
})

describe('the push tunnel', () => {
  it('pipes a phone’s push socket to the machine both ways and ends it from either side', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-o' }))
    const machine = await connectMachine(relay, credential)
    const pushUrl = wsUrl(relay, `/m/${credential.machineId}/push`)

    const phone = openPhone(pushUrl)
    const opened = await machine.next('tunnel-open')
    expect(opened.tunnelId).toEqual(expect.any(String))
    await phone.opened
    phone.socket.send('hi')
    const data = await machine.next('tunnel-data')
    expect(data.tunnelId).toBe(opened.tunnelId)
    expect(Buffer.from(data.data, 'base64').toString('utf8')).toBe('hi')
    machine.send({ _tag: 'tunnel-data', tunnelId: opened.tunnelId, data: base64('yo') })
    expect(await phone.nextMessage()).toEqual({ text: 'yo', binary: false })
    machine.send({
      _tag: 'tunnel-close',
      tunnelId: opened.tunnelId,
      code: 4001,
      reason: 'unauthorized'
    })
    expect((await phone.closed()).code).toBe(4001)

    const second = openPhone(pushUrl)
    const secondOpened = await machine.next('tunnel-open')
    expect(secondOpened.tunnelId).not.toBe(opened.tunnelId)
    await second.opened
    second.socket.close(1000)
    // The first tunnel, ended by the machine, is not echoed back to it.
    const closed = await machine.next('tunnel-close')
    expect(closed.tunnelId).toBe(secondOpened.tunnelId)
  })

  it('closes an oversized phone tunnel without forwarding a frame that disconnects the machine', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken())
    const machine = await connectMachine(relay, credential)
    const phone = openPhone(wsUrl(relay, `/m/${credential.machineId}/push`))
    await machine.next('tunnel-open')
    await phone.opened
    phone.socket.send(Buffer.alloc(13 * 1024 * 1024), { binary: true })
    expect((await phone.closed()).code).toBe(1009)
    expect(machine.frames.filter((frame) => frame._tag === 'tunnel-data')).toHaveLength(0)
    expect(machine.socket.readyState).toBe(WebSocket.OPEN)
    expect(relay.online()).toEqual([credential.machineId])
  })

  it('refuses a tunnel to an unknown machine, to an offline one, and past the cap', async () => {
    const relay = await relayFor({ maxTunnels: 1 })
    const token = provider.mintAccessToken({ sub: 'subject-p' })
    const online = await claimed(relay, token, { ...RECORD, name: 'Online' })
    const offline = await claimed(relay, token, { ...RECORD, name: 'Offline' })
    const machine = await connectMachine(relay, online)

    expect(await upgradeStatus(wsUrl(relay, '/m/m_0000000000000000/push'))).toBe(404)
    expect(await upgradeStatus(wsUrl(relay, `/m/${offline.machineId}/push`))).toBe(503)
    const phone = openPhone(wsUrl(relay, `/m/${online.machineId}/push`))
    await machine.next('tunnel-open')
    await phone.opened
    expect(await upgradeStatus(wsUrl(relay, `/m/${online.machineId}/push`))).toBe(503)
    expect(machine.frames.filter((f) => f._tag === 'tunnel-open')).toHaveLength(1)
    expect(phone.socket.readyState).toBe(WebSocket.OPEN)
  })
})

describe('forget, health and stop', () => {
  it('forgets a connected machine for its owner and closes its socket with 4012', async () => {
    const relay = await relayFor()
    const token = provider.mintAccessToken({ sub: 'subject-q' })
    const credential = await claimed(relay, token)
    const machine = await connectMachine(relay, credential)
    const response = await forget(relay, token, credential.machineId)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect((await machine.closed()).code).toBe(4012)
    expect(await machinesOf(relay, token)).toEqual([])
    // The credential is gone with it.
    const again = await openControl(relay)
    again.send({ _tag: 'hello', ...credential, record: RECORD })
    expect((await again.closed()).code).toBe(4001)
  })

  it('says it is live and counts the machines known and online, to anyone', async () => {
    const relay = await relayFor()
    const health = async (): Promise<unknown> => {
      const response = await fetch(`${relay.url}/health`)
      expect(response.status).toBe(200)
      return response.json()
    }
    expect(await health()).toEqual({ status: 'live', machines: 0, online: 0 })
    const token = provider.mintAccessToken({ sub: 'subject-r' })
    const one = await claimed(relay, token)
    await claimed(relay, token)
    await connectMachine(relay, one)
    expect(await health()).toEqual({ status: 'live', machines: 2, online: 1 })
  })

  it('tells a connected machine it stops with 4010, and a second close does nothing', async () => {
    const relay = await relayFor()
    const credential = await claimed(relay, provider.mintAccessToken({ sub: 'subject-s' }))
    const machine = await connectMachine(relay, credential)
    await expect(relay.close()).resolves.toBeUndefined()
    expect((await machine.closed()).code).toBe(4010)
    await expect(relay.close()).resolves.toBeUndefined()
    await expect(fetch(`${relay.url}/health`)).rejects.toThrow()
  })
})

it('loads mobile-relay/isolated-owners through authenticated claims and verifies ownership over HTTP', async () => {
  const relay = await relayFor()
  const catalog = relayFixtureCatalog((subject, name) =>
    claimed(relay, provider.mintAccessToken({ sub: subject }), { ...RECORD, name })
  )
  const fixtures = await Effect.runPromise(catalog.prepare('mobile-relay/isolated-owners', {}))
  const report = await Effect.runPromise(
    run({
      fixtures,
      enabled: true,
      // Claims update the directory synchronously before the HTTP response.
      ready: () => Effect.void
    }).pipe(Effect.provide(buses.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
  const rows = Object.values(report.values) as Array<{ subject: string; machineId: string }>
  try {
    expect(report.completed).toEqual(['relay/first-owner', 'relay/second-owner'])
    for (const row of rows) {
      const token = provider.mintAccessToken({ sub: row.subject })
      const machines = await machinesOf(relay, token)
      expect(machines.map((m) => m.id)).toEqual([row.machineId])
      const other = rows.find((candidate) => candidate !== row)!
      expect((await forget(relay, token, other.machineId)).status).toBe(404)
    }
    console.log(
      JSON.stringify({
        scenario: 'mobile-relay/isolated-owners',
        runId: report.runId,
        completed: report.completed,
        machineIds: rows.map((row) => row.machineId)
      })
    )
  } finally {
    for (const row of rows) {
      const token = provider.mintAccessToken({ sub: row.subject })
      expect((await forget(relay, token, row.machineId)).status).toBe(200)
      expect(await machinesOf(relay, token)).toEqual([])
    }
  }
})
