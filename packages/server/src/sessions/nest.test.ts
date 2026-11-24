import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nestRefusal } from '@clave/contract/nest-rules'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'

/**
 * Which tab a tab is nested under (PRDCT-4997): `NestSession` applies the
 * rule over the records the host keeps, answers what it did, and tells every
 * peer on the push channel with one `session.nested`, only when the record
 * changed. A refusal is the rule's own words, and nothing is said.
 */
let server: EmbeddedServer
let source: FakeSource
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
const pushUrl = (): string => `${server.url.replace(/^http/, 'ws')}/push`

/** A welcomed peer, whose next frames are the events published after it. */
async function welcomed(): Promise<Peer> {
  const peer = new Peer(pushUrl())
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
  return peer
}
const eventOf = async (peer: Peer): Promise<unknown> => {
  const frame = await peer.next()
  expect(frame._tag).toBe('event')
  return (frame as { event: unknown }).event
}

const LEAD = '11111111-1111-4111-8111-111111111111'
const OLD = '22222222-2222-4222-8222-222222222222'
const ELSEWHERE = '33333333-3333-4333-8333-333333333333'
const nest = (id: string, under: string | null): Promise<Response> =>
  post('/sessions/nest', { id, under })

beforeEach(async () => {
  source = new FakeSource(aSession(LEAD), aSession(OLD), aSession(ELSEWHERE, 'w2'))
  server = await startEmbedded({ ports: { sessions: source }, helloTimeoutMs: 500 })
})
afterEach(async () => {
  await server.stop()
})

describe('nesting a tab under another', () => {
  it('nests through the host, answers what changed, and tells the peers once', async () => {
    const peer = await welcomed()
    const response = await nest(OLD, LEAD)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: OLD, under: LEAD, changed: true })
    expect(source.nested.get(OLD)).toBe(LEAD)
    expect(await eventOf(peer)).toEqual({ _tag: 'session.nested', id: OLD, under: LEAD })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('a nesting the record already says publishes nothing', async () => {
    expect((await nest(OLD, LEAD)).status).toBe(200)
    const peer = await welcomed()
    const response = await nest(OLD, LEAD)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: OLD, under: LEAD, changed: false })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('a detach publishes under: null', async () => {
    expect((await nest(OLD, LEAD)).status).toBe(200)
    const peer = await welcomed()
    const response = await nest(OLD, null)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: OLD, under: null, changed: true })
    expect(source.nested.has(OLD)).toBe(false)
    expect(await eventOf(peer)).toEqual({ _tag: 'session.nested', id: OLD, under: null })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('a nesting the records refuse is NestRefused in the rule’s words, and no event', async () => {
    const words = nestRefusal(
      [
        { id: OLD, windowKey: 'w1' },
        { id: ELSEWHERE, windowKey: 'w2' }
      ],
      OLD,
      ELSEWHERE
    )
    expect(words).toContain('different windows')
    const peer = await welcomed()
    const response = await nest(OLD, ELSEWHERE)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ _tag: 'NestRefused', id: OLD, message: words })
    expect(source.nested.size).toBe(0)
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('an unknown subject or parent answers SessionNotFound naming that id', async () => {
    const peer = await welcomed()
    const subject = await nest('zz', LEAD)
    expect(subject.status).toBe(422)
    expect(await subject.json()).toMatchObject({ _tag: 'SessionNotFound', id: 'zz' })
    const parent = await nest(OLD, 'yy')
    expect(parent.status).toBe(422)
    expect(await parent.json()).toMatchObject({ _tag: 'SessionNotFound', id: 'yy' })
    expect(source.nested.size).toBe(0)
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})
