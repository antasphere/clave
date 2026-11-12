/**
 * What the installed native phone apps call, as their own HTTP client sends
 * it (the Android client `ClaveServerClient.kt` and `EnrollmentClient` on the
 * `mobile` branch at 691d2789): the paths, the query strings and the bodies
 * are theirs, and every answer is asserted in the shape their decoders read.
 * A server that drops one of these routes, or answers one in another shape,
 * breaks the phone with no symptom on the desktop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from './embedded'
import { FakeSource, aSession } from './test-support'
import { UnconfirmedSessionWrite } from '@clave/contract/session-write-error'

let server: EmbeddedServer
let source: FakeSource

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json'
})
const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: token ? auth(token) : { accept: 'application/json' } })
const post = (path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { ...(token ? auth(token) : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

/** `ClaveServerClient.sessions.write`: the body `Encode.writeSession` builds. */
const phoneWrite = (id: string, text: string, clientMessageId: string): unknown => ({
  id,
  input: { type: 'user_message', text, clientMessageId }
})

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2'))
  server = await startEmbedded({ ports: { sessions: source }, helloTimeoutMs: 200 })
  // What the entries do at a spawn, and for every session at the ledger's
  // first activation: s1's ledger is complete. s2 is a session the server
  // cannot vouch for, as one restored from before the ledger existed.
  server.writes.initialize('s1')
})
afterEach(async () => {
  await server.stop()
})

describe('the conversation the phone reads', () => {
  it('answers the ordered timeline at the path and in the shape the phone decodes', async () => {
    const page = {
      items: [
        {
          event: { type: 'user_message', text: 'hello' },
          at: 1,
          position: { generation: 'g-1', sequence: 1 }
        }
      ],
      before: null,
      cursor: { generation: 'g-1', sequence: 1 },
      truncated: false
    }
    Object.assign(source, { timeline: () => page })
    // `sessions.timeline(id, before = null, limit = 50)`: no `before` in the query when absent.
    const response = await get('/sessions/timeline?id=s1&limit=50', server.token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(page)
  })
})

describe('a message the phone sends', () => {
  it('is acknowledged with the answer the phone requires, never an empty success', async () => {
    const response = await post(
      '/sessions/write',
      phoneWrite('s1', 'hi', 'm-native-0001'),
      server.token
    )
    expect(response.status).toBe(200)
    const answer = (await response.json()) as { status: string; at?: number }
    expect(['accepted', 'pending']).toContain(answer.status)
    expect(source.writes).toHaveLength(1)
  })

  it('is written once when the phone sends the same message id again', async () => {
    const first = await post(
      '/sessions/write',
      phoneWrite('s1', 'hi', 'm-native-0002'),
      server.token
    )
    expect(first.status).toBe(200)
    const again = await post(
      '/sessions/write',
      phoneWrite('s1', 'hi', 'm-native-0002'),
      server.token
    )
    expect(again.status).toBe(200)
    expect(source.writes).toHaveLength(1)
  })

  it('is refused as unknown, and written nowhere, on a session whose ledger the server cannot vouch for', async () => {
    const response = await post(
      '/sessions/write',
      phoneWrite('s2', 'hi', 'm-native-0004'),
      server.token
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'SessionWriteUnknown' })
    expect(source.writes).toHaveLength(0)
    // The phone's retry with the same id is refused the same way: never a second send.
    const again = await post(
      '/sessions/write',
      phoneWrite('s2', 'hi', 'm-native-0004'),
      server.token
    )
    expect(again.status).toBe(422)
    expect(source.writes).toHaveLength(0)
  })

  it('is found by the id the phone minted, at the path the phone asks before a retry', async () => {
    await post('/sessions/write', phoneWrite('s1', 'hi', 'm-native-0003'), server.token)
    const response = await get('/sessions/writes?id=s1&clientMessageId=m-native-0003', server.token)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'accepted' })
  })
})

describe('the pairing the phone starts with no credential', () => {
  it('reads a pairing without a bearer, an unknown one as expired', async () => {
    const response = await get('/devices/pair?id=connection-capability-probe')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'expired' })
  })

  it('takes a pairing request without a bearer and refuses it by a named reason', async () => {
    const response = await post('/devices/pair', {
      idToken: 'not-a-token',
      clientId: 'phone-client',
      device: { name: 'Pixel 9', platform: 'android', appVersion: '1.0.0' }
    })
    // Never 401 (the route is open) and never 404 (the route exists): a server
    // with no owner says so, a server with one names the check that refused.
    expect(response.status).toBe(422)
    const body = (await response.json()) as { _tag?: string }
    expect(['CapabilityUnavailable', 'DevicePairingRefused']).toContain(body._tag)
  })
})

describe('a message the phone sends is acknowledged by its provider, not by the server alone', () => {
  it('stays pending until the session acknowledges it, then reads accepted', async () => {
    let acknowledge!: () => void
    Object.assign(source, {
      write: (id: string, input: unknown) =>
        new Promise<void>((resolve) => {
          source.writes.push({ id, input })
          acknowledge = resolve
        })
    })
    const answer = post('/sessions/write', phoneWrite('s1', 'hi', 'm-native-0010'), server.token)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const meanwhile = await get(
      '/sessions/writes?id=s1&clientMessageId=m-native-0010',
      server.token
    )
    expect(await meanwhile.json()).toMatchObject({ status: 'pending' })
    acknowledge()
    const settled = await answer
    expect(settled.status).toBe(200)
    expect(await settled.json()).toMatchObject({ status: 'accepted' })
    const after = await get('/sessions/writes?id=s1&clientMessageId=m-native-0010', server.token)
    expect(await after.json()).toMatchObject({ status: 'accepted' })
    expect(source.writes).toHaveLength(1)
  })

  it('reads unknown when the session cannot confirm it, and a retry sends nothing', async () => {
    Object.assign(source, {
      write: async (id: string, input: unknown) => {
        source.writes.push({ id, input })
        throw new UnconfirmedSessionWrite(id, 'm-native-0011')
      }
    })
    const answer = await post(
      '/sessions/write',
      phoneWrite('s1', 'hi', 'm-native-0011'),
      server.token
    )
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({ _tag: 'SessionWriteUnknown' })
    const status = await get('/sessions/writes?id=s1&clientMessageId=m-native-0011', server.token)
    expect(await status.json()).toMatchObject({ status: 'unknown' })
    const again = await post(
      '/sessions/write',
      phoneWrite('s1', 'hi', 'm-native-0011'),
      server.token
    )
    expect(again.status).toBe(422)
    expect(source.writes).toHaveLength(1)
  })
})
