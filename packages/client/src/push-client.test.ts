import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource, aSession, sleep } from '@clave/server/test-support'
import type { SessionStream } from '@clave/contract/sessions'
import type { ViewRequest } from '@clave/contract/views'
import { PushClient, type PushSocketConstructor, type PushStatus, pushUrlOf } from './push-client'

const Socket = WebSocket as unknown as PushSocketConstructor
const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await sleep(10)
  }
}

describe('the push client against the server', () => {
  let server: EmbeddedServer
  let source: FakeSource
  let client: PushClient | null
  beforeEach(async () => {
    source = new FakeSource(aSession('s1'))
    server = await startEmbedded({ ports: { sessions: source } })
    client = null
  })
  afterEach(async () => {
    client?.close()
    await server.stop()
  })

  it('turns the server URL into the push URL', () => {
    expect(pushUrlOf('http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000/push')
    expect(pushUrlOf('https://host/push')).toBe('wss://host/push')
  })

  it('subscribes and receives a session’s bytes, events and exit', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    const frames: SessionStream[] = []
    const exits: number[] = []
    client.subscribe(
      's1',
      (f) => frames.push(f),
      (code) => exits.push(code)
    )
    await until(() => source.listeners('s1') === 2)
    source.emit('s1', { kind: 'pty', data: new Uint8Array([1, 2, 3]) })
    source.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'working' } })
    source.exit('s1', 3)
    await until(() => exits.length === 1)
    expect(frames).toHaveLength(2)
    expect(frames[0].kind === 'pty' && Array.from(frames[0].data)).toEqual([1, 2, 3])
    expect(frames[1]).toEqual({ kind: 'event', event: { type: 'state_change', state: 'working' } })
    expect(exits).toEqual([3])
  })

  it('shares one wire subscription between listeners and drops it with the last', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    const a: SessionStream[] = []
    const b: SessionStream[] = []
    const offA = client.subscribe('s1', (f) => a.push(f))
    const offB = client.subscribe('s1', (f) => b.push(f))
    await until(() => source.listeners('s1') === 2)
    source.emit('s1', { kind: 'event', event: { type: 'turn_interrupted' } })
    await until(() => a.length === 1 && b.length === 1)
    offA()
    await sleep(50)
    expect(source.listeners('s1')).toBe(2)
    offB()
    await until(() => source.listeners('s1') === 0)
  })

  it('reconnects when the server goes away and subscribes every session again', async () => {
    const statuses: PushStatus[] = []
    client = new PushClient({
      url: server.url,
      token: server.token,
      WebSocket: Socket,
      backoff: { baseMs: 20, maxMs: 100 }
    })
    client.onStatus((status) => statuses.push(status))
    client.connect()
    await client.whenOpen()
    const frames: SessionStream[] = []
    client.subscribe('s1', (f) => frames.push(f))
    await until(() => source.listeners('s1') === 2)
    const port = Number(new URL(server.url).port)
    await server.stop()
    await until(() => client!.status === 'reconnecting')
    // The same port and token, a fresh server with a fresh source.
    const sourceB = new FakeSource(aSession('s1'))
    await sleep(100)
    server = await startEmbedded({ ports: { sessions: sourceB }, port, token: server.token })
    await client.whenOpen()
    await until(() => sourceB.listeners('s1') === 2)
    sourceB.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    await until(() => frames.length === 1)
    expect(client.connections).toBe(2)
    expect(statuses).toEqual(
      ['connecting', 'open', 'reconnecting', 'reconnecting', 'open']
        .slice(0, 2)
        .concat(statuses.slice(2))
    )
    expect(statuses[0]).toBe('connecting')
    expect(statuses[1]).toBe('open')
    expect(statuses.at(-1)).toBe('open')
    expect(statuses.slice(2, -1).every((s) => s === 'reconnecting')).toBe(true)
  })

  it('subscribed() resolves with the session’s record once the server answers, and at once after', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    client.subscribe('s1', () => {})
    const first = await client.subscribed('s1')
    expect(first.id).toBe('s1')
    expect(first).toEqual(source.get('s1'))
    // The answer is kept: a second call settles before anything else can.
    const again = await Promise.race([client.subscribed('s1'), Promise.resolve('pending')])
    expect(again).toBe(first)
  })

  it('subscribed() rejects with the server’s refusal for a session it does not know', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    client.subscribe('ghost', () => {})
    await expect(client.subscribed('ghost')).rejects.toThrow(/^Unknown session$/)
  })

  it('subscribed() rejects when nothing was subscribed', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    await expect(client.subscribed('s1')).rejects.toThrow('Not subscribed')
  })

  it('subscribed() still waiting when the client closes rejects', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    // Subscribed before the welcome: the server has not been asked yet.
    client.subscribe('s1', () => {})
    const pending = client.subscribed('s1')
    client.close()
    await expect(pending).rejects.toThrow('This push client was closed')
  })

  it('subscribed() answers with the new server’s record after a reconnect', async () => {
    client = new PushClient({
      url: server.url,
      token: server.token,
      WebSocket: Socket,
      backoff: { baseMs: 20, maxMs: 100 }
    }).connect()
    await client.whenOpen()
    client.subscribe('s1', () => {})
    expect((await client.subscribed('s1')).title).toBe('s1')
    const port = Number(new URL(server.url).port)
    await server.stop()
    await until(() => client!.status === 'reconnecting')
    const sourceB = new FakeSource({ ...aSession('s1'), title: 'from the new server' })
    await sleep(100)
    server = await startEmbedded({ ports: { sessions: sourceB }, port, token: server.token })
    await client.whenOpen()
    const record = await client.subscribed('s1')
    expect(record.id).toBe('s1')
    expect(record.title).toBe('from the new server')
    expect(sourceB.listeners('s1')).toBe(2)
  })

  it('does not subscribe again, after a reconnect, to a session the server said had exited', async () => {
    client = new PushClient({
      url: server.url,
      token: server.token,
      WebSocket: Socket,
      backoff: { baseMs: 20, maxMs: 100 }
    }).connect()
    await client.whenOpen()
    const errors: string[] = []
    client.onError((message) => errors.push(message))
    const exits: number[] = []
    client.subscribe(
      's1',
      () => {},
      (code) => exits.push(code)
    )
    await until(() => source.listeners('s1') === 2)
    source.exit('s1', 0)
    await until(() => exits.length === 1)
    const port = Number(new URL(server.url).port)
    await server.stop()
    await until(() => client!.status === 'reconnecting')
    const sourceB = new FakeSource()
    await sleep(100)
    server = await startEmbedded({ ports: { sessions: sourceB }, port, token: server.token })
    await client.whenOpen()
    await sleep(150)
    expect(errors).toEqual([])
    // A new listener asks again, and the server answers for the id it knows now.
    client.subscribe('s1', () => {})
    await until(() => errors.length === 1)
    expect(errors[0]).toBe('Unknown session')
  })

  it('a closed client constructs no further socket, even mid-backoff', async () => {
    let constructed = 0
    class Counting extends WebSocket {
      constructor(url: string) {
        super(url)
        constructed += 1
      }
    }
    client = new PushClient({
      url: server.url,
      token: server.token,
      WebSocket: Counting as unknown as PushSocketConstructor,
      backoff: { baseMs: 30, maxMs: 30 }
    }).connect()
    await client.whenOpen()
    await server.stop()
    await until(() => client!.status === 'reconnecting')
    const before = constructed
    client.close()
    await sleep(200)
    expect(constructed).toBe(before)
    expect(client.status).toBe('closed')
    server = await startEmbedded({ ports: { sessions: source } })
  })

  it('stops for good when the server refuses the token', async () => {
    const statuses: Array<[PushStatus, unknown]> = []
    client = new PushClient({
      url: server.url,
      token: 'wrong',
      WebSocket: Socket,
      backoff: { baseMs: 10 }
    })
    client.onStatus((status, detail) => statuses.push([status, detail]))
    client.connect()
    await expect(client.whenOpen()).rejects.toThrow('refused the token')
    expect(client.status).toBe('closed')
    expect(statuses.at(-1)).toEqual([
      'closed',
      { code: 4001, reason: 'unauthorized', final: 'unauthorized' }
    ])
    await sleep(100)
    expect(client.connections).toBe(1)
  })

  it('surfaces the server’s error frames and hears server events', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    const errors: Array<[string, string | undefined]> = []
    const events: string[] = []
    client.onError((message, sessionId) => errors.push([message, sessionId]))
    client.onEvent((envelope) => events.push(envelope.event._tag))
    client.subscribe('ghost', () => {})
    await until(() => errors.length === 1)
    expect(errors[0]).toEqual(['Unknown session', 'ghost'])
    await server.publish({ _tag: 'session.state_changed', id: 's1', state: 'working' })
    await until(() => events.length === 1)
    expect(events).toEqual(['session.state_changed'])
  })

  // ── Lane D (wave 3): the view requests ──
  it('hands a view request to its onRequest listeners, as sent', async () => {
    client = new PushClient({ url: server.url, token: server.token, WebSocket: Socket }).connect()
    await client.whenOpen()
    const requests: ViewRequest[] = []
    client.onRequest((request) => requests.push(request))
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    const asked = post('/views/request', {
      windowKey: 'w1',
      command: 'list',
      payload: { workspace: 'all', depth: [1, 2] },
      timeoutMs: 500
    })
    await until(() => requests.length === 1)
    expect(requests[0]).toMatchObject({
      windowKey: 'w1',
      command: 'list',
      payload: { workspace: 'all', depth: [1, 2] }
    })
    expect(typeof requests[0].requestId).toBe('string')
    const answered = await post('/views/answer', {
      requestId: requests[0].requestId,
      ok: true,
      result: 'done'
    })
    expect(answered.status).toBe(204)
    expect(await (await asked).json()).toEqual({ result: 'done' })
  })
})

