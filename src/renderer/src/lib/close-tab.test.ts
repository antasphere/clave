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
})
vi.mock('./exchange-capture', () => ({ emitTabClosed: vi.fn() }))

import { useSessionStore } from '../store/session-store'
import { applyFleetSnapshot, useFleetStore } from '../store/fleet-store'
import { useCloseErrorsStore } from '../store/close-errors-store'
import { setSessionDraft, useDraftStore } from '../views/draft-store'
import { emitTabClosed } from './exchange-capture'
import { closeFailureReason, closeTab } from './close-tab'
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
