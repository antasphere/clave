/**
 * Closing a tab (PRDCT-5315): the row leaves before the stop returns; a tab
 * of a server whose stop fails comes back where it sat with the reason; a
 * tab of this Mac whose stop throws stays closed; a server's snapshot during
 * the stop does not bring the row back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const m = new Map<string, string>()
  const g = globalThis as unknown as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: () => null,
    length: 0
  }
  g.window = globalThis
  // The agent tools' dispatcher listens on the window at import.
  g.addEventListener = () => {}
  g.removeEventListener = () => {}
  g.document = { addEventListener: () => {}, removeEventListener: () => {}, hidden: true }
})
vi.mock('./exchange-capture', async (original) => ({
  ...(await original<typeof import('./exchange-capture')>()),
  emitTabClosed: vi.fn()
}))

import { useSessionStore } from '../store/session-store'
import { applyFleetSnapshot, useFleetStore } from '../store/fleet-store'
import { useCloseErrorsStore } from '../store/close-errors-store'
import { setSessionDraft, useDraftStore } from '../views/draft-store'
import { emitTabClosed } from './exchange-capture'
import { closeFailureReason, closeTab } from './close-tab'
import { registerLinkedFlusher } from '../store/linked-document-store'
import { performGroupDissolve } from './group-dissolve'
import { initMcpDispatcher } from './mcp-dispatcher'
import { resourceKey } from '@clave/contract/fleet'

const g = globalThis as unknown as Record<string, unknown>
const tab = (id: string): never =>
  ({
    id,
    name: id,
    cwd: '/work',
    folderName: 'work',
    alive: true,
    claudeMode: true,
    sessionType: 'local',
    activityStatus: 'idle'
  }) as never

const SERVER = 'studio'
const remote = (id: string): string => resourceKey('session', SERVER, id)

let api: { killSession: ReturnType<typeof vi.fn> }
/** The stop, held open until the test settles it. */
function pendingKill(): { resolve: () => void; reject: (e: unknown) => void } {
  let settle!: { resolve: () => void; reject: (e: unknown) => void }
  api.killSession.mockImplementationOnce(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
  )
  return {
    resolve: () => settle.resolve(),
    reject: (e) => settle.reject(e)
  }
}
const ids = (): string[] => useSessionStore.getState().sessions.map((s) => s.id)

beforeEach(() => {
  api = { killSession: vi.fn(async () => {}) }
  g.electronAPI = api
  useCloseErrorsStore.setState({ errors: {} })
  useDraftStore.setState({ drafts: {} })
  useFleetStore.setState({
    connections: [{ id: SERVER, name: 'Studio', url: 'http://x', enabled: true }] as never
  })
})
afterEach(() => vi.clearAllMocks())

function seed(
  sessions: string[],
  groups: { id: string; sessionIds: string[] }[],
  order: string[]
): void {
  useSessionStore.setState({
    sessions: sessions.map(tab),
    groups: groups.map((gr) => ({
      ...gr,
      name: gr.id,
      collapsed: false,
      cwd: null,
      terminals: []
    })),
    displayOrder: order,
    selectedSessionIds: [],
    focusedSessionId: null
  } as never)
}

describe('the row leaves before the stop returns', () => {
  it('a tab of this Mac: gone while its stop still runs, and the stop was asked', async () => {
    seed(['a', 'b'], [], ['a', 'b'])
    const kill = pendingKill()
    const closing = closeTab('a')
    expect(ids()).toEqual(['b'])
    expect(api.killSession).toHaveBeenCalledWith('a')
    expect(emitTabClosed).toHaveBeenCalledTimes(1)
    kill.resolve()
    await expect(closing).resolves.toEqual({ closed: true })
    expect(ids()).toEqual(['b'])
  })

  it('a tab of a server: gone while its stop still runs', async () => {
    const r = remote('r1')
    seed([r], [], [r])
    const kill = pendingKill()
    const closing = closeTab(r)
    expect(ids()).toEqual([])
    kill.resolve()
    await expect(closing).resolves.toEqual({ closed: true })
    expect(ids()).toEqual([])
    expect(useCloseErrorsStore.getState().errors[r]).toBeUndefined()
  })
})

