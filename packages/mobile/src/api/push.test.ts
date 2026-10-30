import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { ClavePushClient, type PushSocketConstructor, type PushStatus, pushUrlOf } from './push'

/** A stub of the server's push hub: hello with the token or close 4001,
 *  subscribe answered with the record, ping with pong, the rest recorded. */
const TOKEN = 'tok'
const session = {
  id: 's1',
  provider: 'echo',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'server',
  state: 'idle',
  createdAt: 1,
  adapterId: 'echo',
  title: 'Echo'
}
let wss: WebSocketServer
let url = ''
const received: unknown[] = []
const peers = new Set<WebSocket>()
let answerPings = true

const start = async (): Promise<void> => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  url = `http://127.0.0.1:${address.port}`
  wss.on('connection', (socket) => {
    peers.add(socket)
    let welcomed = false
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { _tag: string; token?: string; sessionId?: string }
      received.push(frame)
      if (!welcomed) {
        if (frame._tag !== 'hello' || frame.token !== TOKEN)
          return socket.close(4001, 'unauthorized')
        welcomed = true
        return socket.send(
          JSON.stringify({ _tag: 'welcome', serverId: 'srv', protocol: 1, version: '2.4.0' })
        )
      }
      if (frame._tag === 'ping' && answerPings) return socket.send(JSON.stringify({ _tag: 'pong' }))
      if (frame._tag === 'subscribe') {
        if (frame.sessionId !== 's1')
          return socket.send(
            JSON.stringify({
              _tag: 'error',
              sessionId: frame.sessionId,
              message: 'Unknown session'
            })
          )
        return socket.send(JSON.stringify({ _tag: 'subscribed', sessionId: 's1', session }))
      }
    })
    socket.on('close', () => peers.delete(socket))
  })
}
const stop = async (): Promise<void> => {
  for (const peer of peers) peer.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
}
const broadcast = (frame: unknown): void => {
  for (const peer of peers) peer.send(JSON.stringify(frame))
}
const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const Ctor = WebSocket as unknown as PushSocketConstructor
const client = (
  options: Partial<ConstructorParameters<typeof ClavePushClient>[0]> = {}
): ClavePushClient =>
  new ClavePushClient({
    url,
    token: TOKEN,
    WebSocket: Ctor,
    client: 'test',
    backoff: { baseMs: 10, maxMs: 20 },
    liveness: { intervalMs: 60_000, timeoutMs: 60_000 },
    build: 'development',
    ...options
  })

beforeEach(async () => {
  received.length = 0
  answerPings = true
  await start()
})
afterEach(stop)

describe('pushUrlOf', () => {
  it('derives the socket URL from the base, a relay road included', () => {
    expect(pushUrlOf('http://127.0.0.1:43201')).toBe('ws://127.0.0.1:43201/push')
    expect(pushUrlOf('https://relay.example/m/abc')).toBe('wss://relay.example/m/abc/push')
    expect(pushUrlOf('wss://relay.example/m/abc/push')).toBe('wss://relay.example/m/abc/push')
  })
})

