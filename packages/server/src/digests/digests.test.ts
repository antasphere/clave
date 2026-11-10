import { afterEach, describe, expect, it } from 'vitest'
import type { ExchangeDigestRead, WorkDigestRead } from '@clave/contract/digests'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import type { DigestsService } from './port'

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
      return request.key === 'limit'
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
      key: 'k2',
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
      { sessionId: 's1', key: 'k2', messages: [{ from: 'Lane A', text: 'done' }] }
    ])
  })

  it('a read that could not be made is an answer with its reason', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), digests: port } })
    const answer = await call('/digests/exchange', { sessionId: 's1', key: 'limit', messages: [] })
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
    const work = await call('/digests/work', { sessionId: 's1', key: 'w2', notes: ['a'], tools: 2 })
    expect(await work.json()).toMatchObject({ ok: true, title: 'Read the notes' })
    expect(asked).toEqual([{ sessionId: 's1', key: 'w2', notes: ['a'], tools: 2 }])
    const workFiled = await call('/digests/work-of?sessionId=s1')
    expect(await workFiled.json()).toMatchObject({ w1: { title: 'Filed' } })
  })

  it('refuses without the token, and says so on a server with no digests', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await call('/digests/exchanges-of?sessionId=s1', undefined, 'wrong')).status).toBe(401)
    const answer = await call('/digests/exchange', { sessionId: 's1', key: 'k', messages: [] })
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'digests'
    })
  })
})
