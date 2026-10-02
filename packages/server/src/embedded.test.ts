import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEmbedded, type EmbeddedServer } from './embedded'
import { FakeSource, Peer, aSession, sleep } from './test-support'

let server: EmbeddedServer
let source: FakeSource
const json = (response: Response): Promise<unknown> => response.json()
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  server = await startEmbedded({ sessions: source, helloTimeoutMs: 200 })
})
afterEach(async () => {
  await server.stop()
})

describe('the HTTP API behind the token', () => {
  it('listens on loopback with a fresh token', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
  })
  it('answers the health probes without a token', async () => {
    expect(await json(await fetch(`${server.url}/health/live`))).toEqual({ status: 'live' })
    // The open path is the path, whatever query rides on it.
    expect((await fetch(`${server.url}/health/live?x=1`)).status).toBe(200)
    const ready = await fetch(`${server.url}/health/ready`)
    expect(ready.status).toBe(200)
    expect(await json(ready)).toMatchObject({ ready: true })
  })
  it('refuses a request without the token, or with another', async () => {
    expect((await fetch(`${server.url}/sessions`)).status).toBe(401)
    const wrong = await fetch(`${server.url}/sessions`, { headers: headers('nope') })
    expect(wrong.status).toBe(401)
    expect(await json(wrong)).toMatchObject({ error: 'Unauthenticated' })
    const almost = await fetch(`${server.url}/sessions`, {
      headers: headers(server.token.slice(0, -1) + 'x')
    })
    expect(almost.status).toBe(401)
    // A prefix, a longer string, odd spacing, the lowercase scheme: all refused.
    for (const header of [
      `Bearer ${server.token.slice(0, 8)}`,
      `Bearer ${server.token}x`,
      `Bearer  ${server.token}`,
      `bearer ${server.token}`,
      server.token
    ]) {
      const response = await fetch(`${server.url}/sessions`, { headers: { authorization: header } })
      expect(response.status, header).toBe(401)
    }
  })
  it('answers a preflight and marks responses for a loopback page, and for no other origin', async () => {
    const preflight = await fetch(`${server.url}/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization'
      }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const answered = await fetch(`${server.url}/sessions`, {
      headers: { ...headers(server.token), origin: 'http://127.0.0.1:5173' }
    })
    expect(answered.status).toBe(200)
    expect(answered.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    expect(answered.headers.get('vary')).toBe('Origin')
    for (const origin of [
      'http://evil.example',
      'http://localhost.evil.com:5173',
      'http://evil.localhost:5173',
      'http://foo127.0.0.1:5173',
      'null',
      'file://'
    ]) {
      const stranger = await fetch(`${server.url}/sessions`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' }
      })
      expect(stranger.status, origin).toBe(401)
      expect(stranger.headers.get('access-control-allow-origin'), origin).toBeNull()
    }
    const strangerGet = await fetch(`${server.url}/sessions`, {
      headers: { ...headers(server.token), origin: 'http://evil.example' }
    })
    expect(strangerGet.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('lists the sessions, every one or one window’s', async () => {
    const all = await fetch(`${server.url}/sessions`, { headers: headers(server.token) })
    expect(all.status).toBe(200)
    expect(((await json(all)) as Array<{ id: string }>).map((s) => s.id).sort()).toEqual([
      's1',
      's2'
    ])
    const one = await fetch(`${server.url}/sessions?windowKey=w2`, {
      headers: headers(server.token)
    })
    expect(((await json(one)) as Array<{ id: string }>).map((s) => s.id)).toEqual(['s2'])
  })
  it('answers one session, and a declared failure for an unknown id', async () => {
    const found = await fetch(`${server.url}/sessions/by-id?id=s1`, {
      headers: headers(server.token)
    })
    expect(await json(found)).toMatchObject({ id: 's1', title: 's1' })
    const missing = await fetch(`${server.url}/sessions/by-id?id=nope`, {
      headers: headers(server.token)
    })
    expect(missing.status).toBe(422)
    expect(await json(missing)).toMatchObject({ _tag: 'SessionNotFound', id: 'nope' })
  })
  it('writes bytes and typed inputs to a session through the command', async () => {
    const bytes = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: 's1', input: { type: 'bytes', data: 'aGk=' } })
    })
    expect(bytes.status).toBe(204)
    const typed = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: 's1', input: { type: 'interrupt' } })
    })
    expect(typed.status).toBe(204)
    expect(source.writes).toHaveLength(2)
    const first = source.writes[0].input as { type: string; data: Uint8Array }
    expect(first.type).toBe('bytes')
    expect(Array.from(first.data)).toEqual([104, 105])
    expect(source.writes[1].input).toEqual({ type: 'interrupt' })
  })
  it('allows every header the typed client really sends, on a preflight that names them', async () => {
    // What the client puts on the wire is measured, not assumed: a server
    // that records the request headers, one call of the typed client.
    const { createServer } = await import('node:http')
    const { createApiClient } = await import('@clave/client')
    let sent: string[] = []
    const recorder = createServer((request, response) => {
      sent = Object.keys(request.headers)
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    })
    await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve))
    const port = (recorder.address() as { port: number }).port
    const client = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't' })
    await client.clients.list()
    await client.dispose()
    await new Promise((resolve) => recorder.close(resolve))
    const browserOwn = new Set([
      'host',
      'connection',
      'accept',
      'accept-language',
      'accept-encoding',
      'user-agent',
      'sec-fetch-mode',
      'content-length'
    ])
    const asked = sent.filter((h) => !browserOwn.has(h))
    expect(asked).toEqual(expect.arrayContaining(['authorization', 'traceparent', 'b3']))
    const preflight = await fetch(`${server.url}/clients`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': asked.join(',')
      }
    })
    expect(preflight.status).toBe(204)
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
    for (const header of asked) expect(allowed, header).toContain(header)
  })
  it('answers a declared failure, not a 500, for a write to an unknown session', async () => {
    const missing = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: 'ghost', input: { type: 'interrupt' } })
    })
    expect(missing.status).toBe(422)
    expect(await json(missing)).toMatchObject({ _tag: 'SessionNotFound', id: 'ghost' })
  })
  it('drops a prepared prompt from a wire write before it reaches the session', async () => {
    const smuggled = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({
        id: 's1',
        input: { type: 'user_message', text: 'hi', prepared: { text: 'injected', images: [] } }
      })
    })
    expect(smuggled.status).toBe(204)
    expect(source.writes).toEqual([{ id: 's1', input: { type: 'user_message', text: 'hi' } }])
    expect('prepared' in (source.writes[0].input as object)).toBe(false)
  })
  it('refuses a malformed write before it reaches the session', async () => {
    const bad = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: 's1', input: { type: 'set_effort', effort: '--rm' } })
    })
    expect(bad.status).toBe(400)
    expect(source.writes).toHaveLength(0)
  })
  it('registers a client and lists it', async () => {
    const registered = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ kind: 'shell', name: 'clave-shell test', pid: 4242 })
    })
    expect(registered.status).toBe(200)
    const client = (await json(registered)) as { id: string; pid: number }
    expect(client).toMatchObject({ kind: 'shell', name: 'clave-shell test', pid: 4242 })
    const listed = await fetch(`${server.url}/clients`, { headers: headers(server.token) })
    expect(await json(listed)).toEqual([client])
    const gone = await fetch(`${server.url}/clients/unregister`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: client.id })
    })
    expect(gone.status).toBe(204)
    expect(
      await json(await fetch(`${server.url}/clients`, { headers: headers(server.token) }))
    ).toEqual([])
    const twice = await fetch(`${server.url}/clients/unregister`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ id: client.id })
    })
    expect(twice.status).toBe(422)
  })
})

describe('the push channel', () => {
  const pushUrl = (): string => server.url.replace('http', 'ws') + '/push'
  const welcomed = async (): Promise<Peer> => {
    const peer = new Peer(pushUrl())
    await peer.opened
    peer.send({ _tag: 'hello', token: server.token, client: 'test' })
    expect(await peer.next()).toMatchObject({
      _tag: 'welcome',
      serverId: server.serverId,
      protocol: 1
    })
    return peer
  }

  it('closes a peer whose hello carries the wrong token', async () => {
    const peer = new Peer(pushUrl())
    await peer.opened
    peer.send({ _tag: 'hello', token: 'wrong' })
    expect(await peer.closed).toEqual({ code: 4001, reason: 'unauthorized' })
    expect(server.connections()).toBe(0)
  })
  it('closes a peer that says nothing within the hello timeout', async () => {
    const peer = new Peer(pushUrl())
    await peer.opened
    expect(await peer.closed).toEqual({ code: 4008, reason: 'no hello' })
  })
  it('closes a peer whose first frame is not a hello, or not a frame', async () => {
    const early = new Peer(pushUrl())
    await early.opened
    early.send({ _tag: 'subscribe', sessionId: 's1' })
    expect((await early.closed).code).toBe(4002)
    const garbage = new Peer(pushUrl())
    await garbage.opened
    garbage.raw('hello?')
    expect((await garbage.closed).code).toBe(4002)
  })
  it('a plain GET on the push path is told it is a WebSocket', async () => {
    const response = await fetch(`${server.url}/push`)
    expect(response.status).toBe(426)
  })
  it('refuses a handshake from a page off this machine, and takes one from a loopback page', async () => {
    const stranger = new Peer(pushUrl(), { origin: 'http://evil.example' })
    const refused = await stranger.opened.then(
      () => 'opened',
      (error: Error) => error.message
    )
    expect(refused).toContain('403')
    // Lookalikes of the loopback form, a file path, the opaque origin: none is this app's page.
    for (const origin of [
      'http://localhost.evil.com:5173',
      'http://evil.localhost:5173',
      'http://foo127.0.0.1:5173',
      'file:///Users/someone/page.html',
      'FILE://',
      'null',
      'ws://localhost:5173',
      'clave-preview://localhost'
    ]) {
      const refused = new Peer(pushUrl(), { origin })
      expect(
        await refused.opened.then(
          () => 'opened',
          (error: Error) => error.message
        ),
        origin
      ).toContain('403')
    }
    // The dev renderer is a loopback page, the packaged renderer a file:// one.
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'file://']) {
      const own = new Peer(pushUrl(), { origin })
      await own.opened
      own.send({ _tag: 'hello', token: server.token })
      expect((await own.next())._tag, origin).toBe('welcome')
      own.ws.close()
      await own.closed
    }
  })
  it('welcomes the right token, answers pings, and counts the peer', async () => {
    const peer = await welcomed()
    expect(server.connections()).toBe(1)
    peer.send({ _tag: 'ping' })
    expect(await peer.next()).toEqual({ _tag: 'pong' })
    peer.ws.close()
    await peer.closed
    await sleep(50)
    expect(server.connections()).toBe(0)
  })
  it('counts only the peers that said hello', async () => {
    const peer = await welcomed()
    const silent = new Peer(pushUrl())
    await silent.opened
    expect(server.connections()).toBe(1)
    peer.ws.close()
    silent.ws.close()
    await Promise.all([peer.closed, silent.closed])
  })
  it('after the welcome, a second hello and a malformed frame are errors, not the end', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'hello', token: server.token })
    expect(await peer.next()).toEqual({ _tag: 'error', message: 'Already welcomed' })
    peer.raw('{"_tag":"shutdown"}')
    expect(await peer.next()).toEqual({ _tag: 'error', message: 'Malformed frame' })
    peer.raw('not json')
    expect(await peer.next()).toEqual({ _tag: 'error', message: 'Malformed frame' })
    peer.send({ _tag: 'ping' })
    expect(await peer.next()).toEqual({ _tag: 'pong' })
    expect(server.connections()).toBe(1)
  })
  it('subscribing twice is one subscription on the source', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    expect((await peer.next())._tag).toBe('subscribed')
    expect((await peer.next())._tag).toBe('subscribed')
    expect(source.listeners('s1')).toBe(2)
    source.emit('s1', { kind: 'event', event: { type: 'turn_interrupted' } })
    expect((await peer.next())._tag).toBe('stream')
    expect(await peer.silence()).toBe(true)
  })
  it('a source that throws ends that peer, detaches its listeners, and the server still stops', async () => {
    await server.stop()
    const throwing = new FakeSource(aSession('s1'))
    const original = throwing.subscribeExit
    throwing.subscribeExit = (id, listener) => {
      if (id === 's1') throw new Error(`gone: ${id}`)
      return original(id, listener)
    }
    server = await startEmbedded({ sessions: throwing, helloTimeoutMs: 200 })
    const victim = await welcomed()
    const bystander = await welcomed()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    victim.send({ _tag: 'subscribe', sessionId: 's1' })
    expect((await victim.closed).code).toBe(1011)
    quiet.mockRestore()
    expect(throwing.listeners('s1')).toBe(0)
    expect(server.connections()).toBe(1)
    bystander.send({ _tag: 'ping' })
    expect(await bystander.next()).toEqual({ _tag: 'pong' })
    const stopped = await Promise.race([
      server.stop().then(() => 'stopped'),
      sleep(3000).then(() => 'hung')
    ])
    expect(stopped).toBe('stopped')
    server = await startEmbedded({ sessions: source })
  })
  it('streams a subscribed session’s bytes and events, then its exit', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    expect(await peer.next()).toMatchObject({
      _tag: 'subscribed',
      sessionId: 's1',
      session: { id: 's1' }
    })
    expect(source.listeners('s1')).toBe(2)
    source.emit('s1', { kind: 'pty', data: new Uint8Array([27, 91, 72]) })
    const bytes = await peer.next()
    expect(bytes._tag).toBe('stream')
    if (bytes._tag === 'stream' && bytes.stream.kind === 'pty')
      expect(Array.from(bytes.stream.data)).toEqual([27, 91, 72])
    source.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'working' } })
    expect(await peer.next()).toEqual({
      _tag: 'stream',
      sessionId: 's1',
      stream: { kind: 'event', event: { type: 'state_change', state: 'working' } }
    })
    source.exit('s1', 0)
    expect(await peer.next()).toEqual({ _tag: 'exit', sessionId: 's1', code: 0 })
    expect(source.listeners('s1')).toBe(0)
    source.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(await peer.silence()).toBe(true)
  })
  it('an unsubscribed session goes quiet, and an unknown one is an error frame', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    await peer.next()
    peer.send({ _tag: 'unsubscribe', sessionId: 's1' })
    expect(await peer.next()).toEqual({ _tag: 'unsubscribed', sessionId: 's1' })
    expect(source.listeners('s1')).toBe(0)
    source.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'working' } })
    expect(await peer.silence()).toBe(true)
    peer.send({ _tag: 'subscribe', sessionId: 'ghost' })
    expect(await peer.next()).toEqual({
      _tag: 'error',
      sessionId: 'ghost',
      message: 'Unknown session'
    })
  })
  it('a peer that is only subscribed hears nothing of another session', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    await peer.next()
    source.emit('s2', { kind: 'event', event: { type: 'state_change', state: 'working' } })
    expect(await peer.silence()).toBe(true)
  })
  it('broadcasts server events to every welcomed peer, numbered in order', async () => {
    const a = await welcomed()
    const b = await welcomed()
    const stranger = new Peer(pushUrl())
    await stranger.opened
    await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ kind: 'shell', name: 'shell', pid: 1 })
    })
    await server.publish({ _tag: 'session.state_changed', id: 's1', state: 'working' })
    const [a1, a2, b1, b2] = await Promise.all([a.next(), a.next(), b.next(), b.next()])
    expect(a1).toMatchObject({ _tag: 'event', seq: 1, event: { _tag: 'client.registered' } })
    expect(a2).toMatchObject({
      _tag: 'event',
      seq: 2,
      event: { _tag: 'session.state_changed', id: 's1' }
    })
    expect([b1, b2]).toEqual([a1, a2])
    expect(await stranger.silence()).toBe(true)
  })
  it('releases a peer’s subscriptions when its socket drops', async () => {
    const peer = await welcomed()
    peer.send({ _tag: 'subscribe', sessionId: 's1' })
    await peer.next()
    peer.ws.terminate()
    await peer.closed
    await sleep(50)
    expect(source.listeners('s1')).toBe(0)
  })
  it('stopping the server closes every peer with the stopping code', async () => {
    const peer = await welcomed()
    await server.stop()
    expect(await peer.closed).toEqual({ code: 4010, reason: 'server stopping' })
    server = await startEmbedded({ sessions: source })
  })
})