describe('a server tab whose stop fails comes back with the reason', () => {
  it('in its group, after its neighbour, its unsent prompt kept, the mark set', async () => {
    const [a, b, c] = [remote('a'), remote('b'), remote('c')]
    const grp = resourceKey('group', SERVER, 'g')
    seed([a, b, c], [{ id: grp, sessionIds: [a, b, c] }], [grp])
    setSessionDraft(b, 'half a sentence')
    const kill = pendingKill()
    const closing = closeTab(b)
    expect(ids()).not.toContain(b)
    kill.reject(new Error('connect ECONNREFUSED 10.0.0.2:4100'))
    const outcome = await closing
    expect(outcome).toEqual({
      closed: false,
      reason: 'Studio could not close this tab: connect ECONNREFUSED 10.0.0.2:4100'
    })
    expect(ids()).toContain(b)
    expect(useSessionStore.getState().groups[0].sessionIds).toEqual([a, b, c])
    expect(useDraftStore.getState().drafts[b]).toBe('half a sentence')
    expect(useCloseErrorsStore.getState().errors[b]).toBe(outcome.closed ? '' : outcome.reason)
  })

  it('a second close that succeeds clears the mark', async () => {
    const r = remote('r')
    seed([r], [], [r])
    api.killSession.mockRejectedValueOnce(new Error('refused'))
    await closeTab(r)
    expect(useCloseErrorsStore.getState().errors[r]).toBeDefined()
    await closeTab(r)
    expect(useCloseErrorsStore.getState().errors[r]).toBeUndefined()
    expect(ids()).toEqual([])
  })
})

describe('a tab of this Mac whose stop throws stays closed', () => {
  it('no row back, no mark', async () => {
    seed(['a'], [], ['a'])
    api.killSession.mockRejectedValueOnce(new Error('Unknown session: a'))
    await expect(closeTab('a')).resolves.toEqual({ closed: true })
    expect(ids()).toEqual([])
    expect(useCloseErrorsStore.getState().errors).toEqual({})
  })
})

describe("a server's snapshot during the stop", () => {
  const snapshotListing = (sessionIds: string[]): never =>
    ({
      serverId: SERVER,
      sessions: sessionIds.map((id) => ({ id, cwd: '/work', state: 'idle', provider: 'claude' })),
      records: [],
      layout: { revision: 1, groups: [], displayOrder: sessionIds }
    }) as never

  it('does not bring the closing row back, and lists it again once the stop failed', async () => {
    const [r, s] = [remote('r'), remote('s')]
    seed([r, s], [], [r, s])
    const kill = pendingKill()
    const closing = closeTab(r)
    applyFleetSnapshot(snapshotListing([r, s]))
    expect(ids()).toEqual([s])
    kill.reject(new Error('refused'))
    await closing
    expect(ids()).toContain(r)
    applyFleetSnapshot(snapshotListing([r, s]))
    expect(ids().sort()).toEqual([r, s].sort())
  })
})

describe('the sentence on the mark', () => {
  it('the failure in its own words, one line, after the server name', () => {
    expect(closeFailureReason(new Error('Error: socket\n  hang up'), 'Studio')).toBe(
      'Studio could not close this tab: socket hang up'
    )
  })
  it('says the server did not answer when the failure has no words', () => {
    expect(closeFailureReason(new Error(''), 'Studio')).toBe(
      'Studio could not close this tab: the server did not answer'
    )
  })
  it('is cut at a readable length', () => {
    expect(closeFailureReason(new Error('x'.repeat(1000)), 'S').length).toBeLessThan(300)
  })
})

// The verifier's round 1 (PRDCT-5315): each test below went red on the
// change as first written, or stayed green with the behaviour removed.

