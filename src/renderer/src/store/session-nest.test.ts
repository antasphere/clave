/**
 * The store half of nesting a tab under another (PRDCT-4997): where the row
 * lands, the link, the nest that opens, the one undo step, and everything put
 * back when the server refuses. The server is reached through `lib/nest-api`
 * only, so this file mocks that module and records what it was asked. The
 * session store reads localStorage and the preload bridge at import time, so
 * both are stubbed before importing it, as group-dissolve.test.ts does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionGroup } from './session-types'

const calls: Array<[string, string | null]> = []
let refuse: string | null = null

vi.mock('../lib/nest-api', () => ({
  nestApi: {
    nest: vi.fn(async (id: string, under: string | null) => {
      calls.push([id, under])
      if (refuse) throw new Error(refuse)
    }),
    onNested: () => () => {}
  }
}))

let useSessionStore: typeof import('./session-store').useSessionStore

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
  useSessionStore = (await import('./session-store')).useSessionStore
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
    claudeMode: false,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeSessionId: null,
    sessionType: 'local',
    workspaceId: 'ws',
    ...over
  }) as unknown as Session

const group = (id: string, sessionIds: string[]): SessionGroup =>
  ({
    id,
    name: id,
    cwd: '/w',
    sessionIds,
    collapsed: false,
    terminals: [],
    workspaceId: 'ws'
  }) as unknown as SessionGroup

const linkOf = (id: string): string | undefined =>
  useSessionStore.getState().sessions.find((s) => s.id === id)?.spawnedBy

beforeEach(() => {
  calls.length = 0
  refuse = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // The parent sits in a group; the tab to nest stands at the top level with
  // a tab of its own nested under it, which must follow it.
  useSessionStore.setState({
    sessions: [
      session('lead'),
      session('mate'),
      session('loose'),
      session('loose-child', { spawnedBy: 'loose' }),
      session('other')
    ],
    groups: [group('g', ['lead', 'mate'])],
    displayOrder: ['g', 'other', 'loose', 'loose-child'],
    expandedNests: {},
    sidebarUndoStack: [],
    selectedSessionIds: [],
    focusedSessionId: null
  })
})

describe('nesting a tab under another', () => {
  it('places the tab after its parent, in the parent group, its own nested tabs behind it', async () => {
    const outcome = await useSessionStore.getState().nestSession('loose', 'lead')
    expect(outcome).toEqual({ ok: true })
    const state = useSessionStore.getState()
    expect(state.groups.find((g) => g.id === 'g')?.sessionIds).toEqual([
      'lead',
      'loose',
      'loose-child',
      'mate'
    ])
    expect(state.displayOrder).toEqual(['g', 'other'])
    expect(linkOf('loose')).toBe('lead')
    expect(state.expandedNests).toEqual({ lead: true })
    expect(state.sidebarUndoStack).toHaveLength(1)
    expect(calls).toEqual([['loose', 'lead']])
  })

  it('opens the nest of the presented root when the parent is itself nested', async () => {
    useSessionStore.setState({
      sessions: useSessionStore
        .getState()
        .sessions.map((s) => (s.id === 'mate' ? { ...s, spawnedBy: 'lead' } : s))
    })
    await useSessionStore.getState().nestSession('other', 'mate')
    expect(useSessionStore.getState().expandedNests).toEqual({ lead: true })
  })

  it('refuses by the rule without calling the server or touching anything', async () => {
    const before = useSessionStore.getState()
    const outcome = await useSessionStore.getState().nestSession('loose', 'loose-child')
    expect(outcome.ok).toBe(false)
    expect(calls).toEqual([])
    const after = useSessionStore.getState()
    expect(after.groups).toBe(before.groups)
    expect(after.displayOrder).toBe(before.displayOrder)
    expect(after.sidebarUndoStack).toHaveLength(0)
    expect(linkOf('loose')).toBeUndefined()
  })

  it('refuses a remote session and a tab of another machine without a call', async () => {
    useSessionStore.setState({
      sessions: [
        ...useSessionStore.getState().sessions,
        session('remote', { sessionType: 'remote-terminal' })
      ]
    })
    expect((await useSessionStore.getState().nestSession('remote', 'lead')).ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('puts everything back and leaves no undo step when the server refuses', async () => {
    refuse = 'That tab is nested under this one'
    const before = useSessionStore.getState()
    const outcome = await useSessionStore.getState().nestSession('loose', 'lead')
    expect(outcome).toEqual({ ok: false, error: 'That tab is nested under this one' })
    const after = useSessionStore.getState()
    expect(after.groups).toEqual(before.groups)
    expect(after.displayOrder).toEqual(before.displayOrder)
    expect(linkOf('loose')).toBeUndefined()
    expect(after.sidebarUndoStack).toHaveLength(0)
    expect(console.error).toHaveBeenCalledWith(
      '[clave] nesting refused:',
      'That tab is nested under this one'
    )
  })
})

describe('taking a tab out', () => {
  beforeEach(async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    calls.length = 0
  })

  it('without a move clears the link and leaves the row where it sits', async () => {
    const layout = useSessionStore.getState().groups
    expect(await useSessionStore.getState().detachSession('loose')).toEqual({ ok: true })
    expect(linkOf('loose')).toBeUndefined()
    expect(useSessionStore.getState().groups).toBe(layout)
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(2)
    expect(calls).toEqual([['loose', null]])
  })

  it('with a move places it and its nested tabs there', async () => {
    await useSessionStore
      .getState()
      .detachSession('loose', { targetId: 'other', position: 'before' })
    const state = useSessionStore.getState()
    expect(state.displayOrder).toEqual(['g', 'loose', 'loose-child', 'other'])
    expect(state.groups.find((g) => g.id === 'g')?.sessionIds).toEqual(['lead', 'mate'])
    expect(linkOf('loose')).toBeUndefined()
    expect(linkOf('loose-child')).toBe('loose')
  })

  it('a refusal puts the link and the layout back', async () => {
    refuse = 'No'
    const before = useSessionStore.getState()
    await useSessionStore
      .getState()
      .detachSession('loose', { targetId: 'other', position: 'before' })
    expect(useSessionStore.getState().displayOrder).toEqual(before.displayOrder)
    expect(linkOf('loose')).toBe('lead')
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(1)
  })
})

describe('what the server says and what moves with a tab', () => {
  it('applies a served nesting as the link alone', () => {
    const before = useSessionStore.getState()
    useSessionStore.getState().applyServedNest('other', 'lead')
    const after = useSessionStore.getState()
    expect(linkOf('other')).toBe('lead')
    expect(after.displayOrder).toBe(before.displayOrder)
    expect(after.sidebarUndoStack).toHaveLength(0)
    expect(after.expandedNests).toEqual({})
    useSessionStore.getState().applyServedNest('other', null)
    expect(linkOf('other')).toBeUndefined()
    useSessionStore.getState().applyServedNest('ghost', 'lead')
    expect(calls).toEqual([])
  })

  it('moves a parent with the tabs nested under it', () => {
    useSessionStore.getState().moveItems(['loose'], 'lead', 'after')
    expect(useSessionStore.getState().groups.find((g) => g.id === 'g')?.sessionIds).toEqual([
      'lead',
      'loose',
      'loose-child',
      'mate'
    ])
    expect(calls).toEqual([])
  })
})

describe('undo', () => {
  it('after a nest restores the layout and takes the tab out through the server', async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    calls.length = 0
    useSessionStore.getState().undoSidebar()
    expect(linkOf('loose')).toBeUndefined()
    expect(useSessionStore.getState().displayOrder).toEqual(['g', 'other', 'loose', 'loose-child'])
    await Promise.resolve()
    expect(calls).toEqual([['loose', null]])
  })

  it('after a detach puts the tab back under its parent through the server', async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    await useSessionStore.getState().detachSession('loose')
    calls.length = 0
    useSessionStore.getState().undoSidebar()
    expect(linkOf('loose')).toBe('lead')
    await Promise.resolve()
    expect(calls).toEqual([['loose', 'lead']])
  })

  it('logs a refused relink and keeps the layout restored', async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    refuse = 'Refused'
    useSessionStore.getState().undoSidebar()
    await new Promise((r) => setTimeout(r, 0))
    expect(useSessionStore.getState().displayOrder).toEqual(['g', 'other', 'loose', 'loose-child'])
    expect(console.error).toHaveBeenCalledWith('[clave] nesting refused:', 'Refused')
  })

  it('a snapshot without nests restores the layout alone', () => {
    useSessionStore.setState({
      sidebarUndoStack: [
        {
          groups: [group('g', ['lead', 'mate'])],
          displayOrder: ['g', 'loose', 'loose-child', 'other'],
          selectedSessionIds: [],
          focusedSessionId: null
        }
      ],
      sessions: useSessionStore
        .getState()
        .sessions.map((s) => (s.id === 'other' ? { ...s, spawnedBy: 'lead' } : s))
    })
    useSessionStore.getState().undoSidebar()
    expect(useSessionStore.getState().displayOrder).toEqual(['g', 'loose', 'loose-child', 'other'])
    expect(linkOf('other')).toBe('lead')
    expect(calls).toEqual([])
  })
})
