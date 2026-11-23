import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRESENT_ASK_WAIT_MS,
  PRESENT_REFUSALS_MAX,
  PRESENT_RESTARTS_MAX,
  createPresenter,
  wirePresenter,
  type PresenterDeps,
  type PresenterWiring
} from './artefact-presenter-core'

/**
 * The window's side of a presentation (PRDCT-4980): its own hold, the
 * address handed to main, the moments it lets go, and the wiring that
 * decides which asks are this window's.
 */
interface Fake {
  deps: PresenterDeps
  calls: unknown[][]
  artefacts: Record<string, { openedAt: string; title: string }>
  shown: Record<string, string>
  refuse: { on: boolean }
  /** What main answers a show: taken (true) or not this window's (false). */
  taken: { value: boolean | 'throws' }
  holds: number
}

function fake(): Fake {
  const calls: unknown[][] = []
  const artefacts: Fake['artefacts'] = { s1: { openedAt: 'o1', title: 'deck' } }
  const shown: Fake['shown'] = {}
  const refuse = { on: false }
  const taken: Fake['taken'] = { value: true }
  const urls = new Map<string, string>()
  let ids = 0
  const f: Fake = {
    calls,
    artefacts,
    shown,
    refuse,
    taken,
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
      show: async (sessionId, url, title, presentationId) => {
        calls.push(['show', sessionId, url, title, presentationId])
        if (taken.value === 'throws') throw new Error('refused')
        return taken.value
      },
      close: async (sessionId) => void calls.push(['close', sessionId]),
      artefact: (sessionId) => artefacts[sessionId],
      shown: (sessionId) => shown[sessionId] ?? 'live',
      newId: () => `p${++ids}`,
      now: () => Date.now()
    }
  }
  return f
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const of = (f: Fake, kind: string): unknown[][] => f.calls.filter((c) => c[0] === kind)

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
      ['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck', 'p1']
    ])
    expect(p.isPresenting('s1')).toBe(true)
  })

  it('renews its hold while it runs, and a second ask brings it forward without a second hold', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(of(f, 'hold')).toEqual([
      ['hold', 's1', undefined],
      ['hold', 's1', 'h1']
    ])
    f.calls.length = 0
    p.present('s1')
    await settle()
    expect(f.calls).toEqual([['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck', 'p1']])
  })

  it('lets go when main says THIS presentation closed, and not for another one', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.closed('s1', 'p0')
    expect(p.isPresenting('s1')).toBe(true)
    p.closed('s1', 'p1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.calls.slice(2)).toEqual([['release', 's1', 'h1']])
    expect(p.isPresenting('s1')).toBe(false)
  })

  it('lets go of its hold, and closes nothing, when another window presents it', async () => {
    const f = fake()
    f.taken.value = false
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.calls).toEqual([
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck', 'p1'],
      ['release', 's1', 'h1']
    ])
    expect(p.isPresenting('s1')).toBe(false)
  })

  it('lets go when main refuses the show', async () => {
    const f = fake()
    f.taken.value = 'throws'
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    expect(f.calls.at(-1)).toEqual(['release', 's1', 'h1'])
    expect(p.isPresenting('s1')).toBe(false)
  })

  it('ends, window and hold, when the server says the artefact closed', async () => {
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

  it('keeps going when the window’s list misses the session for a while', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.artefactListed('s1', undefined)
    await settle()
    expect(f.calls.length).toBe(2)
    expect(p.isPresenting('s1')).toBe(true)
  })

  it('follows a new open by the agent: the old hold goes, a new one is taken, same presentation', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.artefactChanged('s1', { openedAt: 'o1' })
    await settle()
    expect(f.calls.length).toBe(2)
    f.artefacts.s1 = { openedAt: 'o2', title: 'talk' }
    p.artefactChanged('s1', f.artefacts.s1)
    await settle()
    expect(f.calls.slice(2)).toEqual([
      ['release', 's1', 'h1'],
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4102/?bar=0', 'talk', 'p1']
    ])
    f.artefacts.s1 = { openedAt: 'o3', title: 'talk' }
    p.artefactListed('s1', f.artefacts.s1)
    await settle()
    expect(f.calls.slice(5)).toEqual([
      ['release', 's1', 'h2'],
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4103/?bar=0', 'talk', 'p1']
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
    expect(f.calls.slice(2)).toEqual([
      ['show', 's1', 'http://127.0.0.1:4101/?bar=0&v=3', 'deck', 'p1']
    ])
  })

  it('holds again when the preview dies, letting go of the old hold, and ends when it keeps dying', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.previewExited('s1')
    await settle()
    expect(f.calls.slice(2)).toEqual([
      ['release', 's1', 'h1'],
      ['hold', 's1', undefined],
      ['show', 's1', 'http://127.0.0.1:4102/?bar=0', 'deck', 'p1']
    ])
    for (let i = 1; i < PRESENT_RESTARTS_MAX; i++) {
      p.previewExited('s1')
      await settle()
    }
    expect(of(f, 'show').length).toBe(PRESENT_RESTARTS_MAX + 1)
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
    expect(of(f, 'hold').length).toBe(PRESENT_REFUSALS_MAX)
    expect(p.isPresenting('s1')).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(of(f, 'hold').length).toBe(PRESENT_REFUSALS_MAX)
    expect(f.calls.some((c) => c[0] === 'show' || c[0] === 'close')).toBe(false)
  })

  it('closes the window it put up when the preview, held again, keeps being refused', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    f.refuse.on = true
    p.previewExited('s1')
    await settle()
    await vi.advanceTimersByTimeAsync(10_000 * PRESENT_REFUSALS_MAX)
    expect(p.isPresenting('s1')).toBe(false)
    expect(f.calls.at(-1)).toEqual(['close', 's1'])
  })

  it('presents once Slideless answers within that while', async () => {
    const f = fake()
    f.refuse.on = true
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    f.refuse.on = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(of(f, 'show')).toEqual([['show', 's1', 'http://127.0.0.1:4101/?bar=0', 'deck', 'p1']])
  })

  it('a presentation started again after it closed is a new one', async () => {
    const f = fake()
    const p = createPresenter(f.deps)
    p.present('s1')
    await settle()
    p.closed('s1', 'p1')
    p.present('s1')
    await settle()
    expect(of(f, 'show').map((c) => c[4])).toEqual(['p1', 'p2'])
  })
})

