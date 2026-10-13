/**
 * What a window does with a copy of the registry and the pins that arrives
 * from outside: another window's change, or the server's own copy read at
 * the push socket's welcome (wave 5, lane A, PRDCT-3405 and PRDCT-3264).
 *
 * The copy carries a stamp, the revision of the state in the process that
 * holds it and that process's id. The window keeps the last stamp it loaded,
 * wrote or took in: a copy that is not newer is dropped, which is what keeps
 * the catch-up read at a welcome from resetting the pins the boot refresh
 * wrote after the read went out; a copy that lands while the window's own
 * writes are in flight waits for them; a copy from another instance is
 * adopted, the window keeping what it shows and writing it there. And a copy
 * that is folded is recorded as persisted BEFORE the store is set, so the
 * persistence subscriber writes nothing back (the fold's old order wrote
 * every folded partition back with this window's origin, one change landing
 * as three writes).
 *
 * The stores read localStorage and the preload bridge at import time, so
 * both are stubbed first, as group-dissolve.test.ts does; the bridge's
 * workspace writes answer when the test says, with the stamp it gives.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedGroup } from '../store/session-types'

// The pinned store resolves a pin's account through the usage store, which
// binds window events at import; the test needs no account.
vi.mock('./switch-account', () => ({
  resolveAccountRef: () => ({ id: 'default', label: 'Default' })
}))

type Stamp = { revision: number; instance: string }
type State = { workspaces: unknown[]; pins: unknown[] } & Partial<Stamp>
type Write = {
  kind: 'pins' | 'registry'
  scope?: string | null
  pins?: unknown[]
  land: (stamp: Stamp | { ok: false }) => Promise<void>
}

/** The writes the bridge received and has not answered yet. */
const writes: Write[] = []
const WS = { id: 'ws1', name: 'One', rootDir: '/w', profileFile: null, createdAt: 1 }
/** What `workspaceLoad` answers at the next boot. */
let loaded: State & { version: 1; lastActiveWorkspaceId: null; pinsMigrated: true } = boot(0)
/** The listener the module bound on `onWorkspaceStateChanged`. */
let fold: ((state: State) => void) | null = null

function boot(revision: number, pins: unknown[] = [], instance = 'main'): typeof loaded {
  return {
    version: 1,
    workspaces: [WS],
    lastActiveWorkspaceId: null,
    pinsMigrated: true,
    pins,
    revision,
    instance
  }
}

const pin = (id: string, name = id, workspaceId: string | null = 'ws1'): PinnedGroup =>
  ({
    id,
    name,
    cwd: '/w',
    color: null,
    prompt: null,
    sessions: [],
    terminals: [],
    createdAt: 1,
    filePath: null,
    rootDir: null,
    workspaceRoot: null,
    toolbar: false,
    logo: null,
    category: null,
    discoveredBy: null,
    workspaceId,
    activeGroupId: null,
    visible: false
  }) as unknown as PinnedGroup

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let actions: typeof import('./workspace-actions')
let usePinnedStore: typeof import('../store/pinned-store').usePinnedStore
let useWorkspaceStore: typeof import('../store/workspace-store').useWorkspaceStore

beforeAll(() => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  const pending = (kind: Write['kind'], extra: Partial<Write>): Promise<unknown> =>
    new Promise((resolve) => {
      writes.push({
        kind,
        ...extra,
        land: async (answer) => {
          resolve('ok' in answer ? answer : { ok: true, ...answer })
          await tick()
        }
      })
    })
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async () => undefined,
    captureTabClosed: () => {},
    windowIdentity: async () => ({
      windowId: 1,
      windowKey: 'win-1',
      workspaceId: 'ws1',
      isPrimary: true
    }),
    workspaceLoad: async () => loaded,
    workspaceUpdatePins: (scope: string | null, pins: unknown[]) =>
      pending('pins', { scope, pins }),
    workspaceUpdateRegistry: () => pending('registry', {}),
    windowSetWorkspace: async () => ({ ok: true }),
    onWindowIdentityChanged: () => () => {},
    onWorkspaceStateChanged: (cb: (state: State) => void) => {
      fold = cb
      return () => {}
    },
    watchClaveFile: async () => undefined,
    unwatchClaveFile: async () => undefined
  }
})

