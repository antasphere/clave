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
/** How long the server takes to answer, for the refusals that land late. */
let answersAfterMs = 0
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, answersAfterMs + 5))

vi.mock('../lib/nest-api', () => ({
  nestApi: {
    nest: vi.fn(async (id: string, under: string | null) => {
      calls.push([id, under])
      if (answersAfterMs) await new Promise((r) => setTimeout(r, answersAfterMs))
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
  answersAfterMs = 0
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
    nestNotice: null,
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

describe('a refusal that answers late', () => {
  it('keeps a move the person made meanwhile: the link goes back, the layout stays', async () => {
    refuse = 'The server refused'
    answersAfterMs = 20
    const pending = useSessionStore.getState().nestSession('other', 'lead')
    // While the server thinks, the person moves another row.
    useSessionStore.getState().moveItems(['loose'], 'other', 'after')
    const moved = useSessionStore.getState()
    expect(await pending).toEqual({ ok: false, error: refuse })
    expect(linkOf('other')).toBeUndefined()
    expect(useSessionStore.getState().displayOrder).toEqual(moved.displayOrder)
    expect(useSessionStore.getState().groups).toEqual(moved.groups)
    // The refused nesting leaves no undo step; the move keeps its own.
    expect(useSessionStore.getState().sidebarUndoStack).toHaveLength(1)
    expect(useSessionStore.getState().nestNotice).toEqual({ id: 'other', message: refuse })
  })

  it('the same for a tab the server would not take out', async () => {
    await useSessionStore.getState().nestSession('other', 'lead')
    refuse = 'The server refused'
    answersAfterMs = 20
    const pending = useSessionStore
      .getState()
      .detachSession('other', { targetId: 'loose', position: 'before' })
    useSessionStore.getState().moveItems(['mate'], 'lead', 'before')
    const moved = useSessionStore.getState()
    await pending
    expect(linkOf('other')).toBe('lead')
    expect(useSessionStore.getState().displayOrder).toEqual(moved.displayOrder)
    expect(useSessionStore.getState().groups).toEqual(moved.groups)
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

  it('places a tab for an agent without an undo step: the undo is the person’s', () => {
    // The window's road of the agent tool places the tab it nested. A step
    // the person never made must not sit on their undo: pressing it would
    // move a row that is drawn under its parent wherever it sits, so nothing
    // would seem to happen, and their own last step would wait behind it.
    useSessionStore.getState().moveItems(['other'], 'loose', 'after')
    const mine = useSessionStore.getState().sidebarUndoStack
    expect(mine).toHaveLength(1)
    useSessionStore.getState().moveItems(['mate'], 'other', 'after', { undo: false })
    expect(useSessionStore.getState().displayOrder).toEqual([
      'g',
      'loose',
      'other',
      'mate',
      'loose-child'
    ])
    expect(useSessionStore.getState().sidebarUndoStack).toBe(mine)
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

  it('puts the link and the layout back when the server refuses it, and the row says why', async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    const nested = useSessionStore.getState()
    refuse = 'This session keeps no record, so where it is nested cannot be kept'
    useSessionStore.getState().undoSidebar()
    await settle()
    // The server still holds the tab nested: the window says what the server says.
    expect(linkOf('loose')).toBe('lead')
    expect(useSessionStore.getState().displayOrder).toEqual(nested.displayOrder)
    expect(useSessionStore.getState().groups).toEqual(nested.groups)
    expect(useSessionStore.getState().nestNotice).toEqual({ id: 'loose', message: refuse })
    expect(console.error).toHaveBeenCalledWith('[clave] nesting refused:', refuse)
    // The step is spent: a second undo finds nothing of it.
    expect(useSessionStore.getState().sidebarUndoStack).toEqual([])
  })

  it('never puts back a link the rule now refuses: nothing moves, nothing is asked, the row says why', async () => {
    // The person takes a tab out, then an agent nests its old parent under it.
    await useSessionStore.getState().detachSession('loose-child')
    useSessionStore.getState().applyServedNest('loose', 'loose-child')
    calls.length = 0
    const before = useSessionStore.getState()
    useSessionStore.getState().undoSidebar()
    await settle()
    expect(calls).toEqual([])
    expect(linkOf('loose-child')).toBeUndefined()
    expect(linkOf('loose')).toBe('loose-child')
    expect(useSessionStore.getState().displayOrder).toBe(before.displayOrder)
    expect(useSessionStore.getState().groups).toBe(before.groups)
    expect(useSessionStore.getState().nestNotice).toEqual({
      id: 'loose-child',
      message:
        'That tab is nested under this one: take it out first, or nest this tab under another'
    })
    expect(useSessionStore.getState().sidebarUndoStack).toEqual([])
  })

  it('never puts a tab back under a tab that is gone', async () => {
    await useSessionStore.getState().detachSession('loose-child')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.filter((s) => s.id !== 'loose'),
      displayOrder: state.displayOrder.filter((id) => id !== 'loose')
    }))
    calls.length = 0
    useSessionStore.getState().undoSidebar()
    await settle()
    expect(calls).toEqual([])
    expect(linkOf('loose-child')).toBeUndefined()
    expect(useSessionStore.getState().nestNotice).toEqual({
      id: 'loose-child',
      message: 'The tab it was nested under is gone'
    })
    expect(useSessionStore.getState().sidebarUndoStack).toEqual([])
  })

  it('refused late, keeps a move the person made meanwhile and puts the link back alone', async () => {
    await useSessionStore.getState().nestSession('other', 'lead')
    refuse = 'The server refused'
    answersAfterMs = 20
    useSessionStore.getState().undoSidebar()
    // While the server thinks, the person moves another row.
    useSessionStore.getState().moveItems(['loose'], 'other', 'before')
    const moved = useSessionStore.getState()
    await settle()
    expect(linkOf('other')).toBe('lead')
    expect(useSessionStore.getState().displayOrder).toEqual(moved.displayOrder)
    expect(useSessionStore.getState().groups).toEqual(moved.groups)
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

  it('of a plain move leaves alone a nesting an agent made since', () => {
    // The person moves a row, then an agent's tool nests another tab: undoing
    // the move puts the row back and must not take the agent's tab out.
    useSessionStore.getState().moveItems(['other'], 'loose', 'after')
    useSessionStore.getState().applyServedNest('mate', 'lead')
    useSessionStore.getState().undoSidebar()
    expect(useSessionStore.getState().displayOrder).toEqual(['g', 'other', 'loose', 'loose-child'])
    expect(linkOf('mate')).toBe('lead')
    expect(calls).toEqual([])
  })

  it('of a nesting puts back that one link, never another tab changed since', async () => {
    await useSessionStore.getState().nestSession('other', 'lead')
    useSessionStore.getState().applyServedNest('mate', 'lead')
    calls.length = 0
    useSessionStore.getState().undoSidebar()
    await Promise.resolve()
    expect(linkOf('other')).toBeUndefined()
    expect(linkOf('mate')).toBe('lead')
    expect(calls).toEqual([['other', null]])
  })
})

describe('what the server says about a tab that has not joined the window yet', () => {
  // A tab the server opened joins the store from a record read a moment
  // earlier. What the server says about it in between must not be lost: the
  // tab would join as its older record describes it, until a restart
  // (PRDCT-5000).
  const lane = { unit: 'lane-x', kind: 'lane', label: 'Lane X', role: 'lead' } as NonNullable<
    Session['work']
  >
  const late = (): Session | undefined =>
    useSessionStore.getState().sessions.find((s) => s.id === 'late')

  it('keeps the tab it is nested under, and applies it as the tab joins', () => {
    useSessionStore.getState().applyServedNest('late', 'lead')
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    expect(linkOf('late')).toBe('lead')
  })

  it('keeps its work the same way', () => {
    useSessionStore.getState().applyServedWork('late', lane)
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    expect(late()?.work).toEqual(lane)
  })

  it('a taking-out and a work that ended, told early, win over the older record', () => {
    useSessionStore.getState().applyServedNest('late', null)
    useSessionStore.getState().applyServedWork('late', null)
    useSessionStore
      .getState()
      .adoptSessionInPlace(session('late', { spawnedBy: 'lead', work: lane }))
    expect(linkOf('late')).toBeUndefined()
    expect(late()?.work).toBeUndefined()
  })

  it('the newest word wins', () => {
    useSessionStore.getState().applyServedNest('late', 'lead')
    useSessionStore.getState().applyServedNest('late', 'mate')
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    expect(linkOf('late')).toBe('mate')
  })

  it('for each of several tabs on their way in at once', () => {
    useSessionStore.getState().applyServedNest('late', 'lead')
    useSessionStore.getState().applyServedNest('later', 'mate')
    useSessionStore.getState().applyServedWork('latest', lane)
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    useSessionStore.getState().adoptSessionInPlace(session('later'))
    useSessionStore.getState().adoptSessionInPlace(session('latest'))
    expect(linkOf('late')).toBe('lead')
    expect(linkOf('later')).toBe('mate')
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'latest')?.work).toEqual(lane)
  })

  it('whichever way the tab joins', () => {
    useSessionStore.getState().applyServedNest('late', 'lead')
    useSessionStore.getState().addHiddenSession(session('late'))
    expect(linkOf('late')).toBe('lead')
    useSessionStore.getState().applyServedNest('later', 'lead')
    useSessionStore.getState().addSession(session('later'))
    expect(linkOf('later')).toBe('lead')
  })

  it('once: a tab that leaves and joins again is read from its record', () => {
    useSessionStore.getState().applyServedNest('late', 'lead')
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    useSessionStore.setState((state) => ({
      sessions: state.sessions.filter((s) => s.id !== 'late'),
      displayOrder: state.displayOrder.filter((id) => id !== 'late')
    }))
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    expect(linkOf('late')).toBeUndefined()
  })

  it('and not for long: a word about a tab that never came is forgotten', () => {
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(1_000_000)
    useSessionStore.getState().applyServedNest('late', 'lead')
    clock.mockReturnValue(1_000_000 + 31_000)
    useSessionStore.getState().adoptSessionInPlace(session('late'))
    expect(linkOf('late')).toBeUndefined()
    clock.mockRestore()
  })

  it('a tab already in the window is told at once, as before', () => {
    useSessionStore.getState().applyServedWork('other', lane)
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'other')?.work).toEqual(lane)
  })
})

describe('what changes nothing', () => {
  it('nesting a tab under the tab it is already nested under', async () => {
    await useSessionStore.getState().nestSession('loose', 'lead')
    const { displayOrder, groups, sidebarUndoStack } = useSessionStore.getState()
    calls.length = 0
    expect(await useSessionStore.getState().nestSession('loose', 'lead')).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(useSessionStore.getState().displayOrder).toBe(displayOrder)
    expect(useSessionStore.getState().groups).toBe(groups)
    expect(useSessionStore.getState().sidebarUndoStack).toBe(sidebarUndoStack)
  })

  it('taking out a tab that stands alone', async () => {
    expect(await useSessionStore.getState().detachSession('other')).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(useSessionStore.getState().sidebarUndoStack).toEqual([])
  })
})

describe('what the row says when the server refuses', () => {
  const notice = (): { id: string; message: string } | null => useSessionStore.getState().nestNotice

  it('the server’s own sentence, under the tab that went back', async () => {
    refuse = 'This session keeps no record, so where it is nested cannot be kept'
    await useSessionStore.getState().nestSession('other', 'lead')
    expect(notice()).toEqual({ id: 'other', message: refuse })
  })

  it('the same for a tab the server would not take out', async () => {
    await useSessionStore.getState().nestSession('other', 'lead')
    refuse = 'No session with id "other"'
    await useSessionStore.getState().detachSession('other')
    expect(notice()).toEqual({ id: 'other', message: refuse })
    expect(linkOf('other')).toBe('lead')
  })

  it('never an address or a path: a failure of the road is said in plain words', async () => {
    for (const raw of [
      'request to http://127.0.0.1:43127/sessions/nest failed',
      'ENOENT: no such file or directory, open /tmp/records/x.json',
      '',
      'x'.repeat(201)
    ]) {
      refuse = raw || ' '
      await useSessionStore.getState().nestSession('other', 'lead')
      expect(notice()).toEqual({
        id: 'other',
        message: 'The server could not be asked: the tab stays where it was'
      })
    }
  })

  it('is gone at the next nesting, and when the sidebar clears it', async () => {
    refuse = 'Refused'
    await useSessionStore.getState().nestSession('other', 'lead')
    expect(notice()).not.toBeNull()
    refuse = null
    await useSessionStore.getState().nestSession('loose', 'lead')
    expect(notice()).toBeNull()
    refuse = 'Refused'
    await useSessionStore.getState().nestSession('other', 'lead')
    useSessionStore.getState().clearNestNotice()
    expect(notice()).toBeNull()
  })

  it('never for a drop the rule itself refuses: nothing was asked', async () => {
    await useSessionStore.getState().nestSession('lead', 'lead')
    expect(notice()).toBeNull()
  })
})
