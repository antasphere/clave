import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import { ForwardRegistry } from './registry'
import {
  BIG_BYTES,
  ask,
  bigBody,
  firstTick,
  sha256,
  startTestTarget,
  type TestTarget
} from './test-target'

let server: EmbeddedServer
let target: TestTarget
let registry: ForwardRegistry
let lease: string
let port: number

const auth = (): Record<string, string> => ({ authorization: `Bearer ${server.token}` })
const echoOf = (body: Buffer): { method: string; url: string; headers: Record<string, string> } =>
  JSON.parse(body.toString()) as { method: string; url: string; headers: Record<string, string> }

beforeAll(async () => {
  target = await startTestTarget()
  registry = new ForwardRegistry()
  lease = registry.register(target.port).lease
  server = await startEmbedded({ ports: { sessions: new FakeSource(), forwards: registry } })
  port = Number(new URL(server.url).port)
})
afterAll(async () => {
  await server.stop()
  await target.stop()
})

/** A port nothing listens on. */
const closedPort = async (): Promise<number> => {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const free = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return free
}

type Opened = { ws: WebSocket } | { status: number }
const connect = (
  path: string,
  headers: Record<string, string>,
  protocols: string[] = []
): Promise<Opened> =>
  new Promise<Opened>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers })
    ws.once('open', () => resolve({ ws }))
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 })
      res.resume()
      ws.terminate()
    })
    ws.once('error', reject)
  })
const opened = (value: Opened): WebSocket => {
  if (!('ws' in value)) throw new Error(`the handshake was refused with ${value.status}`)
  return value.ws
}
const nextMessage = (ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> =>
  new Promise<{ data: Buffer; isBinary: boolean }>((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary }))
  )
const closeOf = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )

