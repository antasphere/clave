import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@clave/contract/push'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, sleep } from '../test-support'

let server: EmbeddedServer
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })
const welcomed = async (): Promise<Peer> => {
  const peer = new Peer(server.url.replace('http', 'ws') + '/push')
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
  return peer
}
type RequestFrame = Extract<ServerFrame, { _tag: 'request' }>
const nextRequest = async (peer: Peer): Promise<RequestFrame> => {
  const frame = await peer.next()
  if (frame._tag !== 'request') throw new Error(`Expected a request frame, got ${frame._tag}`)
  return frame
}
/** Whether a promise is still unsettled after `ms`. */
const stillPending = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([promise.then(() => false), sleep(ms).then(() => true)])

beforeEach(async () => {
  server = await startEmbedded({ ports: { sessions: new FakeSource() }, helloTimeoutMs: 200 })
})
afterEach(async () => {
  await server.stop()
})

describe('a view request', () => {
  it('reaches a welcomed peer and waits for its answer', async () => {
    const peer = await welcomed()
    const asked = post('/views/request', {
      windowKey: 'w1',
      command: 'list',
      payload: { workspace: 'all' }
    })
    const frame = await nextRequest(peer)
    expect(frame).toMatchObject({ windowKey: 'w1', command: 'list', payload: { workspace: 'all' } })
    expect(typeof frame.requestId).toBe('string')
    expect(await stillPending(asked, 100)).toBe(true)
    const answered = await post('/views/answer', {
      requestId: frame.requestId,
      ok: true,
      result: { groups: [] }
    })
    // A Void success is a 204 through the framework's bridge.
    expect(answered.status).toBe(204)
    const response = await asked
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { groups: [] } })
    peer.ws.close()
  })

  it('answers ViewRequestRefused with the window’s message', async () => {
    const peer = await welcomed()
    const asked = post('/views/request', { windowKey: 'w1', command: 'rename', payload: null })
    const frame = await nextRequest(peer)
    expect(
      (
        await post('/views/answer', {
          requestId: frame.requestId,
          ok: false,
          error: 'No group "x"'
        })
      ).status
    ).toBe(204)
    const response = await asked
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'ViewRequestRefused',
      message: 'No group "x"',
      command: 'rename'
    })
    peer.ws.close()
  })

  it('times out when nobody answers, and forgets the request', async () => {
    const peer = await welcomed()
    const started = Date.now()
    const asked = post('/views/request', {
      windowKey: 'w1',
      command: 'list',
      payload: {},
      timeoutMs: 200
    })
    const frame = await nextRequest(peer)
    const response = await asked
    const elapsed = Date.now() - started
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'ViewRequestTimeout', timeoutMs: 200 })
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(1500)
    const late = await post('/views/answer', { requestId: frame.requestId, ok: true })
    expect(late.status).toBe(422)
    expect(await late.json()).toMatchObject({
      _tag: 'ViewRequestNotFound',
      requestId: frame.requestId
    })
    peer.ws.close()
  })

  it('answers ViewRequestNotFound to an answer for an unknown id', async () => {
    const response = await post('/views/answer', { requestId: 'nobody-asked', ok: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'ViewRequestNotFound',
      requestId: 'nobody-asked'
    })
  })

  it('reaches no peer that has not said hello', async () => {
    const stranger = new Peer(server.url.replace('http', 'ws') + '/push')
    await stranger.opened
    const peer = await welcomed()
    const asked = post('/views/request', { windowKey: 'w1', command: 'list', payload: {} })
    const frame = await nextRequest(peer)
    expect(await stranger.silence(100)).toBe(true)
    await post('/views/answer', { requestId: frame.requestId, ok: true })
    expect((await asked).status).toBe(200)
    peer.ws.close()
    stranger.ws.close()
  })

  it('answers no result key when the window answered none', async () => {
    const peer = await welcomed()
    const asked = post('/views/request', { windowKey: 'w1', command: 'focus', payload: {} })
    const frame = await nextRequest(peer)
    expect((await post('/views/answer', { requestId: frame.requestId, ok: true })).status).toBe(204)
    const response = await asked
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual({})
    expect('result' in body).toBe(false)
    peer.ws.close()
  })

  it('goes to every welcomed peer, since the server does not know which is which window', async () => {
    const a = await welcomed()
    const b = await welcomed()
    const asked = post('/views/request', { windowKey: 'w2', command: 'list', payload: { n: 1 } })
    const [fa, fb] = await Promise.all([nextRequest(a), nextRequest(b)])
    expect(fa).toEqual(fb)
    expect(fa).toMatchObject({ windowKey: 'w2', command: 'list', payload: { n: 1 } })
    await post('/views/answer', { requestId: fa.requestId, ok: true, result: 1 })
    expect(await (await asked).json()).toEqual({ result: 1 })
    a.ws.close()
    b.ws.close()
  })

  it('refuses a request without the token', async () => {
    const response = await fetch(`${server.url}/views/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowKey: 'w1', command: 'list', payload: {} })
    })
    expect(response.status).toBe(401)
  })
})
