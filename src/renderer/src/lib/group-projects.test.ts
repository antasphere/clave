/**
 * The group that names itself (PRDCT-5179): what a person's group does with
 * its tabs' readings, read by a fake `readTabProjects`, and the flag that
 * says whether Clave may still name it. The session store reads
 * localStorage and the preload bridge at import time, so both are stubbed
 * before importing it, as session-nest.test.ts does.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabProjects } from '@clave/contract/tab-projects-rules'
import type { Session, SessionGroup } from '../store/session-types'
import type { ReadTabProjects, TabProjectsAnswer } from './group-projects'

let useSessionStore: typeof import('../store/session-store').useSessionStore
let useGroupSuggestionsStore: typeof import('../store/group-suggestions-store').useGroupSuggestionsStore
let projects: typeof import('./group-projects')

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    captureTabClosed: () => {}
  }
  useSessionStore = (await import('../store/session-store')).useSessionStore
  useGroupSuggestionsStore = (await import('../store/group-suggestions-store'))
    .useGroupSuggestionsStore
  projects = await import('./group-projects')
})

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    cwd: '/w',
    folderName: 'w',
    name: id,
    alive: true,
    activityStatus: 'idle',
    promptWaiting: null,
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeSessionId: null,
    sessionType: 'local',
    workspaceId: 'ws',
    ...over
  }) as unknown as Session

const group = (id: string, sessionIds: string[], over: Partial<SessionGroup> = {}): SessionGroup =>
  ({
    id,
    name: 'Group 1',
    cwd: '/w',
    sessionIds,
    collapsed: false,
    terminals: [],
    workspaceId: 'ws',
    autoNamed: true,
    ...over
  }) as SessionGroup

const decided = (...picks: Array<[string, number]>): TabProjects => ({
  status: 'decided',
  picks: picks.map(([name, p]) => ({ file: `/w/${name.toLowerCase()}.clave`, name, p })),
  fits: 0.95,
  readAt: 1,
  model: 'jev-test',
  basis: 'basis'
})
const undecided = (...picks: Array<[string, number]>): TabProjects => ({
  ...decided(...picks),
  status: 'undecided'
})

/** A fake reader answering each tab from `readings`, recording each call. */
function reader(readings: Record<string, TabProjects | null>): ReadTabProjects & {
  calls: string[][]
} {
  const calls: string[][] = []
  const read = (async (ids: string[]): Promise<TabProjectsAnswer> => {
    calls.push([...ids])
    return { tabs: ids.map((sessionId) => ({ sessionId, projects: readings[sessionId] ?? null })) }
  }) as ReadTabProjects & { calls: string[][] }
  read.calls = calls
  return read
}

/** A reader whose one answer waits until `release` is called. */
function heldReader(readings: Record<string, TabProjects | null>): {
  read: ReadTabProjects
  release: () => void
} {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const inner = reader(readings)
  return {
    read: async (ids) => {
      await gate
      return inner(ids)
    },
    release: () => release()
  }
}

const groupOf = (id: string): SessionGroup | undefined =>
  useSessionStore.getState().groups.find((g) => g.id === id)
const suggestionOf = (id: string): unknown => useGroupSuggestionsStore.getState().byGroup[id]

