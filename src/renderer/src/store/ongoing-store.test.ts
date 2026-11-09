/**
 * Two windows saving the ongoing list at the same instant (PRDCT-4208): each
 * window is its own copy of this module, and the saved list is one key in
 * main's preferences. The read and the write run under a lock the windows
 * share, so neither writes from a read the other has already moved past.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OngoingEntry } from '../lib/ongoing'

const g = globalThis as unknown as Record<string, unknown>

/** main's preferences, slow enough that two windows' reads interleave. */
function fakePreferences(): { saved: () => unknown } {
  let value: unknown = []
  const later = <T>(v: () => T): Promise<T> =>
    new Promise((r) => setTimeout(() => r(v()), Math.random() * 4))
  g.window = {
    electronAPI: {
      preferencesGet: () => later(() => structuredClone(value)),
      preferencesSet: (_key: string, next: unknown) =>
        later(() => {
          value = structuredClone(next)
        })
    }
  }
  return { saved: () => value }
}

/** The Web Locks API as the windows of one origin share it: one holder per
 *  name, the others queued in order. */
function fakeLocks(): void {
  const tails = new Map<string, Promise<unknown>>()
  const locks = {
    request: (name: string, work: () => Promise<unknown>) => {
      const prev = tails.get(name) ?? Promise.resolve()
      const run = prev.then(() => work())
      tails.set(
        name,
        run.catch(() => {})
      )
      return run
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true })
}

/** One window: a fresh copy of the store module. */
async function openWindow(): Promise<typeof import('./ongoing-store')> {
  vi.resetModules()
  return import('./ongoing-store')
}

const entry = (id: string): OngoingEntry => ({
  id,
  workspaceId: null,
  sessionId: `tab-${id}`,
  provider: 'claude',
  conversationId: `conv-${id}`,
  name: id,
  cwd: '/work',
  note: '',
  originGroup: null,
  addedAt: 1,
  launch: {}
})

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true })
})

describe('two windows saving the ongoing list at once', () => {
  it('loses no change when both save at the same instant', async () => {
    const prefs = fakePreferences()
    fakeLocks()
    const one = await openWindow()
    const two = await openWindow()
    const writes: Promise<void>[] = []
    for (let i = 0; i < 12; i++) {
      writes.push(one.useOngoingStore.getState().update((list) => [...list, entry(`a${i}`)]))
      writes.push(two.useOngoingStore.getState().update((list) => [...list, entry(`b${i}`)]))
    }
    await Promise.all(writes)
    const ids = (prefs.saved() as OngoingEntry[]).map((e) => e.id).sort()
    expect(ids).toHaveLength(24)
  })

  it('still saves in a window without the lock API', async () => {
    const prefs = fakePreferences()
    const one = await openWindow()
    await one.useOngoingStore.getState().update((list) => [...list, entry('solo')])
    expect((prefs.saved() as OngoingEntry[]).map((e) => e.id)).toEqual(['solo'])
  })

  it('saves unlocked when the lock is refused, rather than losing the change', async () => {
    const prefs = fakePreferences()
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: { request: () => Promise.reject(new Error('SecurityError')) } },
      configurable: true
    })
    const one = await openWindow()
    await one.useOngoingStore.getState().update((list) => [...list, entry('refused')])
    expect((prefs.saved() as OngoingEntry[]).map((e) => e.id)).toEqual(['refused'])
  })
})

describe('what another window tells this one', () => {
  it('reads an ended tab off the message, and nothing else as one', async () => {
    const { endedOf } = await openWindow()
    expect(endedOf({ ended: 'tab-1' })).toBe('tab-1')
    expect(endedOf('changed')).toBeNull()
    expect(endedOf({ ended: '' })).toBeNull()
    expect(endedOf(null)).toBeNull()
  })
})
