import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyWorkChange, type WorkChange } from '@clave/contract/work-rules'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'

/**
 * Which work a session does (PRDCT-4123): `ChangeSessionWork` applies the
 * rule over the records the host keeps, answers every record it rewrote,
 * the subject's first, and tells every peer on the push channel, one
 * `session.work_changed` per record. A refusal is the rule's own words, and
 * nothing is said.
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

// A successor is named by its session id, which the rule reads as a UUID.
const LEAD = '11111111-1111-4111-8111-111111111111'
const NEXT = '22222222-2222-4222-8222-222222222222'
const laneLead: WorkChange = {
  type: 'assign',
  work: { unit: 'stable-wave/lane-a', kind: 'lane', label: 'Lane A', role: 'lead' }
}
const change = (id: string, body: WorkChange): Promise<Response> =>
  post('/sessions/work', { id, change: body })

beforeEach(async () => {
  source = new FakeSource(aSession(LEAD), aSession(NEXT, 'w2'))
  server = await startEmbedded({ ports: { sessions: source }, helloTimeoutMs: 500 })
})
afterEach(async () => {
  await server.stop()
})

describe('a change of a session’s work', () => {
  it('assigns through the host, answers the record, and tells the peers once', async () => {
    const peer = await welcomed()
    const response = await change(LEAD, laneLead)
    expect(response.status).toBe(200)
    const { changed } = (await response.json()) as { changed: Array<{ id: string; work: unknown }> }
    expect(changed).toEqual([
      {
        id: LEAD,
        work: expect.objectContaining({
          unit: 'stable-wave/lane-a',
          kind: 'lane',
          label: 'Lane A',
          role: 'lead',
          standing: 'current'
        })
      }
    ])
    expect(source.works.get(LEAD)).toEqual(changed[0].work)
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.work_changed',
      id: LEAD,
      work: changed[0].work
    })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('an offer then an accept: the successor pending, then current, the predecessor superseded', async () => {
    const peer = await welcomed()
    expect((await change(LEAD, laneLead)).status).toBe(200)
    await eventOf(peer)

    const offered = await change(LEAD, { type: 'offer', to: NEXT })
    expect(offered.status).toBe(200)
    const offer = (await offered.json()) as { changed: Array<{ id: string; work: unknown }> }
    expect(offer.changed).toEqual([
      { id: NEXT, work: expect.objectContaining({ role: 'lead', standing: 'pending', from: LEAD }) }
    ])
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.work_changed',
      id: NEXT,
      work: offer.changed[0].work
    })

    const accepted = await change(NEXT, { type: 'accept' })
    expect(accepted.status).toBe(200)
    const accept = (await accepted.json()) as { changed: Array<{ id: string; work: unknown }> }
    expect(accept.changed).toEqual([
      { id: NEXT, work: expect.objectContaining({ standing: 'current', from: LEAD }) },
      { id: LEAD, work: expect.objectContaining({ standing: 'superseded' }) }
    ])
    // The subject's first, then the predecessor's: one event per record.
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.work_changed',
      id: NEXT,
      work: accept.changed[0].work
    })
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.work_changed',
      id: LEAD,
      work: accept.changed[1].work
    })
    expect(source.works.get(LEAD)?.standing).toBe('superseded')
    expect(source.works.get(NEXT)?.standing).toBe('current')
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('a change the records refuse is the declared failure in the rule’s words, and no event', async () => {
    expect((await change(LEAD, laneLead)).status).toBe(200)
    const before = new Map(source.works)
    // What the rule itself says to a second current lead without replace.
    let words = ''
    try {
      applyWorkChange(
        [
          { id: LEAD, work: source.works.get(LEAD) },
          { id: NEXT, work: undefined }
        ],
        NEXT,
        laneLead,
        0
      )
    } catch (error) {
      words = (error as Error).message
    }
    expect(words).toContain('already has a current lead')

    const peer = await welcomed()
    const response = await change(NEXT, laneLead)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ _tag: 'WorkChangeRefused', id: NEXT, message: words })
    expect(source.works).toEqual(before)
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('refuses an unknown session before the host, and a change it does not know', async () => {
    const peer = await welcomed()
    const unknown = await change('zz', { type: 'leave' })
    expect(unknown.status).toBe(422)
    expect(await unknown.json()).toMatchObject({ _tag: 'SessionNotFound', id: 'zz' })
    const malformed = await post('/sessions/work', { id: LEAD, change: { type: 'promote' } })
    expect(malformed.status).toBe(400)
    expect(source.works.size).toBe(0)
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})
