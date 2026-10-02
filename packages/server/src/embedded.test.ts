import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
