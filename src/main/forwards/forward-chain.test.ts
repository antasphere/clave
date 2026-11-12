/**
 * The whole forward chain (PRDCT-4473): a `LoopbackForwards` listener in
 * front of the real embedded server in front of a plain target page. The
 * window header is sent by hand, read from `secrets()`, as the window gate
 * would add it.
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startEmbedded, type EmbeddedServer } from '../../../packages/server/src/embedded'
import { FakeSource } from '../../../packages/server/src/test-support'
import { ForwardRegistry } from '../../../packages/server/src/forward/registry'
import {
  BIG_BYTES,
  ask,
  bigBody,
  firstTick,
  sha256,
  startTestTarget,
  type TestTarget
} from '../../../packages/server/src/forward/test-target'
import { LoopbackForwards, WINDOW_HEADER, type OpenedForward } from './loopback-forwards'

let server: EmbeddedServer
let target: TestTarget
let registry: ForwardRegistry
let forwards: LoopbackForwards
let opened: OpenedForward
let lease: string

const windowHeaders = (forward: OpenedForward = opened): Record<string, string> => ({
  [WINDOW_HEADER]: forwards.secrets().get(forward.port)!
})
const echoOf = (body: Buffer): { url: string; headers: Record<string, string> } =>
  JSON.parse(body.toString()) as { url: string; headers: Record<string, string> }

beforeAll(async () => {
  target = await startTestTarget()
  registry = new ForwardRegistry()
  lease = registry.register(target.port).lease
  server = await startEmbedded({ ports: { sessions: new FakeSource(), forwards: registry } })
  forwards = new LoopbackForwards()
  opened = await forwards.open({
    key: `s1:${lease}`,
    lease,
    upstream: async () => ({ url: server.url, token: server.token })
  })
})
afterAll(async () => {
  await forwards.closeAll()
  await server.stop()
  await target.stop()
})

type Handshake = { ws: WebSocket } | { status: number }
const connect = (port: number, path: string, headers: Record<string, string>): Promise<Handshake> =>
  new Promise<Handshake>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    ws.once('open', () => resolve({ ws }))
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 })
      res.resume()
      ws.terminate()
    })
    ws.once('error', reject)
  })
const socketOf = (handshake: Handshake): WebSocket => {
  if (!('ws' in handshake)) throw new Error(`refused with ${handshake.status}`)
  return handshake.ws
}
const nextMessage = (ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> =>
  new Promise<{ data: Buffer; isBinary: boolean }>((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary }))
  )
const closeOf = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
const navigation = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

describe('the forward chain', () => {
  it("refuses a Host that is not the listener's own (403)", async () => {
    const answer = await ask(opened.port, '/echo', {
      host: 'rebound.example:80',
      headers: windowHeaders()
    })
    expect(answer.status).toBe(403)
    const otherPort = await ask(opened.port, '/echo', {
      host: `127.0.0.1:${opened.port + 1}`,
      headers: windowHeaders()
    })
    expect(otherPort.status).toBe(403)
    expect(
      (
        await ask(opened.port, '/echo', {
          host: `localhost:${opened.port}`,
          headers: windowHeaders()
        })
      ).status
    ).toBe(200)
  })

  it('refuses a request without the window header, or with a wrong one (403)', async () => {
    const before = target.received.length
    expect((await ask(opened.port, '/echo')).status).toBe(403)
    expect(
      (await ask(opened.port, '/echo', { headers: { [WINDOW_HEADER]: 'guess' } })).status
    ).toBe(403)
    expect(target.received.length).toBe(before)
  })

  it('never shows the target the token, the window secret or a cookie, nor the page the token', async () => {
    const answer = await ask(opened.port, '/echo', {
      headers: { ...windowHeaders(), cookie: 'mine=1', authorization: 'Bearer page-made' }
    })
    expect(answer.status).toBe(200)
    const seen = echoOf(answer.body).headers
    expect(seen['authorization']).toBeUndefined()
    expect(seen[WINDOW_HEADER]).toBeUndefined()
    expect(seen['cookie']).toBeUndefined()
    expect(JSON.stringify(answer.headers)).not.toContain(server.token)
    expect(answer.body.toString()).not.toContain(server.token)
  })

  it("gives the target its own origin for the page's, a stranger's as it is, and believes no page-made report", async () => {
    const at = async (headers: Record<string, string>): Promise<string | undefined> =>
      echoOf(
        (await ask(opened.port, '/echo', { headers: { ...windowHeaders(), ...headers } })).body
      ).headers['origin']
    expect(await at({ origin: `http://127.0.0.1:${opened.port}` })).toBe(
      `http://127.0.0.1:${target.port}`
    )
    expect(await at({ origin: `http://localhost:${opened.port}` })).toBe(
      `http://127.0.0.1:${target.port}`
    )
    expect(await at({ origin: 'http://evil.example' })).toBe('http://evil.example')
    expect(await at({ origin: 'null' })).toBe('null')
    // A page that names itself `self` is not believed: with a foreign Origin
    // the stranger's is what the target sees, and with none, none.
    expect(await at({ origin: 'http://evil.example', 'x-clave-forward-origin': 'self' })).toBe(
      'http://evil.example'
    )
    expect(await at({ 'x-clave-forward-origin': 'self' })).toBeUndefined()
  })

  it("stops a write and a socket from another origin at the Mac's port (403), and lets the page's own through", async () => {
    const own = `http://127.0.0.1:${opened.port}`
    const before = target.received.length
    for (const origin of ['http://evil.example', `http://127.0.0.1:${opened.port + 1}`, 'null'])
      expect(
        (
          await ask(opened.port, '/echo', {
            method: 'POST',
            headers: { ...windowHeaders(), origin },
            body: Buffer.from('x')
          })
        ).status
      ).toBe(403)
    expect(target.received.length).toBe(before)
    const written = await ask(opened.port, '/echo', {
      method: 'POST',
      headers: { ...windowHeaders(), origin: own },
      body: Buffer.from('x')
    })
    expect(written.status).toBe(200)
    expect(echoOf(written.body).headers['origin']).toBe(`http://127.0.0.1:${target.port}`)

    const foreign = await connect(opened.port, '/ws', {
      ...windowHeaders(),
      origin: 'http://evil.example'
    })
    expect(foreign).toEqual({ status: 403 })
    const mine = socketOf(await connect(opened.port, '/ws', { ...windowHeaders(), origin: own }))
    const echoed = nextMessage(mine)
    mine.send('same origin')
    expect((await echoed).data.toString()).toBe('same origin')
    mine.close()
  })

  it('answers 400 to a request line with an absolute URL', async () => {
    const answer = await ask(opened.port, `http://127.0.0.1:${opened.port}/echo`, {
      headers: windowHeaders()
    })
    expect(answer.status).toBe(400)
  })

  it('carries an event stream unbuffered and 5 MiB both ways across both hops', async () => {
    const tick = await firstTick(opened.port, '/sse', windowHeaders())
    expect(tick.ms).toBeLessThan(1000)
    const big = bigBody()
    const down = await ask(opened.port, '/big', { headers: windowHeaders() })
    expect(down.body.length).toBe(BIG_BYTES)
    expect(sha256(down.body)).toBe(sha256(big))
    const up = await ask(opened.port, '/upload', {
      method: 'POST',
      headers: { ...windowHeaders(), 'content-type': 'application/octet-stream' },
      body: big
    })
    expect(JSON.parse(up.body.toString())).toEqual({ bytes: BIG_BYTES, sha256: sha256(big) })
  })

  it('relays a WebSocket across both hops, text and binary, and its close code', async () => {
    const ws = socketOf(await connect(opened.port, '/ws', windowHeaders()))
    const text = nextMessage(ws)
    ws.send('across')
    const got = await text
    expect(got.isBinary).toBe(false)
    expect(got.data.toString()).toBe('across')
    const binary = nextMessage(ws)
    ws.send(Buffer.from([9, 8, 7, 0]))
    const bytes = await binary
    expect(bytes.isBinary).toBe(true)
    expect([...bytes.data]).toEqual([9, 8, 7, 0])
    const done = closeOf(ws)
    ws.close(1000)
    await done
    const closing = socketOf(await connect(opened.port, '/ws-close', windowHeaders()))
    expect(await closeOf(closing)).toEqual({ code: 4321, reason: 'bye' })
    expect(await connect(opened.port, '/ws', {})).toEqual({ status: 403 })
  })

  it('upstream is asked at each request: a token changed between two requests is used at once', async () => {
    let token = 'not-the-token'
    const changing = await forwards.open({
      key: `s-change:${lease}`,
      lease,
      upstream: async () => ({ url: server.url, token })
    })
    const first = await ask(changing.port, '/echo', { headers: windowHeaders(changing) })
    expect(first.status).toBe(502)
    token = server.token
    const second = await ask(changing.port, '/echo', { headers: windowHeaders(changing) })
    expect(second.status).toBe(200)
    changing.release()
  })

  it('shares one port between two opens of one key, and closes it with the last', async () => {
    let changes = 0
    const off = forwards.onChange(() => (changes += 1))
    const input = {
      key: `s-shared:${lease}`,
      lease,
      upstream: async () => ({ url: server.url, token: server.token })
    }
    const a = await forwards.open(input)
    const b = await forwards.open(input)
    expect(b.port).toBe(a.port)
    const headers = windowHeaders(a)
    a.release()
    a.release()
    expect((await ask(b.port, '/echo', { headers })).status).toBe(200)
    const before = changes
    b.release()
    expect(changes).toBeGreaterThan(before)
    expect(forwards.secrets().has(b.port)).toBe(false)
    await expect(ask(b.port, '/echo', { headers })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    off()
  })
})

describe('the forward chain when the server cannot show the page', () => {
  it("ends the page's answer when the server breaks off half-way through a stream", async () => {
    const own = new ForwardRegistry()
    const ownLease = own.register(target.port).lease
    const ownServer = await startEmbedded({ ports: { sessions: new FakeSource(), forwards: own } })
    const ownForwards = new LoopbackForwards()
    const forward = await ownForwards.open({
      key: `mid:${ownLease}`,
      lease: ownLease,
      upstream: async () => ({ url: ownServer.url, token: ownServer.token })
    })
    try {
      const ended = await new Promise<{ ticks: number; ms: number }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: forward.port,
            path: '/sse',
            headers: { [WINDOW_HEADER]: ownForwards.secrets().get(forward.port)! },
            agent: false
          },
          (res) => {
            let ticks = 0
            let stoppedAt = 0
            res.on('data', (chunk: Buffer) => {
              ticks += chunk.toString().split('event: tick').length - 1
              // The stream is flowing: the server goes away under it.
              if (ticks >= 2 && stoppedAt === 0) {
                stoppedAt = Date.now()
                void ownServer.stop()
              }
            })
            const done = (): void => resolve({ ticks, ms: Date.now() - stoppedAt })
            res.on('end', done)
            res.on('close', done)
            res.on('error', done)
          }
        )
        req.on('error', reject)
        setTimeout(() => reject(new Error('the answer was left open')), 4000).unref()
        req.end()
      })
      expect(ended.ticks).toBeGreaterThanOrEqual(2)
      expect(ended.ms).toBeLessThan(3000)
    } finally {
      await ownForwards.closeAll()
      await ownServer.stop()
    }
  })

  it('a stopped server: the away page to a navigation (503), a plain 502 otherwise', async () => {
    const own = new ForwardRegistry()
    const ownLease = own.register(target.port).lease
    const stopped = await startEmbedded({ ports: { sessions: new FakeSource(), forwards: own } })
    const forward = await forwards.open({
      key: `s-stop:${ownLease}`,
      lease: ownLease,
      upstream: async () => ({ url: stopped.url, token: stopped.token })
    })
    expect((await ask(forward.port, '/echo', { headers: windowHeaders(forward) })).status).toBe(200)
    await stopped.stop()
    const page = await ask(forward.port, '/', {
      headers: { ...windowHeaders(forward), ...navigation }
    })
    expect(page.status).toBe(503)
    expect(page.body.toString()).toContain('This page is on a server Clave cannot reach right now.')
    expect(page.body.toString()).toContain('http-equiv="refresh"')
    const fetchOne = await ask(forward.port, '/data.json', { headers: windowHeaders(forward) })
    expect(fetchOne.status).toBe(502)
    expect(fetchOne.headers['content-type']).toContain('text/plain')
    forward.release()
  })

  it('a refused token: the refused page, with no refresh', async () => {
    const forward = await forwards.open({
      key: `s-refused:${lease}`,
      lease,
      upstream: async () => ({ url: server.url, token: 'a-token-the-server-never-gave' })
    })
    const page = await ask(forward.port, '/', {
      headers: { ...windowHeaders(forward), ...navigation }
    })
    expect(page.status).toBe(503)
    expect(page.body.toString()).toContain('The server refused this Mac&#39;s saved token.')
    expect(page.body.toString()).not.toContain('refresh')
    forward.release()
  })

  it('a lease released on the server: 503 and the stopped-showing page', async () => {
    const leased = registry.register(target.port)
    const forward = await forwards.open({
      key: `s-released:${leased.lease}`,
      lease: leased.lease,
      upstream: async () => ({ url: server.url, token: server.token })
    })
    expect((await ask(forward.port, '/echo', { headers: windowHeaders(forward) })).status).toBe(200)
    leased.release()
    const page = await ask(forward.port, '/', {
      headers: { ...windowHeaders(forward), ...navigation }
    })
    expect(page.status).toBe(503)
    expect(page.body.toString()).toContain('The server stopped showing this page.')
    // The target's own 404 is not an away: it passes untouched.
    const live = await forwards.open({
      key: `s-live:${lease}`,
      lease,
      upstream: async () => ({ url: server.url, token: server.token })
    })
    const missing = await ask(live.port, '/missing', {
      headers: { ...windowHeaders(live), ...navigation }
    })
    expect(missing.status).toBe(404)
    expect(missing.body.toString()).toBe('the target has no such thing')
    live.release()
    forward.release()
  })
})