beforeEach(async () => {
  // Fresh module state per test: the stamp, the in-flight count and the
  // persisted record are the module's own.
  vi.resetModules()
  writes.length = 0
  fold = null
  loaded = boot(0)
  actions = await import('./workspace-actions')
  usePinnedStore = (await import('../store/pinned-store')).usePinnedStore
  useWorkspaceStore = (await import('../store/workspace-store')).useWorkspaceStore
})

const names = (): string[] => usePinnedStore.getState().pinnedGroups.map((p) => p.name)
const landAll = async (stamp: Stamp): Promise<void> => {
  for (const w of writes.splice(0)) await w.land(stamp)
}
const fromServer = (revision: number, pins: unknown[], instance = 'main'): State => ({
  workspaces: [WS],
  pins,
  revision,
  instance
})

describe('a fold is recorded as persisted before the store is set (PRDCT-3264)', () => {
  it('writes nothing back when it takes in another window’s change', async () => {
    loaded = boot(3, [pin('a', 'A')])
    await actions.bootWorkspaces()
    expect(writes).toHaveLength(0)
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 3, instance: 'main' })
    fold!(fromServer(4, [pin('a', 'A'), pin('b', 'B')]))
    await tick()
    expect(names()).toEqual(['A', 'B'])
    expect(writes).toHaveLength(0)
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 4, instance: 'main' })
    // A change of this window's own after the fold is written once, as before.
    usePinnedStore.getState().addPinnedGroup(pin('c', 'C'))
    expect(writes.map((w) => w.kind)).toEqual(['pins'])
    expect(writes[0].scope).toBe('ws1')
  })

  it('keeps the runtime state of a pin it already shows, and takes a deletion made elsewhere', async () => {
    loaded = boot(1, [pin('a', 'A'), pin('b', 'B')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().setActiveGroupId('a', 'g-live')
    usePinnedStore.getState().setVisible('a', true)
    fold!(fromServer(2, [pin('a', 'A renamed')]))
    expect(names()).toEqual(['A renamed'])
    expect(usePinnedStore.getState().pinnedGroups[0]).toMatchObject({
      activeGroupId: 'g-live',
      visible: true
    })
    expect(writes).toHaveLength(0)
  })
})

