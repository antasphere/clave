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
import type { Session, SessionGroup } from '../store/session-types'

let useSessionStore: typeof import('../store/session-store').useSessionStore
let placeRecords: typeof import('./adopt-record').placeRecords
let adoptRecord: typeof import('./adopt-record').adoptRecord
let adoptServerStartedSessions: typeof import('./adopt-record').adoptServerStartedSessions
let RESTORE_CONCURRENCY: number

/** Each spawn waits for the test to answer it, by session id. */
const pending = new Map<string, (ok: boolean) => void>()
let inFlight = 0
let maxInFlight = 0
let listCalls = 0
const killed: string[] = []
/** Every spawn asked for, by the id it adopts, in order. */
const spawned: string[] = []
/** What the by-id records read answers. */
let byIdRecords: SessionRecord[] = []
/** What the kernel's session list answers: id and state. */
let kernel: { id: string; state: string }[] = []

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async (id: string) => {
      killed.push(id)
    },
    captureTabClosed: () => {},
    sessionsList: async () => {
      listCalls++
      return kernel
    },
    listSessionRecords: async (filter?: { ids?: string[] }) =>
      byIdRecords.filter((r) => !filter?.ids || filter.ids.includes(r.id)),
    spawnSession: (cwd: string, options: { adoptSessionId: string }) => {
      spawned.push(options.adoptSessionId)
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
  adoptRecord = lib.adoptRecord
  adoptServerStartedSessions = lib.adoptServerStartedSessions
  RESTORE_CONCURRENCY = lib.RESTORE_CONCURRENCY
})

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    groups: [],
    selectedSessionIds: [],
    focusedSessionId: null
  })
  pending.clear()
  inFlight = 0
  maxInFlight = 0
  listCalls = 0
  killed.length = 0
  spawned.length = 0
  byIdRecords = []
  kernel = []
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

  it('ends the session of a tab closed while it was restoring, and adopts nothing for it', async () => {
    const { attached } = placeRecords([record('closed'), record('kept')], null)
    // The person closes the row before its spawn has answered.
    useSessionStore.setState((state) => ({
      sessions: state.sessions.filter((s) => s.id !== 'closed')
    }))
    await flush()
    for (const answer of [...pending.values()]) answer(true)
    expect(await attached).toEqual(['kept'])
    expect(killed).toEqual(['closed'])
    expect(ids()).toEqual(['kept'])
  })
})

/**
 * Issue #183: after a renderer reload the server still holds every chat it
 * had registered, most of them with their provider never started. The restore
 * asked the server to spawn each of them again under the same id; every
 * spawn failed as a duplicate, and the failure took the tab out of the store
 * and out of its group. A record the host already runs (`running`) is taken
 * in from the record alone: no spawn, the same id, its group kept, and a chat
 * whose provider was not started stays dormant until it is opened.
 */
