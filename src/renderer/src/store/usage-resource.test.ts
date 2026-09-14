import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageResource } from './usage-resource'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('shared provider usage cache', () => {
  it('deduplicates footer/panel requests, caches, and allows manual refresh', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValue({ windows: [1] })
    const store = createUsageResource(fetcher)
    await Promise.all([store.getState().load(), store.getState().load()])
    await store.getState().load()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await store.getState().load({ force: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.getState()).toMatchObject({
      status: 'ready',
      data: { windows: [1] },
      refreshing: false
    })
  })

  it('late responses and errors stay in their own provider, never showing stale quota', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string) => void
    const claude = createUsageResource(
      () =>
        new Promise<string>((r) => {
          resolve = r
        })
    )
    const fetchCodex = vi.fn().mockResolvedValue('codex')
    const codex = createUsageResource(fetchCodex)
    const pending = claude.getState().load()
    await codex.getState().load()
    resolve('claude')
    await pending
    expect(codex.getState().data).toBe('codex')
    fetchCodex.mockRejectedValue(new Error('Offline'))
    await codex.getState().load({ force: true })
    expect(codex.getState()).toMatchObject({ status: 'error', data: null, error: 'Offline' })
    expect(claude.getState().data).toBe('claude')
  })

  it('recovers from a synchronous failure and cancels a scheduled retry on manual success', async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Missing bridge')
      })
      .mockResolvedValue('ok')
    const store = createUsageResource(fetcher)
    await store.getState().load()
    expect(store.getState().status).toBe('error')
    await store.getState().load({ force: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.getState().data).toBe('ok')
  })
})

/**
 * A result pushed from outside (main's poll) is the current read, and a
 * pushed error clears the previous read: "Failed reads never masquerade as a
 * zero or a current quota" holds on the push path as it does on the load path.
 */
describe('a pushed result', () => {
  it('becomes the current read without a request', async () => {
    let fetches = 0
    const store = createUsageResource(async () => {
      fetches++
      return { n: fetches }
    })
    store.getState().publish({ n: 42 })
    expect(store.getState()).toMatchObject({ status: 'ready', data: { n: 42 }, error: null })
    expect(fetches).toBe(0)
    // Fresh: a plain load right after keeps the pushed read.
    await store.getState().load()
    expect(store.getState().data).toEqual({ n: 42 })
    expect(fetches).toBe(0)
  })

  it('as an error, clears the read that was there', () => {
    const store = createUsageResource(async () => ({ n: 1 }))
    store.getState().publish({ n: 1 })
    store.getState().publishError('This token was refused.')
    expect(store.getState()).toMatchObject({
      status: 'error',
      data: null,
      error: 'This token was refused.'
    })
  })

  it('tells the fetcher whether the load was forced', async () => {
    const seen: boolean[] = []
    const store = createUsageResource(async ({ force }) => {
      seen.push(force)
      return { ok: true }
    })
    await store.getState().load()
    await store.getState().load({ force: true })
    expect(seen).toEqual([false, true])
  })
})
