/**
 * The relay client (the machine's end of the road) against a real relay, a
 * local OIDC provider standing in for the hub (tests/e2e/fixtures/oidc-provider.mjs)
 * and a local listener standing in for the server's own: a node:http server
 * that records what it receives and a ws server on `/push` that echoes.
 * Everything listens on 127.0.0.1, port 0.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer, type ClientOptions, type RawData } from 'ws'
import type { MachineRecord, MachineView } from '@clave/contract/relay'
import {
  startOidcProvider,
  type OidcProvider
} from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { sleep } from '../test-support'
import { startRelay, type Relay, type RelayOptions } from './relay'
import {
  startRelayClient,
  type RelayClient,
  type RelayClientOptions,
  type RelayCredential,
  type RelayCredentialStore
} from './client'

vi.setConfig({ testTimeout: 20_000 })

/** The provider's default user. */
const OWNER = 'user-7f3a'
const RECORD: MachineRecord = { name: 'Test Mac', platform: 'macos', version: '9.9.9', direct: [] }

let provider: OidcProvider
const clients: RelayClient[] = []
const relays: Relay[] = []
const locals: LocalListener[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()))
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  await Promise.all(locals.splice(0).map((local) => local.close()))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Closed {
  readonly code: number
  readonly reason: string
}

const textOf = (data: RawData): string =>
  (Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data)
  ).toString('utf8')

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

