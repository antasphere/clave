// The stop of the in-process server (wave 4, lane A, PRDCT-3375): it never
// waits on a client. Wave 3 measured ten seconds per quit on the previous
// order (the hub closed, the listener left accepting, the Node server's close
// waiting on the window's connections until the client's own deadline), and
// a request accepted while the server stopped was never answered (round 3's
// m6). These pin the order `stopEmbedded` says, with real sockets.
import { afterEach, describe, expect, it } from 'vitest'
import { Agent, request as httpRequest } from 'node:http'
import { startEmbedded, type EmbeddedOptions, type EmbeddedServer } from './embedded'
import { FakeSource, Peer, aSession } from './test-support'

let server: EmbeddedServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

const start = async (options: Partial<EmbeddedOptions>): Promise<EmbeddedServer> => {
  server = await startEmbedded({
    ports: { sessions: new FakeSource(aSession('s1')) },
    helloTimeoutMs: 200,
    ...options
  })
  return server
}

/** One welcomed push peer on `server`. */
const welcomed = async (s: EmbeddedServer): Promise<Peer> => {
  const peer = new Peer(s.url.replace('http', 'ws') + '/push')
  await peer.opened
  peer.send({ _tag: 'hello', token: s.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
  return peer
}

/** A GET on a keep-alive agent; answers the status, or the error's code. */
const get = (s: EmbeddedServer, path: string, agent: Agent): Promise<string> =>
  new Promise((resolve) => {
    const req = httpRequest(
      `${s.url}${path}`,
      { agent, headers: { authorization: `Bearer ${s.token}` } },
      (res) => {
        res.resume()
        res.once('end', () => resolve(`status ${res.statusCode}`))
      }
    )
    req.once('error', (error: NodeJS.ErrnoException) => resolve(`error ${error.code}`))
    req.end()
  })

describe('the embedded stop never waits on a client', () => {
  it('a push peer that never answers the close frame does not hold the stop', async () => {
    const s = await start({ stopPeerGraceMs: 100 })
    const peer = await welcomed(s)
    // The peer stops reading: the close frame is never seen, never answered.
    // Before the change the ws server's close waited on it for thirty seconds.
    ;(peer.ws as unknown as { _socket: { pause: () => void } })._socket.pause()
    const started = Date.now()
    const report = await s.stop()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(report.peers).toBe(1)
    expect(s.connections()).toBe(0)
  })

  it('a push peer that answers is closed with the stopping code, and nothing is destroyed', async () => {
    const s = await start({})
    const peer = await welcomed(s)
    const report = await s.stop()
    expect(await peer.closed).toEqual({ code: 4010, reason: 'server stopping' })
    expect(report.destroyed).toBe(0)
    expect(report.peers).toBe(1)
  })

  it('a connection a client opens once the stop began is refused, not accepted and left hanging', async () => {
    const s = await start({ stopDrainMs: 300 })
    await welcomed(s)
    const stopping = s.stop()
    const outcome = await Promise.race([
      fetch(`${s.url}/health/live`).then(
        (r) => `answered ${r.status}`,
        (e: { cause?: { code?: string } }) => `refused ${e.cause?.code}`
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), 2000))
    ])
    expect(outcome).toBe('refused ECONNREFUSED')
    await stopping
  })

  it('a request inside a handler when the stop begins is answered before the handlers go', async () => {
    // The fixture route runs the source it is sent: a handler that takes
    // 400 ms, the one request on this server that is long enough to be in
    // flight when the stop begins. (The listener's own close destroys the
    // IDLE kept-alive sockets at once; a request already being handled is
    // the one the drain exists for.)
    const s = await start({ testFixtures: true, stopDrainMs: 2000 })
    const slow = fetch(`${s.url}/e2e/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'async () => { await new Promise((r) => setTimeout(r, 400)); return "answered" }'
      })
    }).then(
      (r) => r.json(),
      (e: { cause?: { code?: string } }) => ({ error: e.cause?.code ?? String(e) })
    )
    await new Promise((r) => setTimeout(r, 100))
    const report = await s.stop()
    expect(await slow).toMatchObject({ ok: true, value: 'answered' })
    expect(report.inFlight).toBe(1)
    expect(report.drained).toBe(true)
  })

  it('a request that outlasts the drain is cut, reported as not drained, and the stop still ends', async () => {
    const s = await start({ testFixtures: true, stopDrainMs: 200 })
    const slow = fetch(`${s.url}/e2e/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'async () => { await new Promise((r) => setTimeout(r, 3000)); return "late" }'
      })
    }).then(
      (r) => `answered ${r.status}`,
      (e: { cause?: { code?: string } }) => `cut ${e.cause?.code ?? String(e)}`
    )
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    const report = await s.stop()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(report.drained).toBe(false)
    expect(report.destroyed).toBe(1)
    expect(await slow).toMatch(/^cut /)
  })

  it('a kept-alive connection a client holds idle is gone after the stop, and not counted as destroyed here', async () => {
    const s = await start({})
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    expect(await get(s, '/health/live', agent)).toBe('status 200')
    const started = Date.now()
    const report = await s.stop()
    expect(Date.now() - started).toBeLessThan(1500)
    // Node's own close destroyed the idle socket at step 1 (round 1 of the
    // verifier: counting it here overstated the stop's work); the next
    // request on the agent finds it gone and the listener refuses a new one.
    expect(report.destroyed).toBe(0)
    expect(await get(s, '/health/live', agent)).toMatch(/^error (ECONNREFUSED|ECONNRESET)/)
    agent.destroy()
  })

  it('stopping twice answers the same report, and the whole stop is quick', async () => {
    const s = await start({})
    await welcomed(s)
    const [a, b] = await Promise.all([s.stop(), s.stop()])
    expect(a).toBe(b)
    expect(a.ms).toBeLessThan(1500)
  })
})