beforeEach(() => {
  useGroupSuggestionsStore.setState({ byGroup: {} })
  useSessionStore.setState({
    sessions: [
      session('a'),
      session('b'),
      session('c'),
      session('term', { claudeMode: false }),
      session('loose')
    ],
    groups: [
      group('g', ['a', 'b'], { terminals: [{ id: 't', sessionId: 'term' } as never] }),
      group('mine', ['c'], { name: 'Mine', autoNamed: undefined })
    ],
    displayOrder: ['g', 'mine', 'loose'],
    sidebarUndoStack: [],
    selectedSessionIds: [],
    focusedSessionId: null
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('what a group does with its tabs’ readings', () => {
  it('named: one project gives the group its name, the readings land on the tabs', async () => {
    const read = reader({ a: decided(['Atlas', 0.95]), b: decided(['Atlas', 0.92]) })
    await projects.nameGroupFromTabs('g', read)
    expect(read.calls).toEqual([['a', 'b']])
    expect(groupOf('g')).toMatchObject({ name: 'Atlas', autoNamed: true })
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'a')?.projects).toEqual(
      decided(['Atlas', 0.95])
    )
    expect(suggestionOf('g')).toBeUndefined()
  })

  it('named after several projects: « A | B », in the order of their shares', async () => {
    const read = reader({ a: decided(['Atlas', 0.95]), b: decided(['Tern', 0.6], ['Atlas', 0.35]) })
    await projects.nameGroupFromTabs('g', read)
    expect(groupOf('g')?.name).toBe('Atlas | Tern')
  })

  it('suggested: the name stays, the two nearest are offered', async () => {
    const read = reader({
      a: undecided(['Atlas', 0.6], ['Tern', 0.3]),
      b: decided(['Atlas', 0.95])
    })
    await projects.nameGroupFromTabs('g', read)
    expect(groupOf('g')?.name).toBe('Group 1')
    const nearest = suggestionOf('g') as Array<{ name: string; share: number }>
    expect(nearest.map((p) => p.name)).toEqual(['Atlas', 'Tern'])
    expect(nearest[0].share).toBeCloseTo(0.775)
    expect(nearest[1].share).toBeCloseTo(0.15)
  })

  it('a server that cannot decide: the tabs keep what they knew, nothing named, nothing offered', async () => {
    const known = decided(['Atlas', 0.95])
    useSessionStore.setState({
      sessions: useSessionStore
        .getState()
        .sessions.map((s) => (s.id === 'a' ? { ...s, projects: known } : s))
    })
    useGroupSuggestionsStore.setState({ byGroup: { g: [{ name: 'Lumen', share: 0.5 }] } })
    for (const reason of ['no-key', 'disabled']) {
      const read: ReadTabProjects = async (ids) => ({
        tabs: ids.map((sessionId) => ({ sessionId, projects: null, reason }))
      })
      await projects.nameGroupFromTabs('g', read)
      expect(groupOf('g')).toMatchObject({ name: 'Group 1', autoNamed: true })
      expect(useSessionStore.getState().sessions.find((s) => s.id === 'a')?.projects).toEqual(known)
      expect(suggestionOf('g')).toBeUndefined()
    }
  })

  it('unread: nothing, and a suggestion it had goes', async () => {
    useGroupSuggestionsStore.setState({ byGroup: { g: [{ name: 'Lumen', share: 0.5 }] } })
    await projects.nameGroupFromTabs('g', reader({}))
    expect(groupOf('g')?.name).toBe('Group 1')
    expect(suggestionOf('g')).toBeUndefined()
  })

  it('reads the agent tabs only, never a quick-launch terminal', async () => {
    useSessionStore.setState({
      groups: [
        group('g', ['a', 'term', 'b'], { terminals: [{ id: 't', sessionId: 'term' } as never] })
      ]
    })
    const read = reader({})
    await projects.nameGroupFromTabs('g', read)
    expect(read.calls).toEqual([['a', 'b']])
  })

  it('a group renamed by a person while the answer was on its way keeps the person’s name', async () => {
    const held = heldReader({ a: decided(['Atlas', 0.95]), b: decided(['Atlas', 0.95]) })
    const done = projects.nameGroupFromTabs('g', held.read)
    useSessionStore.getState().renameGroup('g', 'Quill')
    held.release()
    await done
    expect(groupOf('g')).toMatchObject({ name: 'Quill' })
    expect(groupOf('g')?.autoNamed).toBeUndefined()
  })

  it('a group gone before the answer: nothing happens, nothing throws', async () => {
    const held = heldReader({ a: decided(['Atlas', 0.95]) })
    const done = projects.nameGroupFromTabs('g', held.read)
    useSessionStore.setState({ groups: [], displayOrder: ['loose'] })
    held.release()
    await expect(done).resolves.toBeUndefined()
    expect(useSessionStore.getState().groups).toEqual([])
    expect(suggestionOf('g')).toBeUndefined()
  })

  it('reads the tabs as they are when the answer lands, not as they were when asked', async () => {
    const held = heldReader({
      a: decided(['Atlas', 0.95]),
      b: undecided(['Tern', 0.5], ['Atlas', 0.4])
    })
    const done = projects.nameGroupFromTabs('g', held.read)
    // `b` leaves the group while the answer is on its way: `a` alone names it.
    useSessionStore.setState({ groups: [group('g', ['a'])] })
    held.release()
    await done
    expect(groupOf('g')?.name).toBe('Atlas')
  })

  it('an answer overtaken by a later read of the same group is dropped', async () => {
    const older = heldReader({ a: decided(['Tern', 0.95]), b: decided(['Tern', 0.95]) })
    const first = projects.nameGroupFromTabs('g', older.read)
    await projects.nameGroupFromTabs(
      'g',
      reader({ a: decided(['Atlas', 0.95]), b: decided(['Atlas', 0.95]) })
    )
    older.release()
    await first
    expect(groupOf('g')?.name).toBe('Atlas')
  })

  it('a failure leaves the group as it is; a group not autoNamed is never read', async () => {
    const failing: ReadTabProjects = async () => {
      throw new Error('The server did not answer')
    }
    await projects.nameGroupFromTabs('g', failing)
    expect(groupOf('g')).toMatchObject({ name: 'Group 1', autoNamed: true })
    const read = reader({ c: decided(['Atlas', 0.95]) })
    await projects.nameGroupFromTabs('mine', read)
    expect(read.calls).toEqual([])
    expect(groupOf('mine')?.name).toBe('Mine')
  })

  it('a person’s grouping comes up as « Group N » at once, flagged, and is read after', async () => {
    const read = reader({ loose: decided(['Lumen', 0.97]) })
    const id = projects.groupTabsByPerson(['loose'], read)!
    expect(groupOf(id)?.name).toMatch(/^Group \d+$/)
    expect(groupOf(id)?.autoNamed).toBe(true)
    await vi.waitFor(() => expect(groupOf(id)?.name).toBe('Lumen'))
    expect(read.calls).toEqual([['loose']])
  })
})

describe('when a group is read again', () => {
  it('nothing is read at start', async () => {
    vi.useFakeTimers()
    const read = reader({})
    const stop = projects.startGroupNaming({ read })
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.calls).toEqual([])
    stop()
  })

  it('a change of tabs re-reads once, after the debounce', async () => {
    vi.useFakeTimers()
    const read = reader({})
    const stop = projects.startGroupNaming({ read })
    const set = (ids: string[]): void =>
      useSessionStore.setState((s) => ({
        groups: s.groups.map((g) => (g.id === 'g' ? { ...g, sessionIds: ids } : g))
      }))
    set(['a', 'b', 'loose'])
    await vi.advanceTimersByTimeAsync(100)
    set(['a', 'loose'])
    await vi.advanceTimersByTimeAsync(projects.GROUP_NAMING_DEBOUNCE_MS - 1)
    expect(read.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(read.calls).toEqual([['a', 'loose']])
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.calls).toHaveLength(1)
    stop()
  })

  it('a group offering two projects whose last agent tab leaves loses its offer, asking nothing', async () => {
    vi.useFakeTimers()
    useGroupSuggestionsStore.setState({
      byGroup: {
        g: [
          { name: 'Lumen', share: 0.63 },
          { name: 'Atlas', share: 0.23 }
        ]
      }
    })
    const read = reader({})
    const stop = projects.startGroupNaming({ read })
    // `a` is moved out and `b` is closed: the group keeps its terminal only.
    useSessionStore.setState((s) => ({
      sessions: s.sessions.filter((x) => x.id !== 'b'),
      groups: s.groups.map((g) => (g.id === 'g' ? { ...g, sessionIds: [] } : g)),
      displayOrder: [...s.displayOrder, 'a']
    }))
    await vi.advanceTimersByTimeAsync(projects.GROUP_NAMING_DEBOUNCE_MS)
    expect(groupOf('g')).toMatchObject({ name: 'Group 1', autoNamed: true })
    expect(suggestionOf('g')).toBeUndefined()
    expect(read.calls).toEqual([])
    stop()
  })

  it('a group not autoNamed, a member the store never held leaving, and a new group: no read', async () => {
    vi.useFakeTimers()
    useSessionStore.setState((s) => ({
      groups: s.groups.map((g) => (g.id === 'g' ? { ...g, sessionIds: ['a', 'b', 'shell'] } : g))
    }))
    const read = reader({})
    const stop = projects.startGroupNaming({ read })
    useSessionStore.setState((s) => ({
      groups: [
        ...s.groups.map((g) => {
          if (g.id === 'g') return { ...g, sessionIds: ['a', 'b'] }
          if (g.id === 'mine') return { ...g, sessionIds: ['c', 'loose'] }
          return g
        }),
        group('fresh', ['loose'])
      ]
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.calls).toEqual([])
    stop()
  })
})

describe('the flag', () => {
  it('a rename without auto clears it and takes an undo step; with auto it keeps it and takes none', () => {
    const store = useSessionStore.getState()
    store.renameGroup('g', 'Atlas', { auto: true })
    expect(groupOf('g')).toMatchObject({ name: 'Atlas', autoNamed: true })
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(0)
    store.renameGroup('g', 'Quill')
    expect(groupOf('g')?.name).toBe('Quill')
    expect(groupOf('g')?.autoNamed).toBeUndefined()
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(1)
    // Clave never names a group someone else named.
    store.renameGroup('g', 'Tern', { auto: true })
    expect(groupOf('g')?.name).toBe('Quill')
  })

  it('a rename to the very name Clave gave takes the group: the flag goes, with no undo step', () => {
    const store = useSessionStore.getState()
    store.renameGroup('g', 'Atlas', { auto: true })
    expect(groupOf('g')).toMatchObject({ name: 'Atlas', autoNamed: true })
    store.renameGroup('g', ' Atlas ')
    expect(groupOf('g')?.name).toBe('Atlas')
    expect(groupOf('g')?.autoNamed).toBeUndefined()
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(0)
    store.renameGroup('g', 'Tern', { auto: true })
    expect(groupOf('g')?.name).toBe('Atlas')
    // A group nobody waits to name is left exactly as it is.
    const groups = useSessionStore.getState().groups
    store.renameGroup('mine', 'Mine')
    expect(useSessionStore.getState().groups).toBe(groups)
  })

  it('Cmd+Z after a person’s grouping named by Clave still undoes the grouping', () => {
    const store = useSessionStore.getState()
    const id = store.createGroup(['loose'], undefined, undefined, { autoNamed: true })!
    store.renameGroup(id, 'Lumen', { auto: true })
    useSessionStore.getState().undoSidebar()
    expect(groupOf(id)).toBeUndefined()
    expect(useSessionStore.getState().displayOrder).toContain('loose')
  })

  it('only a person’s grouping without a name is flagged', () => {
    const store = useSessionStore.getState()
    const plain = store.createGroup(['loose'])!
    expect(groupOf(plain)?.autoNamed).toBeUndefined()
    const named = store.createGroup(['c'], 'Atlas', undefined, { autoNamed: true })!
    expect(groupOf(named)?.autoNamed).toBeUndefined()
  })
})
