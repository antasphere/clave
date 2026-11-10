import { afterEach, describe, expect, it } from 'vitest'
import type { HistorySearchResult, ServerHistory } from '@clave/contract/history'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import { HistoryPort, type HistoryService } from './port'

/**
 * The History domain (PRDCT-4321): the conversations a server's tabs ran and
 * a search of their transcripts, behind the bearer token like every route;
 * the search's scopes are checked before the port sees them; whatever the
 * port throws is the declared `CapabilityUnavailable`, never a 500.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (path: string, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  })

const HISTORY: ServerHistory = {
  conversations: [
    {
      conversationId: 'c-1',
      sessionId: 's-1',
      name: 'Release notes',
      title: 'Draft the release notes',
      cwd: '/srv/app',
      model: 'opus',
      groupId: 'g-1',
      groupName: 'Launch',
      workspaceId: 'ws-1',
      firstSeenAt: '2026-11-01T09:00:00.000Z',
      lastHumanAt: '2026-11-02T10:30:00.000Z',
      lastPrompt: 'tighten the intro',
      transcript: 'present',
      held: 'closed',
      launch: { permissionMode: 'plan', effort: 'high', accountId: 'a-1', accountLabel: 'Work' }
    },
    {
      conversationId: 'c-2',
      sessionId: 's-2',
      name: 'Scratch',
      title: null,
      cwd: '/srv/scratch',
      model: null,
      groupId: null,
      groupName: null,
      workspaceId: null,
      firstSeenAt: '2026-11-03T08:00:00.000Z',
      lastHumanAt: '2026-11-03T08:00:00.000Z',
      lastPrompt: null,
      transcript: 'gone',
      held: 'running'
    }
  ]
}

const FOUND: HistorySearchResult = {
  hits: [
    {
      conversationId: 'c-1',
      ts: '2026-11-02T10:30:00.000Z',
      scope: 'human',
      excerpt: 'tighten the intro'
    }
  ],
  filesSearched: 2,
  truncated: false
}

type SearchRequest = Parameters<HistoryService['search']>[0]

/** A port the test drives: what the search was asked. */
function fakePort(): { port: HistoryService; asked: SearchRequest[] } {
  const asked: SearchRequest[] = []
  const port: HistoryService = {
    list: async () => HISTORY,
    search: async (request) => {
      asked.push(request)
      return FOUND
    }
  }
  return { port, asked }
}

describe('the History domain over HTTP', () => {
  it.each([
    ['no port', undefined],
    ['HistoryPort.none', HistoryPort.none]
  ])('%s answers CapabilityUnavailable to the list and the search', async (_, history) => {
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), ...(history && { history }) }
    })
    for (const path of ['/history/list', '/history/search?query=intro']) {
      const answer = await call(path)
      expect(answer.status, path).toBe(422)
      expect(await answer.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'history',
        message: 'This server keeps no History of its own.'
      })
    }
  })

  it('answers the port’s list as it is', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: port } })
    const answer = await call('/history/list')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual(HISTORY)
  })

  it('passes the query, the known scopes and the cap to the port', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: port } })
    const answer = await call('/history/search?query=intro&scopes=agent,bogus,tools&maxHits=25')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual(FOUND)
    expect(asked).toEqual([{ query: 'intro', scopes: ['agent', 'tools'], maxHits: 25 }])
  })

  it('reads human and agent when the search names no scope it knows', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: port } })
    expect((await call('/history/search?query=intro')).status).toBe(200)
    expect((await call('/history/search?query=intro&scopes=bogus,everything')).status).toBe(200)
    expect(asked).toEqual([
      { query: 'intro', scopes: ['human', 'agent'] },
      { query: 'intro', scopes: ['human', 'agent'] }
    ])
  })

  it('refuses a cap outside the contract’s range before the port hears it', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: port } })
    for (const maxHits of ['0', '501', 'many']) {
      const answer = await call(`/history/search?query=intro&maxHits=${maxHits}`)
      expect(answer.status, maxHits).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('a port that throws a plain Error answers CapabilityUnavailable, never a 500', async () => {
    const broken: HistoryService = {
      list: () => Promise.reject(new Error('the ledger is unreadable')),
      search: () => {
        throw new Error('the transcripts are gone')
      }
    }
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: broken } })
    const listed = await call('/history/list')
    expect(listed.status).toBe(422)
    expect(await listed.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'history',
      message: 'the ledger is unreadable'
    })
    const searched = await call('/history/search?query=intro')
    expect(searched.status).toBe(422)
    expect(await searched.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'history',
      message: 'the transcripts are gone'
    })
  })

  it('needs the bearer token on both routes', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), history: port } })
    expect((await call('/history/list', 'wrong')).status).toBe(401)
    expect((await call('/history/search?query=intro', 'wrong')).status).toBe(401)
    expect(asked).toEqual([])
  })
})