async function machinesOf(relay: Relay, token: string): Promise<MachineView[]> {
  const response = await fetch(`${relay.url}/machines`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { machines: MachineView[] }).machines
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

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${what}: not within ${timeoutMs} ms`)
    await sleep(10)
  }
}

interface SeenRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

/** The server's own listener, stood in: every request recorded, then
 *  answered by `answer`; `/push` a ws echo (`echo:` + each text message)
 *  that closes a socket with 4001 when it receives 'bye'. */
interface LocalListener {
  readonly url: string
  readonly requests: SeenRequest[]
  /** The push sockets it accepted, in order, with how each closed. */
  readonly pushes: Array<{ readonly socket: WebSocket; readonly closed: Promise<Closed> }>
  answer: (seen: SeenRequest, res: ServerResponse) => void
  close(): Promise<void>
}

async function startLocal(): Promise<LocalListener> {
  const requests: SeenRequest[] = []
  const pushes: LocalListener['pushes'] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const seen: SeenRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks)
      }
      requests.push(seen)
      local.answer(seen, res)
    })
  })
  const wss = new WebSocketServer({ server, path: '/push' })
  wss.on('connection', (socket) => {
    const closed = new Promise<Closed>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    pushes.push({ socket, closed })
    socket.on('message', (data) => {
      const text = textOf(data)
      if (text === 'bye') socket.close(4001, 'unauthorized')
      else socket.send(`echo:${text}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const local: LocalListener = {
    url: `http://127.0.0.1:${port}`,
    requests,
    pushes,
    answer: (_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
    close: async () => {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  locals.push(local)
  return local
}

/** The credential store, in memory, counting what the client asks of it. */
class MemoryStore implements RelayCredentialStore {
  current: RelayCredential | null = null
  readonly saved: RelayCredential[] = []
  clears = 0
  load(): RelayCredential | null {
    return this.current
  }
  save(credential: RelayCredential): void {
    this.saved.push(credential)
    this.current = credential
  }
  clear(): void {
    this.clears++
    this.current = null
  }
}

interface Harness {
  readonly client: RelayClient
  readonly store: MemoryStore
  readonly logs: string[]
  /** Every access token handed to the client. */
  readonly tokens: string[]
  /** When each claim went to the relay (epoch milliseconds). */
  readonly claims: number[]
}

/** A client for the provider's default user, with short waits. */
function startClient(
  options: Partial<RelayClientOptions> & Pick<RelayClientOptions, 'address' | 'local'>
): Harness {
  const store = new MemoryStore()
  const logs: string[] = []
  const tokens: string[] = []
  const claims: number[] = []
  const client = startRelayClient({
    owner: () => OWNER,
    accessToken: async () => {
      const token = provider.mintAccessToken()
      tokens.push(token)
      return token
    },
    record: () => RECORD,
    credentials: store,
    log: (line) => logs.push(line),
    fetch: (input, init) => {
      if (String(input).endsWith('/machines/claim')) claims.push(Date.now())
      return globalThis.fetch(input, init)
    },
    backoff: { baseMs: 50, maxMs: 200 },
    idleRetryMs: 50,
    ...options
  })
  clients.push(client)
  return { client, store, logs, tokens, claims }
}

/** A relay, a local listener and a client connected between them. */
async function connectedClient(
  localUrl?: string
): Promise<{ relay: Relay; local: LocalListener; harness: Harness; machineId: string }> {
  const relay = await relayFor()
  const local = await startLocal()
  const harness = startClient({ address: () => relay.url, local: { url: localUrl ?? local.url } })
  await until(() => harness.client.status().state === 'connected', 3_000, 'connected')
  const machineId = harness.client.status().machineId ?? ''
  expect(machineId).toMatch(/^m_/)
  return { relay, local, harness, machineId }
}

/** A phone's push socket through the relay. */
interface Phone {
  readonly socket: WebSocket
  readonly opened: Promise<void>
  closed(timeoutMs?: number): Promise<Closed>
  nextText(timeoutMs?: number): Promise<string>
}

function openPhone(url: string): Phone {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const unread: string[] = []
  const waiting: Array<(text: string) => void> = []
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const text = textOf(data)
    const waiter = waiting.shift()
    if (waiter) waiter(text)
    else unread.push(text)
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
    nextText: (timeoutMs = 3_000) => {
      const queued = unread.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No message within ${timeoutMs} ms`)),
          timeoutMs
        )
        waiting.push((text) => {
          clearTimeout(timer)
          resolve(text)
        })
      })
    }
  }
}

const pushUrlOf = (relay: Relay, machineId: string): string =>
  `${relay.url.replace(/^http/, 'ws')}/m/${machineId}/push`

describe('the claim', () => {
  it('claims a credential once, keeps it in the store and connects under it', async () => {
    const relay = await relayFor()
    const local = await startLocal()
    const harness = startClient({ address: () => relay.url, local: { url: local.url } })
    const token = provider.mintAccessToken()
    const rows = await eventually(
      () => machinesOf(relay, token),
      (list) => list.some((m) => m.online),
      2_000
    )
    expect(harness.store.saved).toHaveLength(1)
    const saved = harness.store.saved[0]
    expect(saved.relay).toBe(relay.url)
    expect(saved.owner).toBe('user-7f3a')
    expect(saved.machineId).toMatch(/^m_/)
    expect(saved.machineSecret).toMatch(/^cms_/)
    expect(rows).toEqual([
      {
        id: saved.machineId,
        name: 'Test Mac',
        platform: 'macos',
        version: '9.9.9',
        online: true,
        lastSeen: expect.any(Number),
        direct: []
      }
    ])
    await until(() => harness.client.status().state === 'connected', 2_000, 'connected')
    expect(harness.client.status()).toMatchObject({
      state: 'connected',
      relay: relay.url,
      machineId: saved.machineId
    })
    expect(
      harness.logs.some((line) => line.includes('connected') && line.includes(saved.machineId))
    ).toBe(true)
    expect(harness.tokens.length).toBeGreaterThan(0)
    for (const line of harness.logs) {
      expect(line).not.toContain(saved.machineSecret)
      for (const accessToken of harness.tokens) expect(line).not.toContain(accessToken)
    }
  })

  it('waits while no address is configured, says so once, and claims once one appears', async () => {
    const relay = await relayFor()
    const local = await startLocal()
    let address: string | null = null
    const harness = startClient({ address: () => address, local: { url: local.url } })
    await sleep(300)
    expect(harness.client.status().state).toBe('unconfigured')
    // Soft, so the rest of the story is still checked when this one fails.
    expect.soft(harness.logs.filter((line) => /no relay address/i.test(line))).toHaveLength(1)
    expect(harness.claims).toEqual([])
    expect(harness.tokens).toEqual([])
    expect(harness.store.saved).toEqual([])
    const token = provider.mintAccessToken()
    expect(await machinesOf(relay, token)).toEqual([])

    address = relay.url
    await until(() => harness.client.status().state === 'connected', 3_000, 'connected')
    expect(harness.store.saved).toHaveLength(1)
    expect(await machinesOf(relay, token)).toEqual([
      expect.objectContaining({ id: harness.store.saved[0].machineId, online: true })
    ])
  })

  it('waits while nobody is signed in and claims nothing', async () => {
    const relay = await relayFor()
    const local = await startLocal()
    const harness = startClient({
      address: () => relay.url,
      owner: () => null,
      local: { url: local.url }
    })
    await until(() => harness.client.status().state === 'signed-out', 1_000, 'signed out')
    await sleep(200)
    expect(harness.client.status().state).toBe('signed-out')
    expect(harness.claims).toEqual([])
    expect(harness.tokens).toEqual([])
    expect(harness.store.saved).toEqual([])
    expect(await machinesOf(relay, provider.mintAccessToken())).toEqual([])
  })

  it('keeps trying after a refused claim and saves nothing', async () => {
    const relay = await relayFor()
    const local = await startLocal()
    const harness = startClient({
      address: () => relay.url,
      accessToken: async () => 'at-bogus',
      local: { url: local.url },
      backoff: { baseMs: 50 }
    })
    await until(() => harness.claims.length >= 2, 3_000, 'a second claim')
    // The first wait is between half the base and the base: 25 to 50 ms.
    expect(harness.claims[1] - harness.claims[0]).toBeGreaterThanOrEqual(20)
    const waiting = await eventually(
      async () => harness.client.status(),
      (status) => status.state === 'waiting',
      1_000
    )
    expect(waiting.state).toBe('waiting')
    expect(waiting.lastFailure).toMatch(/refused/)
    expect(harness.store.saved).toEqual([])
    expect(await machinesOf(relay, provider.mintAccessToken())).toEqual([])
  })
})

describe('the requests it performs', () => {
  it('performs a forwarded request against the local listener, the origin left out', async () => {
    const { relay, local, machineId } = await connectedClient()
    local.answer = (_seen, res) => {
      res.writeHead(201, { 'x-local': 'yes', 'content-type': 'text/plain' })
      res.end('hello')
    }
    const response = await fetch(`${relay.url}/m/${machineId}/hello?x=1`, {
      headers: { authorization: 'Bearer t', origin: 'http://evil.example' }
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-local')).toBe('yes')
    expect(await response.text()).toBe('hello')
    expect(local.requests).toHaveLength(1)
    const seen = local.requests[0]
    expect(seen.method).toBe('GET')
    expect(seen.url).toBe('/hello?x=1')
    expect(seen.headers.authorization).toBe('Bearer t')
    expect(seen.headers).not.toHaveProperty('origin')
    expect(seen.headers.host).not.toBe(new URL(relay.url).host)
  })

  it('streams a long answer to the phone byte for byte, with a length or chunked', async () => {
    const { relay, local, machineId } = await connectedClient()
    const bytes = randomBytes(200 * 1024)
    local.answer = (_seen, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length
      })
      res.end(bytes)
    }
    const known = await fetch(`${relay.url}/m/${machineId}/files/known`)
    expect(known.status).toBe(200)
    expect(Buffer.from(await known.arrayBuffer()).equals(bytes)).toBe(true)

    local.answer = (_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      let at = 0
      const piece = (): void => {
        if (at >= bytes.length) {
          res.end()
          return
        }
        res.write(bytes.subarray(at, at + 30_000))
        at += 30_000
        setImmediate(piece)
      }
      piece()
    }
    const chunked = await fetch(`${relay.url}/m/${machineId}/files/chunked`)
    expect(chunked.status).toBe(200)
    expect(Buffer.from(await chunked.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('hands a request body to the local listener byte for byte', async () => {
    const { relay, local, machineId } = await connectedClient()
    local.answer = (_seen, res) => {
      res.writeHead(204)
      res.end()
    }
    const body = randomBytes(100 * 1024)
    const response = await fetch(`${relay.url}/m/${machineId}/files/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body
    })
    expect(response.status).toBe(204)
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0].method).toBe('POST')
    expect(local.requests[0].body.length).toBe(100 * 1024)
    expect(local.requests[0].body.equals(body)).toBe(true)
  })

  it('answers 502 when the local listener is down', async () => {
    const { relay, machineId } = await connectedClient(`http://127.0.0.1:${await freePort()}`)
    const response = await fetch(`${relay.url}/m/${machineId}/sessions`)
    expect(response.status).toBe(502)
  })
})

