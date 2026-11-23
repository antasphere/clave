import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRESENT_REFUSALS_MAX,
  PRESENT_RESTARTS_MAX,
  createPresenter,
  type PresenterDeps
} from './artefact-presenter-core'

/**
 * The window's side of a presentation (PRDCT-4980): its own hold, the
 * address handed to main, and the moments it lets go.
 */
interface Fake {
  deps: PresenterDeps
  calls: unknown[][]
  artefacts: Record<string, { openedAt: string; title: string }>
  shown: Record<string, string>
  refuse: { on: boolean }
  holds: number
}

function fake(): Fake {
  const calls: unknown[][] = []
  const artefacts: Fake['artefacts'] = { s1: { openedAt: 'o1', title: 'deck' } }
  const shown: Fake['shown'] = {}
  const refuse = { on: false }
  const urls = new Map<string, string>()
  const f: Fake = {
    calls,
    artefacts,
    shown,
    refuse,
    holds: 0,
    deps: {
      hold: async (sessionId, holdId) => {
        calls.push(['hold', sessionId, holdId])
        if (refuse.on) throw new Error('This session has no artefact open.')
        // A renewal answers the preview it holds; a new hold, a preview of its own.
        const known = holdId === undefined ? undefined : urls.get(holdId)
        if (holdId !== undefined && known) return { holdId, url: known, ttlMs: 90_000 }
        f.holds += 1
        const id = `h${f.holds}`
        urls.set(id, `http://127.0.0.1:${4100 + f.holds}/`)
        return { holdId: id, url: urls.get(id)!, ttlMs: 90_000 }
      },
      release: async (sessionId, holdId) => void calls.push(['release', sessionId, holdId]),
      show: async (sessionId, url, title) => void calls.push(['show', sessionId, url, title]),
      close: async (sessionId) => void calls.push(['close', sessionId]),
      artefact: (sessionId) => artefacts[sessionId],
      shown: (sessionId) => shown[sessionId] ?? 'live',
      now: () => Date.now()
    }
  }
  return f
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a presentation', () => {
  it('presents nothing for a session with no artefact', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    expect(p.present('s9')).toBe(false)
    await settle()
    expect(f.calls).toEqual([])
    expect(p.isPresenting('s9')).toBe(false)
  })

  it('holds the preview itself and hands main the address without Slideless’s bar', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    expect(p.present('s1')).toBe(true)
    await settle()
    expect(f.calls).toEqual([
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck']
    ])
    expect(p.isPresenting('s1')).toBe(true)
  })

  it('renews its hold while it runs, and a second ask brings it forward without a second hold', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.calls.filter((c) => c[0] === 'hold')).toEqual([
      ['hold', 's1', undefined],
      ['hold', 's1', 'h1']
    ])
    f.calls.length = 0
    p.present('s1')
    await settle()
    expect(f.calls).toEqual([['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck']])
  })

  it('lets go of its hold when main says the window closed, and holds no more', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.closed('s1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.calls.slice(2)).toEqual([['release', 's1', 'h1']])
    expect(p.isPresenting('s1')).toBe(false)
  })

  it('ends, window and hold, when the artefact is closed', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.artefactChanged('s1', null)
    await settle()
    expect(f.calls.slice(2)).toEqual([
      ['release', 's1', 'h1'],
      ['close', 's1']
    ])
    expect(p.isPresenting('s1')).toBe(false)
  })

  it('follows a new open by the agent: the old hold goes, a new one is taken', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    f.artefacts.s1 = { openedAt: 'o2', title: 'talk' }
    p.artefactChanged('s1', { openedAt: 'o1' })
    await settle()
    expect(f.calls.length).toBe(2)
    p.artefactChanged('s1', f.artefacts.s1)
    await settle()
    expect(f.calls.slice(2)).toEqual([
      ['release', 's1', 'h1'],
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4102/?bar=0', 'talk']
    ])
  })

  it('follows the version the panel shows', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.versionChanged('s1')
    expect(f.calls.length).toBe(2)
    f.shown.s1 = '3'
    p.versionChanged('s1')
    await settle()
    expect(f.calls.slice(2)).toEqual([['show', 's1', 'http://127.0.0.1:4101/?bar=0&v=3', 'deck']])
  })

  it('holds again when the preview dies, and ends when it keeps dying', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    for (let i = 0; i < PRESENT_RESTARTS_MAX; i++) {
      p.previewExited('s1')
      await settle()
    }
    expect(f.calls.filter((c) => c[0] === 'show').length).toBe(PRESENT_RESTARTS_MAX + 1)
    expect(p.isPresenting('s1')).toBe(true)
    p.previewExited('s1')
    await settle()
    expect(p.isPresenting('s1')).toBe(false)
    expect(f.calls.at(-1)).toEqual(['close', 's1'])
  })

  it('tries a refused first hold again for a while, then gives up without a window', async () => {
    const f = fake()
    f.refuse.on = true
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    await vi.advanceTimersByTimeAsync(10_000 * PRESENT_REFUSALS_MAX)
    expect(f.calls.filter((c) => c[0] === 'hold').length).toBe(PRESENT_REFUSALS_MAX)
    expect(p.isPresenting('s1')).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.calls.filter((c) => c[0] === 'hold').length).toBe(PRESENT_REFUSALS_MAX)
    expect(f.calls.some((c) => c[0] === 'show' || c[0] === 'close')).toBe(false)
  })

  it('presents once Slideless answers within that while', async () => {
    const f = fake()
    f.refuse.on = true
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    f.refuse.on = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.calls.filter((c) => c[0] === 'show')).toEqual([
      ['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck']
    ])
  })
})
