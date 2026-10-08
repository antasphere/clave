/**
 * What the window does with a layout the server pushes (wave 3, the agent
 * tools served by the server): a tab the layout no longer places stays
 * drawn while its process lives (appended at the top level, as before), and
 * leaves the store once its process has ended (an agent's close through the
 * server), taking the serving session of its view with it; a tab a linked
 * editor refuses to close is kept whatever its state. The store reads
 * localStorage and the preload bridge at import time, so both are stubbed
 * first, as group-dissolve.test.ts does; the linked-document store is
 * replaced by a switch the test flips.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './session-types'

let blocksClose = false
vi.mock('./linked-document-store', () => ({
  linkedEditorBlocksClose: () => blocksClose
}))

let useSessionStore: typeof import('./session-store').useSessionStore
let applyServerLayout: typeof import('./session-store').applyServerLayout
let setSidebarBase: typeof import('./session-store').setSidebarBase

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
    listSessionRecords: async () => [],
    showNotification: async () => 'shown'
  }
  const store = await import('./session-store')
  useSessionStore = store.useSessionStore
  applyServerLayout = store.applyServerLayout
  setSidebarBase = store.setSidebarBase
})

const session = (id: string, alive = true, extra: Partial<Session> = {}): Session =>
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
    planFilePath: null,
    ...extra
  }) as Session

let revision = 0
/** The window knew the server's layout as `known`; the server now pushes `displayOrder`. */
const push = (known: string[], displayOrder: string[]): void => {
  setSidebarBase({ windowKey: 'w', revision, groups: [], displayOrder: known })
  applyServerLayout({ windowKey: 'w', revision: ++revision, groups: [], displayOrder })
}

beforeEach(() => {
  blocksClose = false
  useSessionStore.setState({
    sessions: [],
    groups: [],
    displayOrder: [],
    selectedSessionIds: [],
    focusedSessionId: null,
    fileTabs: []
  })
})

describe('a layout pushed by the server', () => {
  it('keeps a live tab the layout does not place, appended at the top level', () => {
    useSessionStore.setState({ sessions: [session('live')], displayOrder: ['live'] })
    push(['live'], [])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['live'])
    expect(state.displayOrder).toEqual(['live'])
  })

  it('drops an ended tab the layout no longer places, with the serving session of its view', () => {
    useSessionStore.setState({
      sessions: [
        session('closed', false, {
          view: { url: 'http://127.0.0.1:1', serverSessionId: 'serving' }
        }),
        session('serving'),
        session('other')
      ],
      displayOrder: ['closed', 'other'],
      selectedSessionIds: ['closed'],
      focusedSessionId: 'closed'
    })
    push(['closed', 'other'], ['other'])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['other'])
    expect(state.displayOrder).toEqual(['other'])
    expect(state.selectedSessionIds).toEqual([])
    expect(state.focusedSessionId).toBeNull()
  })

  it('keeps an ended tab the layout still places', () => {
    useSessionStore.setState({ sessions: [session('ended', false)], displayOrder: ['ended'] })
    push(['ended'], ['ended'])
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['ended'])
  })

  it('keeps an ended, unplaced tab a linked editor refuses to close', () => {
    blocksClose = true
    useSessionStore.setState({ sessions: [session('editing', false)], displayOrder: ['editing'] })
    push(['editing'], [])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['editing'])
    expect(state.displayOrder).toEqual(['editing'])
  })
})