describe('a close that fails keeps the session view served', () => {
  it("the tab's serving process is neither stopped nor dropped when its server refuses the close", async () => {
    const [r, serving] = [remote('owner'), remote('serving')]
    useSessionStore.setState({
      sessions: [
        { ...(tab(r) as object), view: { url: 'http://localhost:5173', serverSessionId: serving } },
        tab(serving)
      ],
      groups: [],
      displayOrder: [r],
      selectedSessionIds: [],
      focusedSessionId: null
    } as never)
    api.killSession.mockImplementation(async (id: string) => {
      if (id === r) throw new Error('refused')
    })
    expect((await closeTab(r)).closed).toBe(false)
    expect(api.killSession.mock.calls.map((c) => c[0])).not.toContain(serving)
    expect(ids()).toEqual(expect.arrayContaining([r, serving]))
  })

  it('a close that goes through stops the serving process after the tab itself', async () => {
    const [r, serving] = [remote('owner2'), remote('serving2')]
    useSessionStore.setState({
      sessions: [
        { ...(tab(r) as object), view: { url: 'http://localhost:5173', serverSessionId: serving } },
        tab(serving)
      ],
      groups: [],
      displayOrder: [r],
      selectedSessionIds: [],
      focusedSessionId: null
    } as never)
    await closeTab(r)
    expect(api.killSession.mock.calls.map((c) => c[0])).toEqual([r, serving])
    expect(ids()).toEqual([])
  })
})

describe('a linked document is saved before the row goes', () => {
  it('the panel saves while its tab is still in the store', async () => {
    seed(['a', 'b'], [], ['a', 'b'])
    let presentAtSave: boolean | null = null
    const off = registerLinkedFlusher(
      'a',
      async () => {
        presentAtSave = ids().includes('a')
      },
      () => false
    )
    await closeTab('a')
    off()
    expect(presentAtSave).toBe(true)
    expect(ids()).toEqual(['b'])
  })
})

describe('the hold on snapshots ends with the close', () => {
  it('a server tab closed for good is listed again by a later snapshot that names it', async () => {
    const r = remote('h')
    seed([r], [], [r])
    await closeTab(r)
    applyFleetSnapshot({
      serverId: SERVER,
      sessions: [{ id: r, cwd: '/work', state: 'idle', provider: 'claude' }],
      records: [],
      layout: { revision: 1, groups: [], displayOrder: [r] }
    } as never)
    expect(ids()).toContain(r)
  })
})

describe('a mark lives as long as its tab', () => {
  it("is dropped when the tab's server stops listing it", async () => {
    const r = remote('m')
    seed([r], [], [r])
    api.killSession.mockRejectedValueOnce(new Error('refused'))
    await closeTab(r)
    expect(useCloseErrorsStore.getState().errors[r]).toBeDefined()
    applyFleetSnapshot({
      serverId: SERVER,
      sessions: [],
      records: [],
      layout: { revision: 2, groups: [], displayOrder: [] }
    } as never)
    expect(ids()).not.toContain(r)
    expect(useCloseErrorsStore.getState().errors[r]).toBeUndefined()
  })
})

describe('two closes of the same tab', () => {
  it('the second joins the first: one stop, one outcome', async () => {
    const r = remote('twice')
    seed([r], [], [r])
    const kill = pendingKill()
    const first = closeTab(r)
    const second = closeTab(r)
    expect(second).toBe(first)
    kill.reject(new Error('refused'))
    await first
    expect(api.killSession).toHaveBeenCalledTimes(1)
    expect(ids()).toEqual([r])
  })
})

describe("a group's Delete when a server refuses a tab of it", () => {
  const grp = resourceKey('group', SERVER, 'g')
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('the rows and the group leave before any stop returns', async () => {
    const [a, b] = [remote('a'), remote('b')]
    seed([a, b, 'loose'], [{ id: grp, sessionIds: [a, b] }], ['loose', grp])
    const releases: (() => void)[] = []
    api.killSession.mockImplementation(() => new Promise<void>((r) => releases.push(() => r())))
    const done = performGroupDissolve(grp, 'delete')
    expect(ids()).toEqual(['loose'])
    expect(useSessionStore.getState().groups).toEqual([])
    releases.forEach((r) => r())
    await done
  })

  it('the group comes back in its place the moment a refusal lands, holding that tab', async () => {
    const [a, b] = [remote('a'), remote('b')]
    seed([a, b, 'loose'], [{ id: grp, sessionIds: [a, b] }], ['loose', grp])
    let releaseB!: () => void
    api.killSession.mockImplementation((id: string) =>
      id === a
        ? Promise.reject(new Error('refused'))
        : new Promise<void>((r) => {
            releaseB = () => r()
          })
    )
    const done = performGroupDissolve(grp, 'delete')
    await flush()
    const during = useSessionStore.getState()
    expect(during.groups.find((x) => x.id === grp)?.sessionIds).toEqual([a])
    expect(during.displayOrder).toEqual(['loose', grp])
    releaseB()
    await done
    expect(useSessionStore.getState().groups.find((x) => x.id === grp)?.sessionIds).toEqual([a])
  })

  it('never names a tab that was closed again before the group came back', async () => {
    const [a, b] = [remote('a'), remote('b')]
    seed([a, b], [{ id: grp, sessionIds: [a, b] }], [grp])
    let releaseB!: () => void
    let refuseA!: (e: Error) => void
    api.killSession.mockImplementation((id: string) =>
      id === a
        ? new Promise<void>((_, reject) => {
            refuseA = reject
          })
        : new Promise<void>((r) => {
            releaseB = () => r()
          })
    )
    const done = performGroupDissolve(grp, 'delete')
    refuseA(new Error('refused'))
    await flush()
    // a is back in its group; the person closes it again and the server takes it.
    api.killSession.mockImplementation(async () => {})
    await closeTab(a)
    releaseB()
    await done
    const after = useSessionStore.getState()
    expect(after.sessions.map((s) => s.id)).toEqual([])
    expect(after.groups.flatMap((x) => x.sessionIds)).not.toContain(a)
  })
})