describe('the forward route', () => {
  it('answers 401 without the token, and the target receives nothing', async () => {
    const before = target.received.length
    const answer = await ask(port, `/forward/${lease}/echo`)
    expect(answer.status).toBe(401)
    const wrong = await ask(port, `/forward/${lease}/echo`, {
      headers: { authorization: 'Bearer nope' }
    })
    expect(wrong.status).toBe(401)
    expect(target.received.length).toBe(before)
  })

  it('answers 404 refused for an unknown lease, a malformed one and the bare prefix', async () => {
    for (const path of [
      `/forward/${'0'.repeat(32)}/echo`,
      `/forward/${lease.slice(0, 31)}/echo`,
      `/forward/${lease.toUpperCase()}/echo`,
      `/forward/${lease}x/echo`,
      '/forward',
      '/forward/',
      '/forward?x=1'
    ]) {
      const answer = await ask(port, path, { headers: auth() })
      expect(answer.status, path).toBe(404)
      expect(answer.headers['x-clave-forward'], path).toBe('refused')
      expect(JSON.parse(answer.body.toString()), path).toEqual({
        error: 'UnknownForward',
        message: 'This server forwards no such page.'
      })
    }
  })

  it('gives the target its own Host and none of the credentials or the hop header', async () => {
    const answer = await ask(port, `/forward/${lease}/echo`, {
      headers: { ...auth(), cookie: 'session=secret', 'x-clave-forward-origin': 'self' }
    })
    expect(answer.status).toBe(200)
    const echo = echoOf(answer.body)
    expect(echo.headers['host']).toBe(`127.0.0.1:${target.port}`)
    expect(echo.headers['authorization']).toBeUndefined()
    expect(echo.headers['cookie']).toBeUndefined()
    expect(echo.headers['x-clave-forward-origin']).toBeUndefined()
  })

  it('gives the target its own Origin for self, a literal as it is, and none for none', async () => {
    const self = echoOf(
      (
        await ask(port, `/forward/${lease}/echo`, {
          headers: { ...auth(), 'x-clave-forward-origin': 'self', origin: 'http://evil.example' }
        })
      ).body
    )
    expect(self.headers['origin']).toBe(`http://127.0.0.1:${target.port}`)
    const literal = echoOf(
      (
        await ask(port, `/forward/${lease}/echo`, {
          headers: { ...auth(), 'x-clave-forward-origin': 'http://elsewhere.example' }
        })
      ).body
    )
    expect(literal.headers['origin']).toBe('http://elsewhere.example')
    const none = echoOf(
      (
        await ask(port, `/forward/${lease}/echo`, {
          headers: { ...auth(), origin: 'http://127.0.0.1:1' }
        })
      ).body
    )
    expect(none.headers['origin']).toBeUndefined()
  })

  it('carries the raw path verbatim, and never into the API', async () => {
    const raw = await ask(port, `/forward/${lease}/a/../b%2F?x=1&y=%20`, { headers: auth() })
    expect(echoOf(raw.body).url).toBe('/a/../b%2F?x=1&y=%20')
    const climb = await ask(port, `/forward/${lease}/../../sessions`, { headers: auth() })
    expect(climb.status).toBe(200)
    expect(climb.headers['x-target']).toBe('yes')
    expect(echoOf(climb.body).url).toBe('/../../sessions')
    const query = await ask(port, `/forward/${lease}?x=1`, { headers: auth() })
    expect(echoOf(query.body).url).toBe('/?x=1')
    const bare = await ask(port, `/forward/${lease}`, { headers: auth() })
    expect(echoOf(bare.body).url).toBe('/')
  })

  it('relays an event stream unbuffered: the first tick within 1 s, the stream still open', async () => {
    const tick = await firstTick(port, `/forward/${lease}/sse`, auth())
    expect(tick.ms).toBeLessThan(1000)
    expect(tick.contentType).toBe('text/event-stream')
  })

  it('carries 5 MiB down and 5 MiB up whole', async () => {
    const big = bigBody()
    const down = await ask(port, `/forward/${lease}/big`, { headers: auth() })
    expect(down.status).toBe(200)
    expect(down.body.length).toBe(BIG_BYTES)
    expect(sha256(down.body)).toBe(sha256(big))
    const up = await ask(port, `/forward/${lease}/upload`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      body: big
    })
    expect(up.status).toBe(200)
    expect(JSON.parse(up.body.toString())).toEqual({ bytes: BIG_BYTES, sha256: sha256(big) })
  })

  it('lets go of the target within 1 s when the caller aborts mid-stream', async () => {
    const closed = target.closeOf('/sse')
    await firstTick(port, `/forward/${lease}/sse`, auth())
    const aborted = Date.now()
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('still open')), 1000))
    ])
    expect(Date.now() - aborted).toBeLessThan(1000)
  })

  it('answers 502 refused when the target is gone', async () => {
    const gone = registry.register(await closedPort())
    const answer = await ask(port, `/forward/${gone.lease}/echo`, { headers: auth() })
    gone.release()
    expect(answer.status).toBe(502)
    expect(answer.headers['x-clave-forward']).toBe('refused')
    expect(JSON.parse(answer.body.toString())).toMatchObject({ error: 'ForwardTargetGone' })
  })

  it("passes the target's headers but its cookie and its connection's own", async () => {
    const answer = await ask(port, `/forward/${lease}/echo`, { headers: auth() })
    expect(answer.headers['x-target']).toBe('yes')
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(answer.headers['keep-alive']).toBeUndefined()
    expect(answer.headers['x-hop']).toBeUndefined()
    expect(answer.headers['connection']).not.toContain('x-hop')
    // A missing page is the page's own 404, never a refusal.
    const missing = await ask(port, `/forward/${lease}/missing`, { headers: auth() })
    expect(missing.status).toBe(404)
    expect(missing.headers['x-clave-forward']).toBeUndefined()
  })

  it("never relays a page's own refusal mark: only this hop says refused", async () => {
    const answer = await ask(port, `/forward/${lease}/spoof`, { headers: auth() })
    expect(answer.status).toBe(200)
    expect(answer.body.toString()).toBe('page-made')
    expect(answer.headers['x-clave-forward']).toBeUndefined()
  })

  it('never sees a request line with a raw byte above ASCII: the listener answers 400 and keeps serving', async () => {
    // What reaches the route is a request target `node:http` can send on:
    // the listener refuses the rest itself. This pins that, since the route
    // relays the target as it was received.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          Buffer.concat([
            Buffer.from(`GET /forward/${lease}/caf`),
            Buffer.from([0xc3, 0xa9]),
            Buffer.from(
              ` HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer ${server.token}\r\nconnection: close\r\n\r\n`
            )
          ])
        )
      })
      let seen = ''
      socket.on('data', (chunk: Buffer) => {
        seen += chunk.toString('latin1')
      })
      socket.on('close', () => {
        const match = /^HTTP\/1\.1 (\d{3})/.exec(seen)
        if (match) resolve(Number(match[1]))
        else reject(new Error(`no answer: ${JSON.stringify(seen.slice(0, 80))}`))
      })
      socket.on('error', reject)
      setTimeout(() => socket.destroy(), 3000).unref()
    })
    expect(status).toBe(400)
    expect((await ask(port, `/forward/${lease}/echo`, { headers: auth() })).status).toBe(200)
  })

  describe('a WebSocket', () => {
    it('echoes text and binary both ways, with the offered sub-protocol at the target', async () => {
      const ws = opened(await connect(`/forward/${lease}/ws`, auth(), ['clave.test']))
      const seen = target.sockets.at(-1)!
      expect(seen.url).toBe('/ws')
      expect(seen.protocol).toBe('clave.test')
      expect(seen.headers['authorization']).toBeUndefined()
      const text = nextMessage(ws)
      ws.send('hello')
      expect(await text).toMatchObject({ isBinary: false })
      expect((await text).data.toString()).toBe('hello')
      const binary = nextMessage(ws)
      ws.send(Buffer.from([0, 1, 2, 255]))
      const got = await binary
      expect(got.isBinary).toBe(true)
      expect([...got.data]).toEqual([0, 1, 2, 255])
      const closed = closeOf(ws)
      ws.close(1000)
      await closed
    })
    it("carries the target's close code and reason to the caller", async () => {
      const ws = opened(await connect(`/forward/${lease}/ws-close`, auth()))
      expect(await closeOf(ws)).toEqual({ code: 4321, reason: 'bye' })
    })
    it('refuses the handshake without the token (401), for an unknown lease (404), and a target with no socket there (502)', async () => {
      expect(await connect(`/forward/${lease}/ws`, {})).toEqual({ status: 401 })
      expect(await connect(`/forward/${'0'.repeat(32)}/ws`, auth())).toEqual({ status: 404 })
      expect(await connect(`/forward/${lease}/no-socket-here`, auth())).toEqual({ status: 502 })
    })
  })
})
