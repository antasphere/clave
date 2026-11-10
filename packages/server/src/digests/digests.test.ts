import { afterEach, describe, expect, it } from 'vitest'
import type { ExchangeDigestRead, WorkDigestRead } from '@clave/contract/digests'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import type { DigestsService } from './port'
import { DIGEST_BODY_LIMIT } from '../runtime'

/**
 * The digests domain (PRDCT-4327): a client asks the server a tab runs on,
 * behind the bearer token; the request reaches the port without any launch
 * field the client added; a read that could not be made comes back as an
 * answer with its reason; a server with nothing behind the port says so.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (path: string, body?: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) })
  })

function fakePort(): { port: DigestsService; asked: unknown[] } {
  const asked: unknown[] = []
  const port: DigestsService = {
    exchangeDigest: async (request: ExchangeDigestRead) => {
      asked.push(request)
      return request.key === '0-limit'
        ? { ok: false, error: 'You have hit your limit', reason: 'limit' }
        : { ok: true, needsYou: false, summary: 'Nothing for you.', message: null }
    },
    exchangeDigestsOf: (sessionId): ReturnType<DigestsService['exchangeDigestsOf']> =>
      sessionId === 's1' ? { k1: { ok: true, needsYou: true, summary: 'Merge?', message: 0 } } : {},
    workDigest: async (request: WorkDigestRead) => {
      asked.push(request)
      return { ok: true, title: 'Read the notes', needsYou: false, note: null }
    },
    workDigestsOf: () => ({ w1: { ok: true, title: 'Filed', needsYou: false, note: null } })
  }
  return { port, asked }
}

describe('the digests over HTTP', () => {
  it('reads a digest for a session without any launch the client sent', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const answer = await call('/digests/exchange', {
      sessionId: 's1',
      key: '1-k2',
      messages: [{ from: 'Lane A', text: 'done' }],
      launch: { claudeProfileId: 'the-mac-account' }
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      ok: true,
      needsYou: false,
      summary: 'Nothing for you.',
      message: null
    })
    expect(asked).toEqual([
      { sessionId: 's1', key: '1-k2', messages: [{ from: 'Lane A', text: 'done' }] }
    ])
  })

  it('a read that could not be made is an answer with its reason', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const answer = await call('/digests/exchange', {
      sessionId: 's1',
      key: '0-limit',
      messages: []
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      ok: false,
      error: 'You have hit your limit',
      reason: 'limit'
    })
  })

  it('lists what is filed, and reads a work digest', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const filed = await call('/digests/exchanges-of?sessionId=s1')
    expect(await filed.json()).toEqual({
      k1: { ok: true, needsYou: true, summary: 'Merge?', message: 0 }
    })
    const work = await call('/digests/work', {
      sessionId: 's1',
      key: 'work-1-w2',
      notes: ['a'],
      tools: 2
    })
    expect(await work.json()).toMatchObject({ ok: true, title: 'Read the notes' })
    expect(asked).toEqual([{ sessionId: 's1', key: 'work-1-w2', notes: ['a'], tools: 2 }])
    const workFiled = await call('/digests/work-of?sessionId=s1')
    expect(await workFiled.json()).toMatchObject({ w1: { title: 'Filed' } })
  })

  it('refuses without the token, and says so on a server with no digests', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await call('/digests/exchanges-of?sessionId=s1', undefined, 'wrong')).status).toBe(401)
    const answer = await call('/digests/exchange', { sessionId: 's1', key: '1-k', messages: [] })
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'digests'
    })
  })

  it('refuses, before the port, what is past the bounds the clip sets, and takes what is within', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const message = { from: 'a', text: 'b' }
    const exchange = (body: object): Promise<number> =>
      call('/digests/exchange', { sessionId: 's1', key: '1-x', ...body }).then((r) => r.status)
    const work = (body: object): Promise<number> =>
      call('/digests/work', { sessionId: 's1', key: 'work-1-x', tools: 0, ...body }).then(
        (r) => r.status
      )
    // The messages: 30 at most, a text of 4,096 characters at most.
    expect(await exchange({ messages: Array.from({ length: 31 }, () => message) })).toBe(400)
    expect(await exchange({ messages: [{ from: 'a', text: 'b'.repeat(4_097) }] })).toBe(400)
    expect(await exchange({ messages: [{ from: 'a'.repeat(257), text: 'b' }] })).toBe(400)
    expect(await exchange({ key: 'anything', messages: [message] })).toBe(400)
    // The notes: 40 at most, a note of 1,024 characters at most.
    expect(await work({ notes: Array.from({ length: 41 }, () => 'n') })).toBe(400)
    expect(await work({ notes: ['n'.repeat(1_025)] })).toBe(400)
    expect(await work({ key: '1-x', notes: ['n'] })).toBe(400)
    expect(asked).toEqual([])
    // The clip's own output passes: 30 messages of 4,001 characters, 40 notes of 601.
    const clipped = { from: 'a', text: `${'b'.repeat(4_000)}…`, request: 'r', reply: 'p' }
    expect(await exchange({ messages: Array.from({ length: 30 }, () => clipped) })).toBe(200)
    expect(await work({ notes: Array.from({ length: 40 }, () => `${'n'.repeat(600)}…`) })).toBe(200)
  })

  it('reads no body past its limit: a digest command over 3 MiB is refused before it is parsed', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const huge = {
      sessionId: 's1',
      key: '1-x',
      messages: [{ from: 'a', text: 'b'.repeat(DIGEST_BODY_LIMIT) }]
    }
    const answer = await call('/digests/exchange', huge)
    expect(answer.status).toBe(413)
    // Streamed without a length, the read stops at the limit: the server
    // answers an error or drops the socket, and the port never sees it.
    const body = JSON.stringify(huge)
    const streamed = await fetch(`${server.url}/digests/work`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        }
      }),
      duplex: 'half'
    } as RequestInit).then(
      (r) => r.status,
      () => 'dropped' as const
    )
    expect(streamed === 'dropped' || streamed >= 400).toBe(true)
    expect(asked).toEqual([])
  })
})
