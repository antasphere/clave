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

  // PRDCT-4200: a session that exited may have been resumed by another
  // desktop while this one was away, so the welcome asks for it again.
  it('subscribes again, after a reconnect, to a session the server said had exited', async () => {
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
    const frames: SessionStream[] = []
    client.subscribe(
      's1',
      (f) => frames.push(f),
      (code) => exits.push(code)
    )
    await until(() => source.listeners('s1') === 2)
    source.exit('s1', 0)
    await until(() => exits.length === 1)
    const port = Number(new URL(server.url).port)
    await server.stop()
    await until(() => client!.status === 'reconnecting')
    // The new server runs the session again: it was resumed meanwhile.
    const sourceB = new FakeSource(aSession('s1'))
    await sleep(100)
    server = await startEmbedded({ ports: { sessions: sourceB }, port, token: server.token })
    await client.whenOpen()
    await until(() => sourceB.listeners('s1') === 2)
    expect((await client.subscribed('s1')).id).toBe('s1')
    sourceB.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'working' } })
    await until(() => frames.length === 1)
    expect(errors).toEqual([])
  })

  it('hears the server’s refusal, after a reconnect, for an exited session it no longer knows', async () => {
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
    await sleep(100)
    server = await startEmbedded({
      ports: { sessions: new FakeSource() },
      port,
      token: server.token
    })
    await client.whenOpen()
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
    readonly sent: Array<{ _tag: string; sessionId?: string }> = []
    terminated = false
    constructor(readonly url: string) {
      FakeSocket.instances.push(this)
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data) as { _tag: string; sessionId?: string })
    }
    close(): void {
      this.readyState = 3
    }
    terminate(): void {
      this.terminated = true
      this.readyState = 3
    }
    tags(tag: string): number {
      return this.sent.filter((frame) => frame._tag === tag).length
    }
    frame(value: unknown): void {
      this.onmessage?.({ data: JSON.stringify(value) })
    }
    welcome(): void {
      this.onopen?.({})
      this.frame({ _tag: 'welcome', serverId: 'owner', protocol: 1 })
    }
  }

  // The heartbeat, in fake time: 1000 between pings, 500 to answer one,
  // 200 after a late tick.
  const beating = (
    heartbeat: ConstructorParameters<typeof PushClient>[0]['heartbeat'] = {
      intervalMs: 1000,
      timeoutMs: 500,
      wakeTimeoutMs: 200
    }
  ): PushClient =>
    new PushClient({
      url: 'http://127.0.0.1:1',
      token: 't',
      WebSocket: FakeSocket as unknown as PushSocketConstructor,
      backoff: { baseMs: 1, maxMs: 1 },
      heartbeat
    }).connect()

  describe('the heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      FakeSocket.instances = []
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('sends a ping every interval while open, and none before the welcome', () => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      socket.onopen?.({})
      vi.advanceTimersByTime(3000)
      expect(socket.tags('ping')).toBe(0)
      socket.frame({ _tag: 'welcome', serverId: 'owner', protocol: 1 })
      for (let beat = 1; beat <= 3; beat++) {
        vi.advanceTimersByTime(1000)
        expect(socket.tags('ping')).toBe(beat)
        socket.frame({ _tag: 'pong' })
      }
      expect(client.status).toBe('open')
      client.close()
    })

    it('drops a socket that does not answer, reconnects and subscribes again', () => {
      const client = beating()
      const statuses: PushStatus[] = []
      client.onStatus((status) => statuses.push(status))
      const first = FakeSocket.instances[0]
      first.welcome()
      client.subscribe('s1', () => {})
      expect(first.tags('subscribe')).toBe(1)
      vi.advanceTimersByTime(1000)
      expect(first.tags('ping')).toBe(1)
      vi.advanceTimersByTime(499)
      expect(first.terminated).toBe(false)
      vi.advanceTimersByTime(1)
      expect(first.terminated).toBe(true)
      expect(client.status).toBe('reconnecting')
      // Its late close is not taken for the new socket's.
      first.onclose?.({ code: 1006, reason: '' })
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances).toHaveLength(2)
      const second = FakeSocket.instances[1]
      second.welcome()
      expect(client.status).toBe('open')
      expect(second.sent.filter((f) => f._tag === 'subscribe')).toEqual([
        { _tag: 'subscribe', sessionId: 's1' }
      ])
      expect(statuses).toEqual(['open', 'reconnecting', 'reconnecting', 'open'])
      client.close()
    })

    it('a browser socket, with no terminate, is closed instead', () => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      ;(socket as { terminate?: unknown }).terminate = undefined
      socket.welcome()
      vi.advanceTimersByTime(1500)
      expect(socket.readyState).toBe(3)
      expect(client.status).toBe('reconnecting')
      client.close()
    })

    it.each([
      ['a pong', { _tag: 'pong' }],
      [
        'a stream',
        {
          _tag: 'stream',
          sessionId: 's1',
          stream: { kind: 'event', event: { type: 'turn_interrupted' } }
        }
      ],
      [
        'an event',
        {
          _tag: 'event',
          id: 'e1',
          seq: 0,
          at: 1,
          event: { _tag: 'session.state_changed', id: 's1', state: 'working' }
        }
      ],
      ['an undecodable frame', { nonsense: true }]
    ])('%s clears the deadline and the socket stays', (_name, answer) => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      socket.welcome()
      vi.advanceTimersByTime(1000)
      expect(socket.tags('ping')).toBe(1)
      socket.frame(answer)
      vi.advanceTimersByTime(900)
      expect(socket.terminated).toBe(false)
      expect(client.status).toBe('open')
      expect(FakeSocket.instances).toHaveLength(1)
      client.close()
    })

    it('a late tick probes with the short deadline', () => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      socket.welcome()
      // The machine sleeps: the clock jumps past two intervals while no
      // timer runs, then the beat's next tick comes, late.
      vi.setSystemTime(Date.now() + 5000)
      vi.advanceTimersByTime(1000)
      expect(socket.tags('ping')).toBe(1)
      vi.advanceTimersByTime(199)
      expect(socket.terminated).toBe(false)
      vi.advanceTimersByTime(1)
      expect(socket.terminated).toBe(true)
      expect(client.status).toBe('reconnecting')
      client.close()
    })

    it('a probe keeps the sooner of two deadlines', () => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      socket.welcome()
      client.probe(100)
      client.probe(400)
      expect(socket.tags('ping')).toBe(2)
      vi.advanceTimersByTime(100)
      expect(socket.terminated).toBe(true)
      client.close()
    })

    it('probe() while reconnecting opens at once instead of waiting on the backoff', () => {
      const client = new PushClient({
        url: 'http://127.0.0.1:1',
        token: 't',
        WebSocket: FakeSocket as unknown as PushSocketConstructor,
        backoff: { baseMs: 60_000, maxMs: 60_000 }
      }).connect()
      FakeSocket.instances[0].welcome()
      FakeSocket.instances[0].onclose?.({ code: 1006, reason: '' })
      expect(client.status).toBe('reconnecting')
      expect(FakeSocket.instances).toHaveLength(1)
      client.probe()
      expect(FakeSocket.instances).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
      // A second probe while that socket opens does not open another.
      client.probe()
      expect(FakeSocket.instances).toHaveLength(2)
      client.close()
    })

    it('probe() on a closed client does nothing', () => {
      const client = beating()
      FakeSocket.instances[0].welcome()
      client.close()
      client.probe()
      expect(FakeSocket.instances[0].tags('ping')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(client.status).toBe('closed')
    })

    it('with heartbeat: false no beat runs, and probe() still works', () => {
      const client = beating(false)
      const socket = FakeSocket.instances[0]
      socket.welcome()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(socket.tags('ping')).toBe(0)
      client.probe()
      expect(socket.tags('ping')).toBe(1)
      vi.advanceTimersByTime(5000)
      expect(socket.terminated).toBe(true)
      expect(client.status).toBe('reconnecting')
      client.close()
    })

    it('the beat stops at close() and when the socket closes', () => {
      const client = beating()
      const socket = FakeSocket.instances[0]
      socket.welcome()
      vi.advanceTimersByTime(1000)
      // The beat and the ping's deadline.
      expect(vi.getTimerCount()).toBe(2)
      socket.onclose?.({ code: 1006, reason: '' })
      // Only the reconnection is left.
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(1)
      FakeSocket.instances[1].welcome()
      expect(vi.getTimerCount()).toBe(1)
      client.close()
      expect(vi.getTimerCount()).toBe(0)
    })

    // PRDCT-4200: another desktop may have resumed an exited session.
    it('subscribes again at the next welcome to a session an exit frame ended', () => {
      const client = beating()
      const first = FakeSocket.instances[0]
      first.welcome()
      const exits: number[] = []
      client.subscribe(
        's1',
        () => {},
        (code) => exits.push(code)
      )
      first.frame({ _tag: 'exit', sessionId: 's1', code: 0 })
      expect(exits).toEqual([0])
      first.onclose?.({ code: 1006, reason: '' })
      vi.advanceTimersByTime(1)
      const second = FakeSocket.instances[1]
      second.welcome()
      expect(second.sent.filter((f) => f._tag === 'subscribe')).toEqual([
        { _tag: 'subscribe', sessionId: 's1' }
      ])
      // The mark is cleared: a new listener now shares the live subscription
      // instead of asking a second time.
      client.subscribe('s1', () => {})
      expect(second.tags('subscribe')).toBe(1)
      client.close()
    })
  })
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

  // Round 8 of #241's verification: a server's workspace list is taken from
  // its live socket only, so a frame from a socket the client replaced (a
  // process since restarted) must never reach a listener.
  it('hands on no frame from a socket it replaced', async () => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    const client = new PushClient({
      url: 'http://127.0.0.1:1',
      token: 't',
      WebSocket: FakeSocket as unknown as PushSocketConstructor,
      backoff: { baseMs: 1, maxMs: 1 }
    }).connect()
    const heard: string[] = []
    client.onEvent(({ event }) => {
      if (event._tag === 'workspaces.state_changed') heard.push(event.instance)
    })
    const frame = (socket: FakeSocket, value: unknown): void =>
      socket.onmessage?.({ data: JSON.stringify(value) })
    const welcome = { _tag: 'welcome', serverId: 'owner', protocol: 1 }
    const list = (instance: string): unknown => ({
      _tag: 'event',
      id: instance,
      seq: 0,
      at: 1,
      event: {
        _tag: 'workspaces.state_changed',
        workspaces: [],
        pins: [],
        origin: null,
        revision: 1,
        instance
      }
    })
    try {
      const old = FakeSocket.instances[0]
      old.onopen?.({})
      frame(old, welcome)
      frame(old, list('old'))
      old.onclose?.({ code: 1006, reason: '' })
      await vi.advanceTimersByTimeAsync(2)
      const current = FakeSocket.instances[1]
      current.onopen?.({})
      frame(current, welcome)
      frame(current, list('current'))
      // A message the replaced socket still delivers, from the retired process.
      frame(old, list('retired-late'))
      expect(heard).toEqual(['old', 'current'])
    } finally {
      client.close()
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
