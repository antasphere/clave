/**
 * The History's reads of the connected servers (PRDCT-4321): the list and
 * the search never wait on a client's disposal (a hung endpoint lookup must
 * not hold either past the per-server deadline), the last list says which
 * server searches which conversation, and a server's search carries its
 * conversations at most a hundred a request, one request after the other.
 * Electron, the session host and the fleet registry are stubbed out of the
 * import: the sources are injected.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { HistoryConversation } from '@clave/contract/history'
import { sessionKey } from '@clave/contract/fleet'
import type { HistoryListEntry } from './service'

const h = vi.hoisted(() => ({
  userData: '',
  local: [] as unknown[]
}))
h.userData = mkdtempSync(join(tmpdir(), 'clave-host-reads-test-'))
afterAll(() => rmSync(h.userData, { recursive: true, force: true }))

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))
vi.mock('./service', () => ({
  listHistory: () => ({ entries: h.local, skippedLines: 0 }),
  recordFor: vi.fn(),
  restampLaunch: vi.fn()
}))
vi.mock('../pty-manager', () => ({ ptyManager: {} }))
vi.mock('../server/endpoint', () => ({ isServerExternal: () => false }))
vi.mock('../mcp/server-client', () => ({ serverClient: {} }))
vi.mock('../ipc-handlers/server-handlers', () => ({
  serverConnectionRegistry: () => ({ list: () => [], endpoint: vi.fn() })
}))

import {
  historyWithServers,
  SEARCH_IDS_PER_REQUEST,
  searchServers,
  serverOwnerOf
} from './host-reads'
import type { ServerHistorySource } from './fleet-history'

const conv = (conversationId: string): HistoryConversation => ({
  conversationId,
  sessionId: `tab-${conversationId}`,
  name: 'Odoo',
  title: 'Odoo research',
  cwd: '/srv/odoo',
  model: null,
  groupId: null,
  groupName: null,
  workspaceId: null,
  firstSeenAt: '2026-11-01T10:00:00.000Z',
  lastHumanAt: '2026-11-09T10:00:00.000Z',
  lastPrompt: null,
  transcript: 'present',
  held: 'closed'
})

/** A source whose disposal never ends: a hung endpoint lookup. */
function hungSource(
  conversations: HistoryConversation[],
  search: ServerHistorySource['search'] = async () => ({
    hits: [],
    filesSearched: 0,
    truncated: false
  })
): ServerHistorySource & { release: () => Promise<void> } {
  return {
    servers: () => [{ id: 'srv', name: 'Studio' }],
    list: async () => conversations,
    search,
    release: vi.fn(() => new Promise<void>(() => {}))
  }
}

/** The promise's value, or `'held'` when it is still pending after `ms`. */
function within<T>(work: Promise<T>, ms = 1_000): Promise<T | 'held'> {
  return Promise.race([work, new Promise<'held'>((r) => setTimeout(() => r('held'), ms))])
}

describe('the History never waits on a client’s disposal (PRDCT-4321)', () => {
  it('answers the list with a source whose release never resolves', async () => {
    const source = hungSource([conv('s1')])
    const answer = await within(historyWithServers(null, source))
    expect(answer).not.toBe('held')
    const { entries } = answer as Awaited<ReturnType<typeof historyWithServers>>
    expect(entries.map((e) => [e.claudeSessionId, e.server?.id])).toEqual([['s1', 'srv']])
    expect(source.release).toHaveBeenCalledTimes(1)
  })

  it('answers the search with a source whose release never resolves', async () => {
    await historyWithServers(null, hungSource([conv('s1')]))
    const source = hungSource([], async () => ({
      hits: [{ conversationId: 's1', ts: null, scope: 'human', excerpt: 'marigold' }],
      filesSearched: 1,
      truncated: false
    }))
    const onHits = vi.fn()
    const answer = await within(
      searchServers(
        { query: 'marigold', scopes: ['human'], ids: ['s1'] },
        onHits,
        () => false,
        source
      )
    )
    expect(answer).toEqual({ filesSearched: 1, truncated: false })
    expect(onHits).toHaveBeenCalledTimes(1)
    expect(source.release).toHaveBeenCalledTimes(1)
  })
})