describe('ClavePushClient', () => {
  it('says hello with the token, is welcomed, and names the server', async () => {
    const c = client().connect()
    await c.whenOpen()
    expect(c.status).toBe('open')
    expect(c.serverId).toBe('srv')
    expect(c.serverVersion).toBe('2.4.0')
    expect(received[0]).toEqual({ _tag: 'hello', token: TOKEN, client: 'test' })
    c.close()
  })
  it('a refused token is final', async () => {
    const statuses: PushStatus[] = []
    const c = client({ token: 'wrong' })
    c.onStatus((s) => statuses.push(s))
    c.connect()
    await until(() => c.status === 'closed')
    expect(statuses).toEqual(['connecting', 'closed'])
    await expect(c.whenOpen()).rejects.toThrow(/closed/)
  })
  it('subscribes, receives the record and the stream, and sees the exit', async () => {
    const c = client().connect()
    const streams: unknown[] = []
    let exit: number | null = null
    c.subscribe(
      's1',
      (s) => streams.push(s),
      (code) => (exit = code)
    )
    const record = await c.subscribed('s1')
    expect(record.id).toBe('s1')
    broadcast({
      _tag: 'stream',
      sessionId: 's1',
      stream: { kind: 'event', event: { type: 'assistant_text', delta: 'hi', final: true } }
    })
    broadcast({ _tag: 'exit', sessionId: 's1', code: 0 })
    await until(() => exit !== null)
    expect(streams).toEqual([
      { kind: 'event', event: { type: 'assistant_text', delta: 'hi', final: true } }
    ])
    c.close()
  })
  it("an unknown session rejects the subscription with the server's words", async () => {
    const c = client().connect()
    c.subscribe('nope', () => {})
    await expect(c.subscribed('nope')).rejects.toThrow('Unknown session')
    c.close()
  })
  it('delivers server events, ignores frames it does not know, and survives junk', async () => {
    const c = client().connect()
    await c.whenOpen()
    const events: unknown[] = []
    c.onEvent((e) => events.push(e))
    broadcast({ _tag: 'request', requestId: 'r', windowKey: 'w', command: 'x', payload: {} })
    broadcast({ _tag: 'brand-new-frame', x: 1 })
    for (const peer of peers) peer.send('not json at all')
    broadcast({
      _tag: 'event',
      id: 'e1',
      seq: 1,
      at: 1,
      event: { _tag: 'requests.changed', revision: 2 }
    })
    await until(() => events.length === 1)
    expect(events[0]).toEqual({
      id: 'e1',
      seq: 1,
      at: 1,
      event: { _tag: 'requests.changed', revision: 2 }
    })
    expect(c.status).toBe('open')
    c.close()
  })
  it('a welcome refresh awaits this socket acknowledgement rather than its previous one', async () => {
    const c = client().connect()
    c.subscribe('s1', () => {})
    await c.subscribed('s1')
    let refreshed = false
    let ackCleared = false
    c.onStatus((status) => {
      if (status !== 'open') return
      // Read the observable barrier synchronously in the welcome callback.
      void c.subscribed('s1').then(() => {
        refreshed = true
      })
      queueMicrotask(() => {
        ackCleared = !refreshed
      })
    })
    for (const socket of wss.clients) socket.close(1001, 'test drop')
    await until(() => ackCleared)
    await until(() => refreshed)
    c.close()
  })
  it('reconnects after a drop and subscribes every session again', async () => {
    const c = client().connect()
    c.subscribe('s1', () => {})
    await c.subscribed('s1')
    for (const peer of peers) peer.close(1012, 'restart')
    await until(() => c.connections === 2 && c.status === 'open')
    const subscribes = received.filter((f) => (f as { _tag: string })._tag === 'subscribe')
    expect(subscribes).toHaveLength(2)
    await expect(c.subscribed('s1')).resolves.toMatchObject({ id: 's1' })
    c.close()
  })
  it('pings once open and closes a socket that answers nothing', async () => {
    const c = client({ liveness: { intervalMs: 30, timeoutMs: 30 } }).connect()
    await c.whenOpen()
    await until(() => received.some((f) => (f as { _tag: string })._tag === 'ping'))
    expect(c.pings).toBeGreaterThanOrEqual(1)
    expect(c.status).toBe('open')
    answerPings = false
    const connections = c.connections
    await until(() => c.connections > connections, 5_000)
    expect(c.status).toBe('open')
    c.close()
  })
  it('close ends everything and rejects the waiters', async () => {
    const c = client().connect()
    c.subscribe('s1', () => {})
    const waiting = c.subscribed('s1').catch((e: Error) => e.message)
    c.close()
    expect(c.status).toBe('closed')
    expect(await waiting).toMatch(/closed|s1/)
    expect(() => c.connect()).toThrow(/closed/)
  })
})

it('finished subscriptions still allow a reconnect snapshot barrier', async () => {
  const c = client().connect()
  try {
    c.subscribe('s1', () => {})
    await c.subscribed('s1')
    broadcast({ _tag: 'exit', sessionId: 's1', code: 0 })
    await new Promise((r) => setTimeout(r, 20))
    for (const peer of peers) peer.close(1001, 'test reconnect')
    await until(() => c.connections >= 2 && c.status === 'open')
    const state = await Promise.race([
      c.subscribed('s1').then(() => 'snapshot-ready'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 150))
    ])
    expect(state).toBe('snapshot-ready')
  } finally {
    c.close()
  }
})

it('bounds a missing subscription acknowledgement and removes the timed-out waiter', async () => {
  const c = client().connect()
  try {
    c.subscribe('s1', () => {})
    // The current socket has not welcomed or subscribed yet.
    await expect(c.subscribed('s1', 0)).rejects.toThrow(/acknowledge/)
    await expect(c.subscribed('s1')).resolves.toMatchObject({ id: 's1' })
  } finally {
    c.close()
  }
})
