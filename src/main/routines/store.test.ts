import { describe, expect, it } from 'vitest'
import type { RoutineRun } from '@clave/contract/routines'
import { KEEP_RUNS, PRUNE_AFTER_MS, RoutinesStore, STORE_FILE } from './store'

function memory(): {
  docs: Map<string, string>
  read: (n: string) => string | null
  write: (n: string, t: string) => void
} {
  const docs = new Map<string, string>()
  return {
    docs,
    read: (n) => docs.get(n) ?? null,
    write: (n, t) => void docs.set(n, t)
  }
}

const run = (id: string, key = 'k', patch: Partial<RoutineRun> = {}): RoutineRun => ({
  id,
  routineKey: key,
  trigger: 'scheduled',
  startedAt: 1,
  endedAt: null,
  state: 'running',
  headline: null,
  summary: null,
  reason: null,
  sessionId: `s-${id}`,
  providerSessionId: null,
  discussionSessionId: null,
  agent: 'claude',
  form: 'chat',
  model: null,
  account: null,
  deck: null,
  seen: false,
  ...patch
})

describe('RoutinesStore', () => {
  it('starts empty, remembers the clock, and survives a reload from the document', () => {
    const storage = memory()
    const store = new RoutinesStore(storage, () => 5)
    expect(store.state('k')).toBeUndefined()
    store.considered('k', 100, '* * * * *')
    const again = new RoutinesStore(storage)
    expect(again.state('k')).toMatchObject({
      lastConsideredAt: 100,
      schedule: '* * * * *',
      firstSeenAt: 5,
      runs: []
    })
    expect(storage.docs.has(STORE_FILE)).toBe(true)
  })

  it('keeps the last 20 runs, newest first, and finds a run by id or by session', () => {
    const store = new RoutinesStore(memory())
    for (let i = 0; i < KEEP_RUNS + 5; i++) store.addRun(run(`r${i}`))
    const runs = store.state('k')!.runs
    expect(runs).toHaveLength(KEEP_RUNS)
    expect(runs[0].id).toBe(`r${KEEP_RUNS + 4}`)
    expect(runs[KEEP_RUNS - 1].id).toBe('r5')
    expect(store.run('r7')?.id).toBe('r7')
    expect(store.runBySession('s-r9')?.id).toBe('r9')
    expect(store.updateRun('r9', { state: 'ok', headline: 'fine' })).toMatchObject({
      state: 'ok',
      headline: 'fine'
    })
    expect(store.run('r9')?.headline).toBe('fine')
    expect(store.updateRun('nope', { state: 'ok' })).toBeUndefined()
  })

  it('lists the runs still open, for a start to finish off', () => {
    const store = new RoutinesStore(memory())
    store.addRun(run('a', 'k', { state: 'ok' }))
    store.addRun(run('b', 'k', { state: 'running' }))
    store.addRun(run('c', 'j', { state: 'waiting' }))
    expect(
      store
        .openRuns()
        .map((r) => r.id)
        .sort()
    ).toEqual(['b', 'c'])
  })

  it('forgets a routine not seen for thirty days, never one still in the files', () => {
    let now = 0
    const store = new RoutinesStore(memory(), () => now)
    store.considered('old', 0, '* * * * *')
    store.considered('kept', 0, '* * * * *')
    now = PRUNE_AFTER_MS + 1
    store.considered('kept', now, '* * * * *')
    expect(store.prune(new Set(['kept']))).toEqual(['old'])
    expect(store.state('old')).toBeUndefined()
    expect(store.state('kept')).toBeDefined()
    // A routine still declared is never pruned, however old its clock.
    store.considered('declared', 0, '* * * * *')
    now += PRUNE_AFTER_MS + 1
    expect(store.prune(new Set(['declared']))).toEqual(['kept'])
  })

  it("keeps a routine's Slideless deck and share link across a reload (PRDCT-4149)", () => {
    const storage = memory()
    const store = new RoutinesStore(storage)
    expect(store.publishState('k')).toBeNull()
    const state = { deckId: 'deck-1', share: { tokenId: 't-1', url: 'https://s.example/d/1' } }
    store.setPublishState('k', state)
    expect(store.publishState('k')).toEqual(state)
    expect(new RoutinesStore(storage).publishState('k')).toEqual(state)
  })

  it("forgets a pruned routine's publish state with the routine", () => {
    let now = 0
    const store = new RoutinesStore(memory(), () => now)
    store.considered('old', 0, '* * * * *')
    store.setPublishState('old', { deckId: 'deck-old', share: null })
    now = PRUNE_AFTER_MS + 1
    expect(store.prune(new Set())).toEqual(['old'])
    expect(store.publishState('old')).toBeNull()
  })

  it('keeps the viewer port for the next start', () => {
    const storage = memory()
    const store = new RoutinesStore(storage)
    expect(store.viewerPort()).toBeNull()
    store.setViewerPort(4910)
    expect(new RoutinesStore(storage).viewerPort()).toBe(4910)
  })
})