interface Wired {
  listeners: {
    asked: Set<(sessionId: string) => void>
    closed: Set<(closed: { sessionId: string; presentationId: string }) => void>
    exited: Set<(sessionId: string) => void>
    changed: Set<(change: { sessionId: string; artefact: { openedAt: string } | null }) => void>
    list: Set<() => void>
  }
  seen: unknown[][]
  listed: Record<string, { openedAt: string }>
  off: () => void
}

/** The window's side: what it hears, wired to a presenter it can watch. */
function wiring(shows: Set<string>): Wired {
  const listeners = {
    asked: new Set<(sessionId: string) => void>(),
    closed: new Set<(closed: { sessionId: string; presentationId: string }) => void>(),
    exited: new Set<(sessionId: string) => void>(),
    changed: new Set<
      (change: { sessionId: string; artefact: { openedAt: string } | null }) => void
    >(),
    list: new Set<() => void>()
  }
  const on =
    <T>(set: Set<T>) =>
    (cb: T): (() => void) => {
      set.add(cb)
      return () => set.delete(cb)
    }
  const seen: unknown[][] = []
  const listed: Record<string, { openedAt: string }> = {}
  const presenter = {
    present: (id: string) => (seen.push(['present', id]), !!listed[id]),
    isPresenting: () => false,
    closed: (id: string, pid: string) => void seen.push(['closed', id, pid]),
    previewExited: (id: string) => void seen.push(['exited', id]),
    artefactChanged: (id: string, a: { openedAt: string } | null) =>
      void seen.push(['changed', id, a]),
    artefactListed: (id: string, a: { openedAt: string } | undefined) =>
      void seen.push(['listed', id, a]),
    versionChanged: (id: string) => void seen.push(['version', id]),
    sessions: () => ['s1']
  }
  const w: PresenterWiring = {
    presenter,
    shows: (id) => shows.has(id),
    listed: (id) => listed[id],
    onPresentRequested: on(listeners.asked),
    onClosed: on(listeners.closed),
    onPreviewExited: on(listeners.exited),
    onChanged: on(listeners.changed),
    onListChanged: on(listeners.list)
  }
  const off = wirePresenter(w)
  return { listeners, seen, listed, off }
}

describe('the window’s wiring', () => {
  it('takes an agent’s ask only for a session the window lists', () => {
    const { listeners, seen, listed } = wiring(new Set(['s1']))
    listed.s1 = { openedAt: 'o1' }
    listeners.asked.forEach((cb) => cb('s2'))
    listeners.asked.forEach((cb) => cb('s1'))
    expect(seen).toEqual([['present', 's1']])
  })

  it('routes main’s close with its presentation, the preview’s death and the server’s change', () => {
    const { listeners, seen } = wiring(new Set())
    listeners.closed.forEach((cb) => cb({ sessionId: 's1', presentationId: 'p1' }))
    listeners.exited.forEach((cb) => cb('s1'))
    listeners.changed.forEach((cb) => cb({ sessionId: 's1', artefact: null }))
    expect(seen).toEqual([
      ['closed', 's1', 'p1'],
      ['exited', 's1'],
      ['changed', 's1', null]
    ])
  })

  it('hands the list to the presentations it runs: what is listed, and the version', () => {
    const { listeners, seen, listed } = wiring(new Set())
    listed.s1 = { openedAt: 'o2' }
    listeners.list.forEach((cb) => cb())
    expect(seen).toEqual([
      ['listed', 's1', { openedAt: 'o2' }],
      ['version', 's1']
    ])
  })

  it('an ask that comes before its artefact is listed presents once it is, within its wait', () => {
    const { listeners, seen, listed } = wiring(new Set(['s1', 's2']))
    listeners.asked.forEach((cb) => cb('s1'))
    listeners.asked.forEach((cb) => cb('s2'))
    listed.s1 = { openedAt: 'o1' }
    listeners.list.forEach((cb) => cb())
    expect(seen.filter((c) => c[0] === 'present')).toEqual([
      ['present', 's1'],
      ['present', 's2'],
      ['present', 's1']
    ])
    vi.advanceTimersByTime(PRESENT_ASK_WAIT_MS)
    listed.s2 = { openedAt: 'o1' }
    listeners.list.forEach((cb) => cb())
    expect(seen.filter((c) => c[0] === 'present').length).toBe(3)
  })

  it('hears nothing once unsubscribed', () => {
    const { listeners, seen, listed, off } = wiring(new Set(['s1']))
    listed.s1 = { openedAt: 'o1' }
    off()
    listeners.asked.forEach((cb) => cb('s1'))
    listeners.closed.forEach((cb) => cb({ sessionId: 's1', presentationId: 'p1' }))
    listeners.list.forEach((cb) => cb())
    expect(seen).toEqual([])
  })
})
