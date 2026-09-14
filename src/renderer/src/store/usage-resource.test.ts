import { describe, it, expect } from 'vitest'
import { createUsageResource } from './usage-resource'

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
