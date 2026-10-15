/**
 * A launch's restore brings many records back at once (PRDCT-3527): every
 * row placed from its record before any spawn answers, marked restoring; a
 * few spawns in flight, never one after the other and never all of them;
 * each tab settled the moment its spawn answers, a spawn that hangs holding
 * back only itself; a failed spawn's row removed; the first tab focused when
 * asked; one kernel read for all of them.
 * The store reads localStorage and the preload bridge at import time, so
 * both are stubbed first, as server-layout-apply.test.ts does.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../../preload/index.d'
import type { Session } from '../store/session-types'

let useSessionStore: typeof import('../store/session-store').useSessionStore
let placeRecords: typeof import('./adopt-record').placeRecords
let RESTORE_CONCURRENCY: number

/** Each spawn waits for the test to answer it, by session id. */
const pending = new Map<string, (ok: boolean) => void>()
let inFlight = 0
let maxInFlight = 0
let listCalls = 0

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async () => undefined,
    captureTabClosed: () => {},
    sessionsList: async () => {
      listCalls++
      return []
    },
    spawnSession: (cwd: string, options: { adoptSessionId: string }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve, reject) => {
        pending.set(options.adoptSessionId, (ok) => {
          inFlight--
          pending.delete(options.adoptSessionId)
          if (!ok) return reject(new Error('refused'))
          resolve({
            id: options.adoptSessionId,
            cwd,
            folderName: 'w',
            alive: true,
            claudeSessionId: null,
            piSessionId: null
          })
        })
      })
    }
  }
  useSessionStore = (await import('../store/session-store')).useSessionStore
  const lib = await import('./adopt-record')
  placeRecords = lib.placeRecords
  RESTORE_CONCURRENCY = lib.RESTORE_CONCURRENCY
})

beforeEach(() => {
  useSessionStore.setState({ sessions: [], selectedSessionIds: [], focusedSessionId: null })
  pending.clear()
  inFlight = 0
  maxInFlight = 0
  listCalls = 0
})

const record = (id: string): SessionRecord =>
  ({ id, cwd: '/w', folderName: 'w', claudeMode: true, live: false }) as SessionRecord
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const ids = (): string[] => useSessionStore.getState().sessions.map((s) => s.id)
const restoring = (): string[] =>
  useSessionStore
    .getState()
    .sessions.filter((s) => s.restoring)
    .map((s) => s.id)

describe('placeRecords', () => {
  it('shows every row from its record before any spawn answers', async () => {
    const records = Array.from({ length: 20 }, (_, i) => record(`s${i}`))
    const { placed, attached } = placeRecords(records, null)
    expect(placed).toEqual(records.map((r) => r.id))
    expect(ids()).toEqual(records.map((r) => r.id))
    expect(restoring()).toEqual(records.map((r) => r.id))
    let done = false
    void attached.then(() => (done = true))
    while (!done) {
      await flush()
      for (const answer of [...pending.values()]) answer(true)
    }
    expect(await attached).toHaveLength(20)
    expect(restoring()).toEqual([])
    expect(useSessionStore.getState().sessions.every((s) => s.alive)).toBe(true)
  })

  it('keeps a few spawns in flight, never one at a time and never all at once', async () => {
    const records = Array.from({ length: 20 }, (_, i) => record(`s${i}`))
    const { attached } = placeRecords(records, null)
    await flush()
    expect(inFlight).toBe(RESTORE_CONCURRENCY)
    expect(RESTORE_CONCURRENCY).toBeGreaterThan(1)
    while (pending.size > 0) {
      for (const answer of [...pending.values()]) answer(true)
      await flush()
    }
    expect(await attached).toHaveLength(20)
    expect(maxInFlight).toBe(RESTORE_CONCURRENCY)
    expect(listCalls).toBe(1)
  })

  it('settles each tab when its spawn answers, a hung spawn holding back only itself', async () => {
    const { attached } = placeRecords([record('slow'), record('a'), record('b')], null)
    await flush()
    pending.get('a')!(true)
    pending.get('b')!(true)
    await flush()
    expect(restoring()).toEqual(['slow'])
    pending.get('slow')!(true)
    expect((await attached).sort()).toEqual(['a', 'b', 'slow'])
    expect(restoring()).toEqual([])
  })

  it('removes the row of a record whose spawn fails, and settles the rest', async () => {
    const { attached } = placeRecords([record('bad'), record('good')], null)
    await flush()
    pending.get('bad')!(false)
    pending.get('good')!(true)
    expect(await attached).toEqual(['good'])
    expect(ids()).toEqual(['good'])
  })

  it('a chat that is not running comes back dormant; a live one does not', async () => {
    const chat = { ...record('chat'), transport: 'events' } as SessionRecord
    const running = { ...record('running'), transport: 'events', live: true } as SessionRecord
    const { attached } = placeRecords([chat, running], null)
    await flush()
    for (const answer of [...pending.values()]) answer(true)
    await attached
    const byId = (id: string): Session | undefined =>
      useSessionStore.getState().sessions.find((s) => s.id === id)
    expect(byId('chat')?.dormant).toBe(true)
    expect(byId('running')?.dormant).toBeUndefined()
  })

  it('focuses the first row placed when asked, and only that one', async () => {
    const { attached } = placeRecords([record('x'), record('y')], null, { focusFirst: true })
    expect(useSessionStore.getState().selectedSessionIds).toEqual(['x'])
    await flush()
    for (const answer of [...pending.values()]) answer(true)
    await attached
    expect(useSessionStore.getState().selectedSessionIds).toEqual(['x'])
  })

  it('focuses nothing unless asked', async () => {
    const { attached } = placeRecords([record('x')], null)
    await flush()
    pending.get('x')!(true)
    await attached
    expect(useSessionStore.getState().selectedSessionIds).toEqual([])
  })
})