describe('a window keeps the pins it just loaded (PRDCT-3405)', () => {
  it('drops a copy that is not newer than what it holds', async () => {
    loaded = boot(5, [pin('a', 'A')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    await landAll({ revision: 6, instance: 'main' })
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 6, instance: 'main' })
    // The server's copy read before the write and answered after it.
    fold!(fromServer(5, [pin('a', 'A')]))
    fold!(fromServer(6, [pin('a', 'A'), pin('b', 'B')]))
    expect(names()).toEqual(['A', 'B'])
    expect(writes).toHaveLength(0)
    // A newer one lands.
    fold!(fromServer(7, [pin('b', 'B')]))
    expect(names()).toEqual(['B'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 7, instance: 'main' })
  })

  it('holds a copy while its own write is in flight, and drops it once the write’s stamp overtakes it', async () => {
    // The race lane C of wave 4 met: the catch-up read goes out, the boot
    // refresh adds a pin and writes, the read answers with the older copy.
    loaded = boot(5, [pin('a', 'A')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    expect(writes).toHaveLength(1)
    fold!(fromServer(5, [pin('a', 'A')]))
    // Held: nothing folded over the pin the window just added.
    expect(names()).toEqual(['A', 'B'])
    await landAll({ revision: 6, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 6, instance: 'main' })
    expect(writes).toHaveLength(0)
  })

  it('folds the newest copy held during its writes once they land, when it is still newer', async () => {
    loaded = boot(5, [pin('a', 'A')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    // Another window wrote twice meanwhile, the second after this window's
    // write landed on the server: 6 is this window's, 7 the other's.
    fold!(fromServer(7, [pin('a', 'A'), pin('b', 'B'), pin('c', 'C')]))
    fold!(fromServer(5, [pin('a', 'A')]))
    expect(names()).toEqual(['A', 'B'])
    await landAll({ revision: 6, instance: 'main' })
    expect(names()).toEqual(['A', 'B', 'C'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 7, instance: 'main' })
    expect(writes).toHaveLength(0)
  })

  it('waits for every write in flight, not the first to land', async () => {
    loaded = boot(1, [])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('a', 'A'))
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B', null))
    // The second change re-sends the ws1 partition too, its first write
    // still out (the persistence subscriber compares with what LANDED): three
    // writes in flight, and the held copy waits for the last of them.
    expect(writes.map((w) => w.scope)).toEqual(['ws1', 'ws1', null])
    fold!(fromServer(1, []))
    await writes[0].land({ revision: 2, instance: 'main' })
    await writes[1].land({ revision: 3, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    await writes[2].land({ revision: 4, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 4, instance: 'main' })
  })

  it('adopts a copy from another instance: keeps what it shows and writes it there', async () => {
    // Attached, a window that booted on main's copy and reached the server
    // later: the server's stamp is another instance's.
    loaded = boot(9, [pin('a', 'A')], 'main')
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    await landAll({ revision: 10, instance: 'main' })
    fold!(fromServer(0, [], 'server'))
    expect(names()).toEqual(['A', 'B'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 0, instance: 'server' })
    // Every partition and the registry are written to the new source.
    expect(writes.map((w) => w.kind).sort()).toEqual(['pins', 'registry'])
    expect(writes.find((w) => w.kind === 'pins')).toMatchObject({ scope: 'ws1' })
    expect(
      (writes.find((w) => w.kind === 'pins')!.pins as PinnedGroup[]).map((p) => p.name)
    ).toEqual(['A', 'B'])
    await landAll({ revision: 2, instance: 'server' })
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 2, instance: 'server' })
    // From then on the server's revisions are the ones compared.
    fold!(fromServer(2, [], 'server'))
    expect(names()).toEqual(['A', 'B'])
    fold!(fromServer(3, [pin('b', 'B')], 'server'))
    expect(names()).toEqual(['B'])
  })

  it('adopts the instance a write of its own landed on, without rewriting that partition', async () => {
    loaded = boot(4, [pin('a', 'A')], 'main')
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B', null))
    expect(writes.map((w) => w.scope)).toEqual([null])
    await landAll({ revision: 1, instance: 'server' })
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 1, instance: 'server' })
    // The ws1 partition and the registry follow; the null one just landed.
    expect(writes.map((w) => (w.kind === 'pins' ? w.scope : 'registry')).sort()).toEqual([
      'registry',
      'ws1'
    ])
  })

  it('takes the registry a fold carries, and the stamp of a registry write', async () => {
    loaded = boot(1, [])
    await actions.bootWorkspaces()
    const two = { ...WS, id: 'ws2', name: 'Two' }
    fold!({ workspaces: [WS, two], pins: [], revision: 2, instance: 'main' })
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(['ws1', 'ws2'])
    const renamed = actions.renameWorkspace('ws2', 'Deux')
    expect(writes.map((w) => w.kind)).toEqual(['registry'])
    await writes[0].land({ revision: 3, instance: 'main' })
    await renamed
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 3, instance: 'main' })
  })

  it('folds a copy with no stamp as before', async () => {
    loaded = boot(1, [pin('a', 'A')])
    await actions.bootWorkspaces()
    fold!({ workspaces: [WS], pins: [pin('z', 'Z')] })
    expect(names()).toEqual(['Z'])
    expect(writes).toHaveLength(0)
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 1, instance: 'main' })
  })
})