describe('the push client with fake time and a fake socket', () => {
  class FakeSocket {
    static instances: FakeSocket[] = []
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    readyState = 0
    constructor(readonly url: string) {
      FakeSocket.instances.push(this)
    }
    send(): void {
      /* a fake socket keeps nothing */
    }
    close(): void {
      this.readyState = 3
    }
  }
  it('close() leaves no timer behind, mid-backoff included', () => {
    vi.useFakeTimers()
    try {
      FakeSocket.instances = []
      const client = new PushClient({
        url: 'http://127.0.0.1:1',
        token: 't',
        WebSocket: FakeSocket as unknown as PushSocketConstructor,
        backoff: { baseMs: 1000, maxMs: 1000 }
      }).connect()
      const socket = FakeSocket.instances[0]
      socket.onopen?.({})
      socket.onclose?.({ code: 1006, reason: '' })
      expect(client.status).toBe('reconnecting')
      expect(vi.getTimerCount()).toBe(1)
      client.close()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(5000)
      expect(FakeSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the push client against a socket that drops without a close frame', () => {
  let wss: WebSocketServer
  let url: string
  const sockets = new Set<WebSocket>()
  let hellos = 0
  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => wss.once('listening', resolve))
    const port = (wss.address() as { port: number }).port
    url = `http://127.0.0.1:${port}`
    wss.on('connection', (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as { _tag: string; sessionId?: string }
        if (frame._tag === 'hello') {
          hellos += 1
          ws.send(JSON.stringify({ _tag: 'welcome', serverId: 'fake', protocol: 1 }))
        }
        if (frame._tag === 'subscribe')
          ws.send(
            JSON.stringify({
              _tag: 'subscribed',
              sessionId: frame.sessionId,
              session: aSession(frame.sessionId!)
            })
          )
      })
    })
  })
  afterEach(async () => {
    for (const ws of sockets) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
    hellos = 0
  })

  it('comes back after the socket is killed and says hello again', async () => {
    const client = new PushClient({
      url,
      token: 't',
      WebSocket: Socket,
      backoff: { baseMs: 10, maxMs: 50 }
    }).connect()
    await client.whenOpen()
    client.subscribe('s1', () => {})
    await until(() => sockets.size === 1)
    for (const ws of sockets) ws.terminate()
    await until(() => client.connections === 2)
    await client.whenOpen()
    expect(hellos).toBe(2)
    expect(client.status).toBe('open')
    client.close()
    await until(() => sockets.size === 0)
    expect(client.status).toBe('closed')
  })

  it('keeps trying while nothing listens and connects once something does', async () => {
    await new Promise((resolve) => wss.close(resolve))
    const port = Number(new URL(url).port)
    const client = new PushClient({
      url,
      token: 't',
      WebSocket: Socket,
      backoff: { baseMs: 10, maxMs: 30 }
    }).connect()
    await until(() => client.status === 'reconnecting')
    await sleep(80)
    expect(client.status).toBe('reconnecting')
    wss = new WebSocketServer({ port, host: '127.0.0.1' })
    wss.on('connection', (ws) => {
      sockets.add(ws)
      ws.on('message', () =>
        ws.send(JSON.stringify({ _tag: 'welcome', serverId: 'fake', protocol: 1 }))
      )
    })
    await new Promise((resolve) => wss.once('listening', resolve))
    await client.whenOpen()
    expect(client.status).toBe('open')
    client.close()
  })
})
