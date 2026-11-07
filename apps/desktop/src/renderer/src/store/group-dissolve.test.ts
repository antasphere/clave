/**
 * The store half of dissolving a group, and the confirmation's two answers.
 *
 * The session store reads localStorage and the preload bridge at import
 * time, so this file stubs both before importing it: a Map for storage, and
 * a `window.electronAPI` whose killSession only records what it was asked
 * to kill. That is enough to pin what vitest could not otherwise see —
 * `ungroupSessions` dropping the terminal sessions (the leak's store half),
 * and Cancel on the dialog leaving everything exactly as it was (the
 * mutation the first verification round found no gate for).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session, SessionGroup } from './session-types'

const killed: string[] = []
let useSessionStore: typeof import('./session-store').useSessionStore
let dissolve: typeof import('../lib/group-dissolve')

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async (id: string) => void killed.push(id),
    captureTabClosed: () => {}
  }
  useSessionStore = (await import('./session-store')).useSessionStore
  dissolve = await import('../lib/group-dissolve')
})

const session = (id: string, alive = true): Session =>
  ({
    id,
    cwd: '/w',
    folderName: 'w',
    name: id,
    alive,
    activityStatus: 'idle',
    promptWaiting: null,
    claudeMode: false,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeSessionId: null,
    sessionType: 'local',
    detectedUrl: null,
    serverStatus: null,
    serverCommand: null,
    hasUnseenActivity: false,
    userRenamed: false,
    planFilePath: null
  }) as Session

const group = (over: Partial<SessionGroup> = {}): SessionGroup => ({
  id: 'g1',
  name: 'Lane',
  sessionIds: ['a', 'b'],
  collapsed: false,
  cwd: '/w',
  terminals: [
    { id: 't-dev', command: 'npm run dev', commandMode: 'auto', color: 'green', sessionId: 'dev' },
    { id: 't-idle', command: 'x', commandMode: 'prefill', color: 'blue', sessionId: null }
  ],
  ...over
})

function seed(g: SessionGroup, extra: Session[] = []): void {
  const members = g.sessionIds.map((id) => session(id))
  const terminals = g.terminals
    .map((t) => t.sessionId)
    .filter((id): id is string => id !== null)
    .map((id) => session(id))
  useSessionStore.setState({
    sessions: [...members, ...terminals, ...extra, session('loose')],
    groups: [g],
    displayOrder: ['loose', g.id],
    selectedSessionIds: ['dev'],
    focusedSessionId: 'dev'
  })
  killed.length = 0
  dissolve.useDissolveStore.setState({ pending: null })
}

describe('ungroupSessions — the members become tabs, the terminals leave the store', () => {
  beforeEach(() => seed(group()))

  it('drops the terminal sessions and keeps the members, in the group’s slot', () => {
    useSessionStore.getState().ungroupSessions('g1')
    const s = useSessionStore.getState()
    expect(s.groups).toEqual([])
    expect(s.sessions.map((x) => x.id).sort()).toEqual(['a', 'b', 'loose'])
    expect(s.displayOrder).toEqual(['loose', 'a', 'b'])
  })

  it('re-points a selection and focus that sat on a dropped terminal', () => {
    useSessionStore.getState().ungroupSessions('g1')
    const s = useSessionStore.getState()
    expect(s.selectedSessionIds).toEqual([])
    expect(s.focusedSessionId).toBeNull()
  })

  it('a member that is also a terminal never comes back into the order', () => {
    seed(group({ sessionIds: ['a', 'dev'] }))
    useSessionStore.getState().ungroupSessions('g1')
    const s = useSessionStore.getState()
    expect(s.displayOrder).toEqual(['loose', 'a'])
    expect(s.sessions.some((x) => x.id === 'dev')).toBe(false)
  })
})

describe('requestGroupDissolve — the dialog’s two answers', () => {
  beforeEach(() => seed(group()))

  it('asks when a terminal is running, and Cancel changes nothing at all', async () => {
    await dissolve.requestGroupDissolve('g1', 'ungroup')
    expect(dissolve.useDissolveStore.getState().pending?.mode).toBe('ungroup')
    expect(killed).toEqual([])
    dissolve.useDissolveStore.getState().cancel()
    expect(dissolve.useDissolveStore.getState().pending).toBeNull()
    expect(killed).toEqual([])
    const s = useSessionStore.getState()
    expect(s.groups.map((g) => g.id)).toEqual(['g1'])
    expect(s.sessions.map((x) => x.id).sort()).toEqual(['a', 'b', 'dev', 'loose'])
  })

  it('Confirm on Ungroup kills the terminals only and dissolves the group', async () => {
    await dissolve.requestGroupDissolve('g1', 'ungroup')
    await dissolve.useDissolveStore.getState().confirm()
    expect(killed).toEqual(['dev'])
    const s = useSessionStore.getState()
    expect(s.groups).toEqual([])
    expect(s.sessions.map((x) => x.id).sort()).toEqual(['a', 'b', 'loose'])
  })

  it('Confirm on Delete kills members and terminals and removes them all', async () => {
    await dissolve.requestGroupDissolve('g1', 'delete')
    await dissolve.useDissolveStore.getState().confirm()
    expect(killed.sort()).toEqual(['a', 'b', 'dev'])
    const s = useSessionStore.getState()
    expect(s.groups).toEqual([])
    expect(s.sessions.map((x) => x.id)).toEqual(['loose'])
  })

  it('with nothing running it does not ask: the dissolve is immediate', async () => {
    seed(
      group({
        terminals: [
          { id: 't', command: 'x', commandMode: 'auto', color: 'green', sessionId: 'dead' }
        ]
      })
    )
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((x) => (x.id === 'dead' ? { ...x, alive: false } : x))
    }))
    await dissolve.requestGroupDissolve('g1', 'delete')
    expect(dissolve.useDissolveStore.getState().pending).toBeNull()
    expect(killed.sort()).toEqual(['a', 'b', 'dead'])
    expect(useSessionStore.getState().groups).toEqual([])
  })
})