describe("a group's Delete when its server is gone (round 2)", () => {
  it('the tabs come back in their old order whatever order the refusals land in', async () => {
    const [a, b, c] = [remote('oa'), remote('ob'), remote('oc')]
    const grp = resourceKey('group', SERVER, 'order')
    seed([a, b, c], [{ id: grp, sessionIds: [a, b, c] }], [grp])
    const refuse: Record<string, (e: Error) => void> = {}
    api.killSession.mockImplementation(
      (id: string) =>
        new Promise<void>((_, reject) => {
          refuse[id] = reject
        })
    )
    const done = performGroupDissolve(grp, 'delete')
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    const seen: string[][] = []
    for (const id of [a, b, c]) {
      refuse[id](new Error('unreachable'))
      await tick()
      seen.push(useSessionStore.getState().groups.find((x) => x.id === grp)?.sessionIds ?? [])
    }
    await done
    expect(seen).toEqual([[a], [a, b], [a, b, c]])
    expect([a, b, c].every((id) => useCloseErrorsStore.getState().errors[id])).toBe(true)
  })
})

describe('a tab of this Mac whose stop throws, with a page served', () => {
  it('its serving process is stopped and dropped all the same', async () => {
    useSessionStore.setState({
      sessions: [
        {
          ...(tab('m') as object),
          view: { url: 'http://localhost:5173', serverSessionId: 'm-serving' }
        },
        tab('m-serving')
      ],
      groups: [],
      displayOrder: ['m'],
      selectedSessionIds: [],
      focusedSessionId: null
    } as never)
    api.killSession.mockImplementation(async (id: string) => {
      if (id === 'm') throw new Error('Unknown session: m')
    })
    await closeTab('m')
    expect(api.killSession.mock.calls.map((c) => c[0])).toEqual(['m', 'm-serving'])
    expect(ids()).toEqual([])
  })
})

describe('a mark and the other tabs', () => {
  it('stays when another tab opens or closes', async () => {
    const [r, other] = [remote('keep'), 'other']
    seed([r, other], [], [r, other])
    api.killSession.mockRejectedValueOnce(new Error('refused'))
    await closeTab(r)
    useSessionStore.getState().addSession(tab('newcomer'))
    await closeTab(other)
    expect(useCloseErrorsStore.getState().errors[r]).toBeDefined()
  })
})

describe("an agent's close tool", () => {
  it('answers an error with the reason when the server refuses, and the tab comes back', async () => {
    const r = remote('agent')
    seed([r], [], [r])
    api.killSession.mockRejectedValue(new Error('refused'))
    const bridge = api as unknown as Record<string, unknown>
    let receive: (m: unknown) => void = () => {}
    const answer = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bridge.onMcpCommand = (h: typeof receive) => {
        receive = h
        return () => {}
      }
      bridge.mcpRespond = resolve
    })
    const off = initMcpDispatcher()
    receive({ requestId: 'c1', command: 'closeSession', payload: { sessionId: r } })
    const got = await answer
    off()
    expect(got.ok).toBe(false)
    expect(got.error).toContain('Studio could not close this tab: refused')
    expect(ids()).toContain(r)
  })
})