describe('a record the host already runs', () => {
  const chat = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
    ({
      id,
      cwd: '/w',
      folderName: 'w',
      transport: 'events',
      running: true,
      live: false,
      claudeMode: true,
      codexMode: false,
      antigravityMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      ...extra
    }) as SessionRecord
  const claudeDormant = chat('claude-dormant', {
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Renamed by the person',
    userRenamed: true,
    workspaceId: 'ws-a',
    view: { pluginId: 'clave.chat-view', viewId: 'chat' } as unknown as SessionRecord['view']
  })
  const codexDormant = chat('codex-dormant', {
    claudeMode: false,
    codexMode: true,
    codexThreadId: 'thread-1',
    codexAccountId: 'acct-2',
    codexAccountLabel: 'Work'
  })
  const claudeStarted = chat('claude-started', { live: true })
  const byId = (id: string): Session | undefined =>
    useSessionStore.getState().sessions.find((s) => s.id === id)
  const group = (sessionIds: string[]): SessionGroup => ({
    id: 'g1',
    name: 'Kept',
    sessionIds,
    collapsed: false,
    cwd: null,
    terminals: []
  })

  it('is placed and settled without a spawn, in the group that holds it', async () => {
    useSessionStore.setState({ groups: [group(['claude-dormant', 'codex-dormant'])] })
    const { placed, attached } = placeRecords([claudeDormant, codexDormant, claudeStarted], null)
    await flush()
    expect(spawned).toEqual([])
    expect(placed).toEqual(['claude-dormant', 'codex-dormant', 'claude-started'])
    expect((await attached).sort()).toEqual(['claude-dormant', 'claude-started', 'codex-dormant'])
    expect(ids()).toEqual(['claude-dormant', 'codex-dormant', 'claude-started'])
    expect(restoring()).toEqual([])
    expect(useSessionStore.getState().groups[0].sessionIds).toEqual([
      'claude-dormant',
      'codex-dormant'
    ])
  })

  it('keeps what the record says: names, workspace, view, provider refs', async () => {
    const { attached } = placeRecords([claudeDormant, codexDormant], 'ws-active')
    await attached
    expect(byId('claude-dormant')).toMatchObject({
      name: 'Renamed by the person',
      userRenamed: true,
      workspaceId: 'ws-a',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      claudeMode: true,
      view: { pluginId: 'clave.chat-view', viewId: 'chat' }
    })
    expect(byId('codex-dormant')).toMatchObject({
      codexMode: true,
      claudeMode: false,
      codexAccountId: 'acct-2',
      codexAccountLabel: 'Work',
      workspaceId: 'ws-active'
    })
  })

  it('stays dormant when its provider was never started, and is alive (registered)', async () => {
    const { attached } = placeRecords([claudeDormant, codexDormant, claudeStarted], null)
    await attached
    expect(byId('claude-dormant')).toMatchObject({ dormant: true, alive: true })
    expect(byId('codex-dormant')).toMatchObject({ dormant: true, alive: true })
    expect(byId('claude-started')?.dormant).toBeUndefined()
    expect(byId('claude-started')?.alive).toBe(true)
  })

  it('is never spawned by a move either', async () => {
    expect(await adoptRecord(claudeDormant, null)).toBe('claude-dormant')
    expect(spawned).toEqual([])
    expect(byId('claude-dormant')).toMatchObject({ dormant: true, alive: true })
  })

  it('is taken in by the layout path with its dormancy', async () => {
    byIdRecords = [claudeDormant, claudeStarted, chat('cold', { running: undefined })]
    await adoptServerStartedSessions(['claude-dormant', 'claude-started', 'cold'])
    expect(spawned).toEqual([])
    // A record nothing runs is the restore's to bring back, not this path's.
    expect(ids()).toEqual(['claude-dormant', 'claude-started'])
    expect(byId('claude-dormant')).toMatchObject({ dormant: true, alive: true })
    expect(byId('claude-started')?.dormant).toBeUndefined()
  })

  it('a terminal the host runs is placed live, in its group, without a spawn', async () => {
    useSessionStore.setState({ groups: [group(['term'])] })
    const term = {
      ...record('term'),
      tmuxName: 'clave-term',
      live: true,
      running: true
    } as SessionRecord
    const { attached } = placeRecords([term], null)
    expect(await attached).toEqual(['term'])
    expect(spawned).toEqual([])
    expect(byId('term')).toMatchObject({ alive: true })
    expect(byId('term')?.dormant).toBeUndefined()
    expect(useSessionStore.getState().groups[0].sessionIds).toEqual(['term'])
  })

  // A chat whose provider ended is still held by the host, unstarted to the
  // records (`live` false, as an unopened one). The kernel's own word tells
  // the two apart: an ended one comes back ended, never as a usable tab.
  it('comes back ended when the kernel says its session ended', async () => {
    kernel = [
      { id: 'claude-dormant', state: 'idle' },
      { id: 'codex-dormant', state: 'ended' }
    ]
    const { attached } = placeRecords([claudeDormant, codexDormant], null)
    await attached
    await flush()
    expect(byId('claude-dormant')).toMatchObject({ alive: true, dormant: true })
    expect(byId('codex-dormant')).toMatchObject({ alive: false, activityStatus: 'ended' })
    expect(spawned).toEqual([])
  })

  it('the layout path brings an ended chat back ended too', async () => {
    kernel = [{ id: 'claude-dormant', state: 'ended' }]
    byIdRecords = [claudeDormant]
    await adoptServerStartedSessions(['claude-dormant'])
    expect(byId('claude-dormant')).toMatchObject({ alive: false, activityStatus: 'ended' })
  })

  it('a cold chat record still spawns, dormant, as before', async () => {
    const cold = chat('cold', { running: undefined })
    const { attached } = placeRecords([cold], null)
    await flush()
    expect(spawned).toEqual(['cold'])
    pending.get('cold')!(true)
    await attached
    expect(byId('cold')?.dormant).toBe(true)
  })

  it('a terminal record still spawns, live or dead, as before', async () => {
    const live = { ...record('pty-live'), tmuxName: 'clave-live', live: true } as SessionRecord
    const dead = record('pty-dead')
    const { attached } = placeRecords([live, dead], null)
    await flush()
    expect(spawned).toEqual(['pty-live', 'pty-dead'])
    for (const answer of [...pending.values()]) answer(true)
    expect((await attached).sort()).toEqual(['pty-dead', 'pty-live'])
  })

  it('closed while the restore runs: the close owns it, nothing is killed here', async () => {
    const { attached } = placeRecords([claudeDormant], null)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.filter((s) => s.id !== 'claude-dormant')
    }))
    await attached
    expect(killed).toEqual([])
    expect(ids()).toEqual([])
  })
})
