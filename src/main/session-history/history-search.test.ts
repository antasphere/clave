/**
 * The History's search across this Mac and its servers (PRDCT-4321): a
 * conversation the last list routed to a server is searched there only, the
 * rest on this Mac, the totals of both halves added; and the cancel
 * bookkeeping: a cancel while the search runs reaches the servers' half, a
 * cancel after its end is not kept, and the end forgets the search either way.
 */
import { describe, expect, it, vi } from 'vitest'
import type { HistorySearchScope } from '@clave/contract/history'
import { SearchCancels, runHistorySearch, type HistorySearchDeps } from './history-search'
import type { SearchProgress } from './service'

const hit = (claudeSessionId: string): SearchProgress['hits'][number] => ({
  claudeSessionId,
  ts: null,
  scope: 'human',
  excerpt: 'marigold'
})

function deps(over: Partial<HistorySearchDeps> = {}): HistorySearchDeps & {
  sent: SearchProgress[]
  searchLocal: ReturnType<typeof vi.fn>
  searchServers: ReturnType<typeof vi.fn>
} {
  const sent: SearchProgress[] = []
  const owners: Record<string, string> = { 'conv-srv-a': 'a', 'conv-srv-b': 'b' }
  const searchLocal = vi.fn(async (request: unknown, send: (p: SearchProgress) => void) => {
    const r = request as { requestId: string }
    send({ requestId: r.requestId, hits: [hit('conv-mac')] })
    return { requestId: r.requestId, filesSearched: 2, truncated: false }
  })
  const searchServers = vi.fn(
    async (
      _request: { query: string; scopes: HistorySearchScope[]; ids: readonly string[] },
      onHits: (hits: SearchProgress['hits']) => void
    ) => {
      onHits([hit('conv-srv-a')])
      return { filesSearched: 3, truncated: true }
    }
  )
  return {
    searchLocal,
    searchServers,
    serverOwnerOf: (id) => owners[id],
    send: (progress) => sent.push(progress),
    cancels: new SearchCancels(),
    sent,
    ...over
  } as HistorySearchDeps & {
    sent: SearchProgress[]
    searchLocal: ReturnType<typeof vi.fn>
    searchServers: ReturnType<typeof vi.fn>
  }
}

const request = {
  requestId: 'req-1',
  query: 'marigold',
  scopes: ['human', 'agent', 'nonsense'],
  claudeSessionIds: ['conv-mac', 'conv-srv-a', 'conv-srv-b', 'conv-mac-2', 42]
}

describe('runHistorySearch (PRDCT-4321)', () => {
  it('searches on this Mac only the ids no server holds, and the routed ones on the servers', async () => {
    const d = deps()
    await runHistorySearch(request, d)
    expect(d.searchLocal).toHaveBeenCalledTimes(1)
    expect(d.searchLocal.mock.calls[0][0]).toMatchObject({
      requestId: 'req-1',
      query: 'marigold',
      claudeSessionIds: ['conv-mac', 'conv-mac-2']
    })
    expect(d.searchServers).toHaveBeenCalledTimes(1)
    expect(d.searchServers.mock.calls[0][0]).toEqual({
      query: 'marigold',
      scopes: ['human', 'agent'],
      ids: ['conv-srv-a', 'conv-srv-b']
    })
  })

  it('adds up both halves’ totals and sends both halves’ hits under the request’s id', async () => {
    const d = deps()
    expect(await runHistorySearch(request, d)).toEqual({
      requestId: 'req-1',
      filesSearched: 5,
      truncated: true
    })
    expect(d.sent).toEqual([
      { requestId: 'req-1', hits: [hit('conv-mac')] },
      { requestId: 'req-1', hits: [hit('conv-srv-a')] }
    ])
  })

  it('asks no server for a request with no id', async () => {
    const d = deps()
    const done = await runHistorySearch({ ...request, requestId: undefined }, d)
    expect(d.searchServers).not.toHaveBeenCalled()
    expect(done.filesSearched).toBe(2)
  })

  it('lets the servers’ half see a cancel made while the search runs', async () => {
    let release!: () => void
    const seen: boolean[] = []
    const d = deps({
      searchServers: vi.fn(async (_request, _onHits, cancelled) => {
        seen.push(cancelled())
        await new Promise<void>((resolve) => {
          release = resolve
        })
        seen.push(cancelled())
        return { filesSearched: 0, truncated: false }
      })
    })
    const running = runHistorySearch(request, d)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    d.cancels.cancel('req-1')
    release()
    await running
    expect(seen).toEqual([false, true])
    expect(d.cancels.isCancelled('req-1')).toBe(false)
  })

  it('keeps no cancel that arrives after the search ended, so a reused id runs whole', async () => {
    const d = deps()
    await runHistorySearch(request, d)
    d.cancels.cancel('req-1')
    expect(d.cancels.isCancelled('req-1')).toBe(false)
    const seen: boolean[] = []
    d.searchServers.mockImplementationOnce(async (_request, _onHits, cancelled) => {
      seen.push(cancelled())
      return { filesSearched: 0, truncated: false }
    })
    await runHistorySearch(request, d)
    expect(seen).toEqual([false])
  })
})

describe('SearchCancels', () => {
  it('keeps a cancel only for a search in flight', () => {
    const c = new SearchCancels()
    c.cancel('x')
    expect(c.isCancelled('x')).toBe(false)
    c.begin('x')
    c.cancel('x')
    expect(c.isCancelled('x')).toBe(true)
  })

  it('forgets both the search and its cancel at its end', () => {
    const c = new SearchCancels()
    c.begin('x')
    c.cancel('x')
    c.end('x')
    expect(c.isCancelled('x')).toBe(false)
    // No longer in flight: a later cancel is not kept either.
    c.cancel('x')
    expect(c.isCancelled('x')).toBe(false)
  })

  it('starts a search again uncancelled', () => {
    const c = new SearchCancels()
    c.begin('x')
    c.cancel('x')
    c.begin('x')
    expect(c.isCancelled('x')).toBe(false)
  })
})
