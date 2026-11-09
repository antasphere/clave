/**
 * The cross-window edges of Ongoing conversations (PRDCT-4208) and the card's
 * account directory (PRDCT-4207), on the actions with main's bridge stubbed:
 * - F7: a Claude conversation with no transcript starts fresh under its id;
 * - R2-F4: End and Back wait for an open in flight, then run;
 * - R3-N1: a tab End could not bring over leaves the window holding it;
 * - R3-N2: End keeps a selection the person changed during the move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const m = new Map<string, string>()
  const g = globalThis as unknown as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
  g.window = globalThis
})
vi.mock('./exchange-capture', () => ({ emitTabClosed: vi.fn() }))

import { useSessionStore } from '../store/session-store'
import { useOngoingStore, ONGOING_LOCK, startOngoingSync } from '../store/ongoing-store'
import { emitTabClosed } from './exchange-capture'
import {
  dropEndedTab,
  endOngoing,
  keepPersonsView,
  openOngoing,
  OngoingStillOpening,
  returnToSidebar,
  WAIT_MS
} from './ongoing-actions'
import { conversationConfigDir, type OngoingEntry } from './ongoing'
import { resourceKey } from '@clave/contract/fleet'

const g = globalThis as unknown as Record<string, unknown>

const entry = (over: Partial<OngoingEntry> = {}): OngoingEntry => ({
  id: 'e1',
  workspaceId: null,
  sessionId: 'tab-gone',
  provider: 'claude',
  conversationId: 'conv-1',
  name: 'Accountant',
  cwd: '/work',
  note: '',
  originGroup: null,
  addedAt: 1,
  launch: {},
  ...over
})

const tab = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    name: id,
    cwd: '/work',
    folderName: 'work',
    alive: true,
    claudeMode: true,
    sessionType: 'local',
    claudeSessionId: `conv-${id}`,
    activityStatus: 'idle',
    ...over
  }) as never

let api: Record<string, ReturnType<typeof vi.fn>>
let saved: unknown

beforeEach(() => {
  saved = []
  api = {
    preferencesGet: vi.fn(async () => structuredClone(saved)),
    preferencesSet: vi.fn(async (_k: string, v: unknown) => {
      saved = structuredClone(v)
    }),
    listSessionRecords: vi.fn(async () => []),
    windowIdentity: vi.fn(async () => ({ windowKey: 'w1', windowId: 1 })),
    windowMoveSessions: vi.fn(async () => ({ moved: [], refused: [] })),
    killSession: vi.fn(async () => {}),
    discardSessionRecord: vi.fn(async () => {}),
    historyConversation: vi.fn(async () => ({ exists: true, turns: [] })),
    fleetStart: vi.fn(async (_owner: string, cwd: string) => ({
      id: 'tab-new',
      cwd,
      folderName: 'work',
      alive: true,
      claudeSessionId: 'conv-1'
    }))
  }
  g.electronAPI = api
  useSessionStore.setState({
    sessions: [],
    groups: [],
    selectedSessionIds: [],
    focusedSessionId: null,
    activeView: 'terminals'
  } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

async function keep(...entries: OngoingEntry[]): Promise<void> {
  saved = structuredClone(entries)
  useOngoingStore.setState({ entries, hydrated: true })
}

describe("the card reads the conversation's own account directory (PRDCT-4207)", () => {
  it("takes the running tab's directory, else the one the entry kept, never for Pi", () => {
    const e = entry({ launch: { claudeConfigDir: '/acct-kept' } })
    expect(conversationConfigDir(e, { claudeConfigDir: '/acct-live' })).toBe('/acct-live')
    expect(conversationConfigDir(e, undefined)).toBe('/acct-kept')
    expect(conversationConfigDir(entry(), null)).toBeUndefined()
    expect(
      conversationConfigDir({ ...e, provider: 'pi' }, { claudeConfigDir: '/acct-live' })
    ).toBeUndefined()
  })
})

describe('F7: a conversation with no transcript starts fresh under its own id', () => {
  it('starts it fresh when the transcript is missing', async () => {
    api.historyConversation.mockResolvedValueOnce({ exists: false, turns: [] })
    await keep(entry({ launch: { claudeConfigDir: '/acct' } }))
    await openOngoing('e1')
    expect(api.historyConversation).toHaveBeenCalledWith('/work', 'conv-1', 'claude', '/acct')
    const options = api.fleetStart.mock.calls[0][2] as Record<string, unknown>
    expect(options.claudeSessionId).toBe('conv-1')
    expect(options.resumeSessionId).toBeUndefined()
  })

  it('resumes it when the transcript is there', async () => {
    await keep(entry())
    await openOngoing('e1')
    const options = api.fleetStart.mock.calls[0][2] as Record<string, unknown>
    expect(options.resumeSessionId).toBe('conv-1')
    expect(options.claudeSessionId).toBeUndefined()
  })

  it('resumes it when the transcript read fails, rather than starting it over', async () => {
    api.historyConversation.mockRejectedValueOnce(new Error('main is busy'))
    await keep(entry())
    await openOngoing('e1')
    const options = api.fleetStart.mock.calls[0][2] as Record<string, unknown>
    expect(options.resumeSessionId).toBe('conv-1')
    expect(options.claudeSessionId).toBeUndefined()
  })

  it("never reads this Mac for a server tab's conversation, and resumes it", async () => {
    await keep(entry({ sessionId: resourceKey('session', 'studio', 'tab-9') }))
    api.fleetStart.mockResolvedValueOnce({
      id: resourceKey('session', 'studio', 'tab-10'),
      cwd: '/work',
      folderName: 'work',
      alive: true,
      claudeSessionId: 'conv-1'
    })
    await openOngoing('e1')
    expect(api.historyConversation).not.toHaveBeenCalled()
    const options = api.fleetStart.mock.calls[0][2] as Record<string, unknown>
    expect(options.resumeSessionId).toBe('conv-1')
  })
})

describe('R2-F4: End and Back wait for an open in flight', () => {
  function holdStart(): () => void {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    api.fleetStart.mockImplementationOnce(async (_o: string, cwd: string) => {
      await gate
      return { id: 'tab-new', cwd, folderName: 'work', alive: true, claudeSessionId: 'conv-1' }
    })
    return release
  }

  it('ends the conversation once the open lands, rather than doing nothing', async () => {
    await keep(entry())
    const release = holdStart()
    const opening = openOngoing('e1')
    await vi.waitFor(() => expect(api.fleetStart).toHaveBeenCalledTimes(1))
    let ended = false
    const ending = endOngoing('e1').then(() => (ended = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(ended).toBe(false)
    release()
    await opening
    await ending
    expect(useOngoingStore.getState().entries).toEqual([])
    expect(api.killSession).toHaveBeenCalledWith('tab-new')
    expect(useSessionStore.getState().sessions.some((s) => s.id === 'tab-new')).toBe(false)
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
  })

  it('puts it back in the sidebar once the open lands', async () => {
    await keep(entry())
    const release = holdStart()
    const opening = openOngoing('e1')
    await vi.waitFor(() => expect(api.fleetStart).toHaveBeenCalledTimes(1))
    const back = returnToSidebar('e1')
    release()
    await opening
    await back
    expect(useOngoingStore.getState().entries).toEqual([])
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['tab-new'])
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
  })

  it('refuses End and Back with a word once the open has run past the wait, never running beside it', async () => {
    vi.useFakeTimers()
    try {
      await keep(entry())
      const release = holdStart()
      const opening = openOngoing('e1')
      await vi.waitFor(() => expect(api.fleetStart).toHaveBeenCalledTimes(1))
      const back = returnToSidebar('e1')
      const end = endOngoing('e1')
      const backSettled = back.catch((err: unknown) => err)
      const endSettled = end.catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(WAIT_MS + 50)
      expect(await backSettled).toBeInstanceOf(OngoingStillOpening)
      expect(await endSettled).toBeInstanceOf(OngoingStillOpening)
      expect(api.fleetStart).toHaveBeenCalledTimes(1)
      expect(api.killSession).not.toHaveBeenCalled()
      release()
      await opening
      // The open, still the one action, lands its tab hidden in Ongoing.
      expect(useOngoingStore.getState().entries.map((e) => e.sessionId)).toEqual(['tab-new'])
      // And the conversation takes actions again once it is open.
      await endOngoing('e1')
      expect(useOngoingStore.getState().entries).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs two waiters one after the other: a Back queued after an End finds it ended', async () => {
    await keep(entry())
    let fail!: (err: Error) => void
    api.fleetStart.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
    const opening = openOngoing('e1')
    await vi.waitFor(() => expect(api.fleetStart).toHaveBeenCalledTimes(1))
    const end = endOngoing('e1')
    const back = returnToSidebar('e1')
    fail(new Error('could not start'))
    await opening
    await end
    await back
    expect(useOngoingStore.getState().entries).toEqual([])
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
  })

  it('still drops a second open while the first is starting', async () => {
    await keep(entry())
    const release = holdStart()
    const first = openOngoing('e1')
    await vi.waitFor(() => expect(api.fleetStart).toHaveBeenCalledTimes(1))
    expect(await openOngoing('e1')).toBeNull()
    release()
    await first
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
  })
})

describe('R3-N1: a tab End could not bring over leaves the window holding it', () => {
  it('stops the tab and tells the other windows it ended', async () => {
    await keep(entry({ sessionId: 'tab-w2' }))
    api.listSessionRecords.mockResolvedValue([{ id: 'tab-w2', live: true, windowKey: 'w2' }])
    api.windowMoveSessions.mockResolvedValue({
      moved: [],
      refused: [{ sessionId: 'tab-w2', reason: 'not-tmux' }]
    })
    const g2 = globalThis as unknown as {
      addEventListener?: unknown
      removeEventListener?: unknown
    }
    g2.addEventListener ??= () => {}
    g2.removeEventListener ??= () => {}
    const stop = startOngoingSync()
    const other = new BroadcastChannel(ONGOING_LOCK)
    const heard: unknown[] = []
    other.onmessage = (event) => heard.push(event.data)
    try {
      await endOngoing('e1')
      await vi.waitFor(() => expect(heard).toContainEqual({ ended: 'tab-w2' }))
      expect(api.killSession).toHaveBeenCalledWith('tab-w2')
      expect(useOngoingStore.getState().entries).toEqual([])
    } finally {
      other.close()
      stop()
    }
  })

  it('tells no window when the tab could not be stopped, since it still runs', async () => {
    await keep(entry({ sessionId: 'tab-w2' }))
    api.listSessionRecords.mockResolvedValue([{ id: 'tab-w2', live: true, windowKey: 'w2' }])
    api.windowMoveSessions.mockResolvedValue({ moved: [], refused: [] })
    api.killSession.mockRejectedValueOnce(new Error('unreachable'))
    const g2 = globalThis as unknown as {
      addEventListener?: unknown
      removeEventListener?: unknown
    }
    g2.addEventListener ??= () => {}
    g2.removeEventListener ??= () => {}
    const stop = startOngoingSync()
    const other = new BroadcastChannel(ONGOING_LOCK)
    const heard: unknown[] = []
    other.onmessage = (event) => heard.push(event.data)
    try {
      await endOngoing('e1')
      await new Promise((r) => setTimeout(r, 50))
      expect(heard.some((m) => typeof m === 'object' && m !== null && 'ended' in m)).toBe(false)
    } finally {
      other.close()
      stop()
    }
  })

  it("hands another window's ended tab to the window's handler, and a plain change to none", async () => {
    const g2 = globalThis as unknown as {
      addEventListener?: unknown
      removeEventListener?: unknown
    }
    g2.addEventListener ??= () => {}
    g2.removeEventListener ??= () => {}
    const onEnded = vi.fn()
    const stop = startOngoingSync(onEnded)
    const other = new BroadcastChannel(ONGOING_LOCK)
    try {
      other.postMessage('changed')
      other.postMessage({ ended: 'tab-w2' })
      await vi.waitFor(() => expect(onEnded).toHaveBeenCalledWith('tab-w2'))
      expect(onEnded).toHaveBeenCalledTimes(1)
    } finally {
      other.close()
      stop()
    }
  })

  it('the window holding it drops its row', () => {
    useSessionStore.setState({ sessions: [tab('tab-w2', { alive: false })] } as never)
    dropEndedTab('tab-w2')
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(emitTabClosed).toHaveBeenCalledTimes(1)
    dropEndedTab('tab-unknown')
    expect(emitTabClosed).toHaveBeenCalledTimes(1)
  })
})

describe("R3-N2: End keeps the person's own selection across the move", () => {
  const start = (): void =>
    useSessionStore.setState({
      sessions: [tab('home'), tab('other')],
      selectedSessionIds: ['home'],
      focusedSessionId: 'home',
      activeView: 'ongoing'
    } as never)
  const moveFocuses = (): void =>
    useSessionStore.setState({
      selectedSessionIds: ['moved'],
      focusedSessionId: 'moved',
      activeView: 'terminals'
    } as never)
  const personPicks = (): void =>
    useSessionStore.setState({
      selectedSessionIds: ['other'],
      focusedSessionId: 'other',
      activeView: 'terminals'
    } as never)
  const view = (): unknown => {
    const s = useSessionStore.getState()
    return [s.activeView, s.selectedSessionIds, s.focusedSessionId]
  }

  it("undoes the move's own focus", () => {
    start()
    const kept = keepPersonsView('moved')
    moveFocuses()
    kept.restore()
    expect(view()).toEqual(['ongoing', ['home'], 'home'])
  })

  it('keeps a tab the person picked after the move', () => {
    start()
    const kept = keepPersonsView('moved')
    moveFocuses()
    personPicks()
    kept.restore()
    expect(view()).toEqual(['terminals', ['other'], 'other'])
  })

  it('puts back a tab the person picked before the move focused its own', () => {
    start()
    const kept = keepPersonsView('moved')
    personPicks()
    moveFocuses()
    kept.restore()
    expect(view()).toEqual(['terminals', ['other'], 'other'])
  })

  it('changes nothing when the move took no focus', () => {
    start()
    const kept = keepPersonsView('moved')
    kept.restore()
    expect(view()).toEqual(['ongoing', ['home'], 'home'])
  })
})