describe('a server’s search carries the conversations asked of it (PRDCT-4321)', () => {
  it('names the server of each conversation the last list routed to one, and no other', async () => {
    // This Mac's own record of a tab of the server, which the server's
    // answer does not list (held null): the server cannot search it.
    h.local = [
      {
        source: 'ledger',
        provider: 'claude',
        claudeSessionId: 'unlisted',
        sessionId: sessionKey({ serverId: 'srv', sessionId: 'old-tab' }),
        name: 'Old tab',
        cwd: '/srv/odoo',
        mode: 'claude',
        model: null,
        workspaceId: null,
        groups: [],
        firstSeenAt: '2026-11-01T10:00:00.000Z',
        lastSeenAt: '2026-11-02T10:00:00.000Z',
        closedAt: null,
        transcript: {
          exists: true,
          path: '/shared/unlisted.jsonl',
          cwd: '/srv/odoo',
          firstAt: null,
          title: null,
          lastPrompt: null,
          lastHumanAt: null,
          modifiedAt: null,
          sizeBytes: 10
        },
        title: 'Old tab',
        lastHumanAt: '2026-11-02T10:00:00.000Z'
      } satisfies HistoryListEntry
    ]
    try {
      const { entries } = await historyWithServers(null, hungSource([conv('s1'), conv('s2')]))
      expect(entries.find((e) => e.claudeSessionId === 'unlisted')?.server).toMatchObject({
        id: 'srv',
        online: true,
        held: null
      })
      expect(serverOwnerOf('s1')).toBe('srv')
      expect(serverOwnerOf('s2')).toBe('srv')
      expect(serverOwnerOf('unlisted')).toBeUndefined()
      expect(serverOwnerOf('mac-only')).toBeUndefined()
    } finally {
      h.local = []
    }
  })

  it('asks at most a hundred ids a request, one after the other, and merges the answers', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`)
    await historyWithServers(null, hungSource(ids.map(conv)))
    const asked: string[][] = []
    let inFlight = 0
    let mostInFlight = 0
    const source = hungSource([], async (_serverId, request) => {
      asked.push(request.ids ?? [])
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      const first = request.ids![0]
      return {
        hits: [
          { conversationId: first, ts: null, scope: 'human', excerpt: 'marigold' },
          // A hit on a conversation this request did not name is dropped.
          { conversationId: 'stranger', ts: null, scope: 'human', excerpt: 'marigold' }
        ],
        filesSearched: request.ids!.length,
        truncated: first === 's100'
      }
    })
    const batches: string[][] = []
    const answer = await searchServers(
      { query: 'marigold', scopes: ['human'], ids: ['mac-only', ...ids] },
      (hits) => batches.push(hits.map((h) => h.claudeSessionId)),
      () => false,
      source
    )
    expect(SEARCH_IDS_PER_REQUEST).toBe(100)
    expect(asked.map((a) => a.length)).toEqual([100, 100, 50])
    expect(asked.flat()).toEqual(ids)
    expect(mostInFlight).toBe(1)
    expect(batches).toEqual([['s0'], ['s100'], ['s200']])
    expect(answer).toEqual({ filesSearched: 250, truncated: true })
  })

  it('asks nothing more of a server once the search is cancelled', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `s${i}`)
    await historyWithServers(null, hungSource(ids.map(conv)))
    let cancelled = false
    const search = vi.fn(async () => {
      cancelled = true
      return { hits: [], filesSearched: 100, truncated: false }
    })
    await searchServers(
      { query: 'marigold', scopes: ['human'], ids },
      () => {},
      () => cancelled,
      hungSource([], search)
    )
    expect(search).toHaveBeenCalledTimes(1)
  })
})
