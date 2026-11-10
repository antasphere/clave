import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { HistorySearchResult, ServerHistory } from '@clave/contract/history'
import { startEmbedded, type EmbeddedServer, type HistoryService } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerUnreachable } from './errors'
import { HistoryMissing } from './history'

/**
 * The History domain through the typed client (PRDCT-4321): the list and the
 * search round-trip typed, the scopes travel comma-joined and the cap as a
 * string, a server with nothing behind the port is `CapabilityUnavailable`,
 * and a server older than the domain (the router's 404) is told apart from
 * one that does not answer.
 */
let server: EmbeddedServer | undefined
let old: Server | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  await new Promise((resolve) => (old ? old.close(resolve) : resolve(undefined)))
  api = server = old = undefined
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
      held: 'stopped',
      launch: { dangerous: false, permissionMode: 'plan' }
    }
  ]
}

const FOUND: HistorySearchResult = {
  hits: [{ conversationId: 'c-1', ts: null, scope: 'tools', excerpt: 'npm run build' }],
  filesSearched: 1,
  truncated: true
}

type SearchRequest = Parameters<HistoryService['search']>[0]

/** A server whose History the test drives: what its search was asked. */
async function withHistory(): Promise<SearchRequest[]> {
  const asked: SearchRequest[] = []
  server = await startEmbedded({
    ports: {
      sessions: new FakeSource(),
      history: {
        list: async () => HISTORY,
        search: async (request) => {
          asked.push(request)
          return FOUND
        }
      }
    }
  })
  api = createApiClient({ url: server.url, token: server.token })
  return asked
}

describe('the History domain of the client', () => {
  it('reads the server’s list typed', async () => {
    await withHistory()
    expect(await api!.history.list()).toEqual(HISTORY)
  })

  it('sends the scopes comma-joined and the cap, and reads the hits typed', async () => {
    const asked = await withHistory()
    expect(
      await api!.history.search({ query: 'build', scopes: ['agent', 'tools'], maxHits: 40 })
    ).toEqual(FOUND)
    expect(await api!.history.search({ query: 'build' })).toEqual(FOUND)
    expect(asked).toEqual([
      { query: 'build', scopes: ['agent', 'tools'], maxHits: 40 },
      { query: 'build', scopes: ['human', 'agent'] }
    ])
  })

  it('sends the asked conversations comma-joined, and none when the list is empty', async () => {
    const asked = await withHistory()
    await api!.history.search({ query: 'build', ids: ['c-1', 'c-2'] })
    await api!.history.search({ query: 'build', ids: [] })
    expect(asked).toEqual([
      { query: 'build', scopes: ['human', 'agent'], ids: ['c-1', 'c-2'] },
      { query: 'build', scopes: ['human', 'agent'] }
    ])
  })

  it('hears a server with nothing behind the port as CapabilityUnavailable', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.history.list()).rejects.toBeInstanceOf(CapabilityUnavailable)
    await expect(api.history.search({ query: 'x' })).rejects.toBeInstanceOf(CapabilityUnavailable)
  })

  it('tells an older server, whose router answers 404, as HistoryMissing', async () => {
    // What a server released before PRDCT-4321 answers for a route it does not have.
    old = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer t') {
        response.writeHead(401).end()
        return
      }
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    })
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    const { port } = old.address() as { port: number }
    api = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't' })
    await expect(api.history.list()).rejects.toBeInstanceOf(HistoryMissing)
    await expect(api.history.search({ query: 'x', scopes: ['human'] })).rejects.toBeInstanceOf(
      HistoryMissing
    )
  })

  it('keeps a server that does not answer apart from an older one', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 2_000 })
    await expect(api.history.list()).rejects.toBeInstanceOf(ServerUnreachable)
  })
})
