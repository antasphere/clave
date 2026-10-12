import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, aRecord, aSession } from '../test-support'

/**
 * The session records on the server (wave 4, lane C, PRDCT-3376): the
 * adoptable listing, by ids or whole, the discard, and the release that lets
 * another window take a session in. Every answer and refusal is the host's,
 * carried as the contract declares it.
 */
let server: EmbeddedServer
let source: FakeSource
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const get = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: headers(server.token) })
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  source.tmuxBacked.add('s1')
  source.records.push(
    { ...aRecord('r1', 'w1'), tmuxName: 'clave-r1', live: true },
    { ...aRecord('r2'), live: false, link: { kind: 'toolbar', key: 'k:0' } }
  )
  server = await startEmbedded({ ports: { sessions: source } })
})
afterEach(async () => {
  await server.stop()
})

describe('the adoptable records', () => {
  it('lists every adoptable record, every field kept', async () => {
    const response = await get('/sessions/records')
    expect(response.status).toBe(200)
    const records = (await response.json()) as Array<Record<string, unknown>>
    expect(records.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(records[0]).toMatchObject({ tmuxName: 'clave-r1', live: true, windowKey: 'w1' })
    expect(records[1]).toMatchObject({ live: false, link: { kind: 'toolbar', key: 'k:0' } })
    expect(records[1]).not.toHaveProperty('windowKey')
  })
  it('lists by ids, comma-joined, the sessions it runs marked running', async () => {
    const response = await get('/sessions/records?ids=r2,s1,ghost')
    expect(response.status).toBe(200)
    const records = (await response.json()) as Array<Record<string, unknown>>
    expect(records.map((r) => r.id).sort()).toEqual(['r2', 's1'])
    expect(records.find((r) => r.id === 's1')).toMatchObject({ running: true, live: true })
    expect(records.find((r) => r.id === 'r2')).not.toHaveProperty('running')
    const one = await get('/sessions/records?ids=r1')
    expect(((await one.json()) as Array<{ id: string }>).map((r) => r.id)).toEqual(['r1'])
  })
  it('discards a record by its key', async () => {
    const response = await post('/sessions/records/discard', { key: 'clave-r1' })
    expect(response.status).toBe(204)
    expect(source.discards).toEqual(['clave-r1'])
    expect(source.records.map((r) => r.id)).toEqual(['r2'])
  })
  it('releases the tmux-backed sessions and refuses the others, each with its reason', async () => {
    const response = await post('/sessions/release', {
      ids: ['s1', 's2', 'ghost'],
      fallbackWindowKey: 'w1'
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      released: ['s1'],
      refused: [
        { sessionId: 's2', reason: 'not-tmux' },
        { sessionId: 'ghost', reason: 'not-live' }
      ]
    })
    expect(source.releases).toEqual([{ ids: ['s1', 's2', 'ghost'], fallbackWindowKey: 'w1' }])
    // The released session is adoptable now, and no longer runs here.
    expect(source.sessions.has('s1')).toBe(false)
    expect(source.records.some((r) => r.id === 's1' && r.live)).toBe(true)
  })
  it('refuses an empty key and an empty id list at the wire', async () => {
    expect((await post('/sessions/records/discard', { key: '' })).status).toBe(400)
    expect((await post('/sessions/release', { ids: [''] })).status).toBe(400)
  })
})

describe('a server that keeps no records', () => {
  it('says so on every call, as the declared failure', async () => {
    await server.stop()
    server = await startEmbedded({ ports: {} })
    for (const response of [
      await get('/sessions/records'),
      await post('/sessions/records/discard', { key: 'k' }),
      await post('/sessions/release', { ids: ['s1'] })
    ]) {
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'sessions'
      })
    }
    expect(new CapabilityUnavailable({ capability: 'sessions', message: 'x' })._tag).toBe(
      'CapabilityUnavailable'
    )
  })
})