describe('the tunnel', () => {
  it('pipes a phone’s push socket to a socket of its own on the local listener', async () => {
    const { relay, local, machineId } = await connectedClient()
    const phone = openPhone(pushUrlOf(relay, machineId))
    await phone.opened
    phone.socket.send('hi')
    expect(await phone.nextText()).toBe('echo:hi')
    phone.socket.send('bye')
    expect((await phone.closed()).code).toBe(4001)

    const second = openPhone(pushUrlOf(relay, machineId))
    await second.opened
    second.socket.send('again')
    expect(await second.nextText()).toBe('echo:again')
    expect(local.pushes).toHaveLength(2)
    second.socket.close()
    await expect(
      within(local.pushes[1].closed, 3_000, 'The local push socket closing')
    ).resolves.toEqual(expect.objectContaining({ code: expect.any(Number) }))
  })
})

describe('reconnecting and stopping', () => {
  it('reconnects under the same credential when the relay comes back on its port', async () => {
    const dataDir = tempDir()
    const relay = await relayFor({ dataDir })
    const local = await startLocal()
    const harness = startClient({ address: () => relay.url, local: { url: local.url } })
    await until(() => harness.client.status().state === 'connected', 3_000, 'connected')
    const machineId = harness.client.status().machineId
    await relay.close()
    await until(() => harness.client.status().state !== 'connected', 2_000, 'disconnected')

    const again = await relayFor({ dataDir, port: relay.port })
    expect(again.url).toBe(relay.url)
    const token = provider.mintAccessToken()
    const rows = await eventually(
      () => machinesOf(again, token),
      (list) => list.some((m) => m.online),
      3_000
    )
    expect(rows).toEqual([expect.objectContaining({ id: machineId, online: true })])
    expect(harness.store.saved).toHaveLength(1)
    expect(harness.store.clears).toBe(0)
    expect(harness.claims).toHaveLength(1)
  })

  it('claims anew when a relay that lost its store refuses the credential', async () => {
    const closeCodes: number[] = []
    /** ws's own socket, the close codes it received written down. */
    class RecordingWebSocket extends WebSocket {
      constructor(address: string, options?: ClientOptions) {
        super(address, options)
        this.on('close', (code: number) => closeCodes.push(code))
      }
    }
    const relay = await relayFor()
    const local = await startLocal()
    const harness = startClient({
      address: () => relay.url,
      local: { url: local.url },
      // ws also declares `new WebSocket(null)`, which a client socket never takes.
      WebSocket: RecordingWebSocket as unknown as typeof WebSocket
    })
    await until(() => harness.client.status().state === 'connected', 3_000, 'connected')
    const first = harness.store.saved[0]
    await relay.close()

    const again = await relayFor({ port: relay.port })
    const token = provider.mintAccessToken()
    const rows = await eventually(
      () => machinesOf(again, token),
      (list) => list.some((m) => m.online),
      3_000
    )
    expect(closeCodes).toContain(4001)
    expect(harness.store.clears).toBe(1)
    expect(harness.store.saved).toHaveLength(2)
    const second = harness.store.saved[1]
    expect(second.machineId).not.toBe(first.machineId)
    expect(rows).toEqual([expect.objectContaining({ id: second.machineId, online: true })])
    await until(() => harness.client.status().state === 'connected', 2_000, 'connected again')
    expect(harness.client.status().machineId).toBe(second.machineId)
  })

  it('stops, and the relay lists the machine offline', async () => {
    const { relay, harness, machineId } = await connectedClient()
    await expect(harness.client.stop()).resolves.toBeUndefined()
    expect(harness.client.status().state).toBe('stopped')
    const token = provider.mintAccessToken()
    const rows = await eventually(
      () => machinesOf(relay, token),
      (list) => list[0]?.online === false,
      1_000
    )
    expect(rows).toEqual([expect.objectContaining({ id: machineId, online: false })])
    expect(relay.online()).toEqual([])
  })
})
