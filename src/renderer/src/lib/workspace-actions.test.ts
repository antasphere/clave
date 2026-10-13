/**
 * What a window does with a copy of the registry and the pins that arrives
 * from outside: another window's change, the server's own copy read at the
 * push socket's welcome, or the answer of a write of its own (wave 5, lane A,
 * PRDCT-3405 and PRDCT-3264).
 *
 * The copy carries a stamp, the revision of the state in the process that
 * holds it and that process's id. The window keeps the last stamp it loaded,
 * wrote or took in: a copy that is not newer is dropped, which is what keeps
 * the catch-up read at a welcome from resetting the pins the boot refresh
 * wrote after the read went out; a copy that lands while the window's own
 * writes are in flight waits for the last of them; a landed write answers the
 * whole state as it left it and the window folds that answer like a change,
 * so a change of another window that landed between this window's read and
 * its write is not lost (round 1 of the lane's verifier); a copy from another
 * instance is merged in, the window keeping the partitions it wrote this
 * session and taking the other instance's copy of the rest. And a copy that
 * is folded is recorded as persisted BEFORE the store is set, so the
 * persistence subscriber writes nothing back (the fold's old order wrote
 * every folded partition back with this window's origin, one change landing
 * as three writes).
 *
 * The stores read localStorage and the preload bridge at import time, so
 * both are stubbed first, as group-dissolve.test.ts does; the bridge's
 * workspace writes answer when the test says, with the stamp it gives and
 * the state the server would hold after the write (this window's own, unless
 * the test names what else landed there).
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
/** What a landed write answers: its stamp, and the state after it (this
 *  window's own registry and pins unless the test names what else landed). */
type Answer = Stamp & { workspaces?: unknown[]; pins?: unknown[] }
type Write = {
  kind: 'pins' | 'registry'
  scope?: string | null
  pins?: unknown[]
  land: (answer: Answer | { ok: false }) => Promise<void>
}

const WS = { id: 'ws1', name: 'One', rootDir: '/w', profileFile: null, createdAt: 1 }
const WS2 = { id: 'ws2', name: 'Two', rootDir: '/w2', profileFile: null, createdAt: 2 }

/** The writes the bridge received and has not answered yet. */
const writes: Write[] = []
/** What `workspaceLoad` answers at the next boot. */
let loaded: State & { version: 1; lastActiveWorkspaceId: null; pinsMigrated: true } = boot(0)
/** The listener the module bound on `onWorkspaceStateChanged`. */
let fold: ((state: State) => void) | null = null
/** What the window told main it now shows (`windowSetWorkspace`). */
const switches: unknown[] = []

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
let serializePinnedGroups: typeof import('../store/pinned-store').serializePinnedGroups
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
          resolve(
            'ok' in answer
              ? answer
              : {
                  ok: true,
                  workspaces: answer.workspaces ?? useWorkspaceStore.getState().workspaces,
                  pins:
                    answer.pins ?? serializePinnedGroups(usePinnedStore.getState().pinnedGroups),
                  revision: answer.revision,
                  instance: answer.instance
                }
          )
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
    windowSetWorkspace: async (id: unknown) => {
      switches.push(id)
      return { ok: true }
    },
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
  // Fresh module state per test: the stamp, the in-flight count, the written
  // partitions and the persisted record are the module's own.
  vi.resetModules()
  writes.length = 0
  switches.length = 0
  fold = null
  loaded = boot(0)
  actions = await import('./workspace-actions')
  const pinned = await import('../store/pinned-store')
  usePinnedStore = pinned.usePinnedStore
  serializePinnedGroups = pinned.serializePinnedGroups
  useWorkspaceStore = (await import('../store/workspace-store')).useWorkspaceStore
})

const names = (): string[] => usePinnedStore.getState().pinnedGroups.map((p) => p.name)
const registry = (): string[] => useWorkspaceStore.getState().workspaces.map((w) => w.id)
const landAll = async (answer: Answer): Promise<void> => {
  for (const w of writes.splice(0)) await w.land(answer)
}
const scopes = (): Array<string | null | 'registry'> =>
  writes.map((w) => (w.kind === 'pins' ? w.scope! : 'registry'))
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
    expect(scopes()).toEqual(['ws1'])
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

  it('writes nothing back on the answer of its own write either', async () => {
    loaded = boot(1, [pin('a', 'A')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    expect(scopes()).toEqual(['ws1'])
    await landAll({ revision: 2, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    expect(writes).toHaveLength(0)
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 2, instance: 'main' })
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

  it('holds a copy while its own write is in flight, and drops it once the write’s answer overtakes it', async () => {
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
    // writes in flight. The copy is held at a revision BETWEEN the landings
    // (round 1 of the verifier): released at the first landing it would be
    // applied as newer and reset the pins; released at the last, it is older
    // than the last answer and dropped.
    expect(scopes()).toEqual(['ws1', 'ws1', null])
    await writes[0].land({ revision: 2, instance: 'main' })
    fold!(fromServer(3, [pin('z', 'Z')]))
    expect(names()).toEqual(['A', 'B'])
    await writes[1].land({ revision: 4, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    // The answers are held with the copy: nothing is known past the boot
    // read until the last write has landed.
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 1, instance: 'main' })
    await writes[2].land({ revision: 5, instance: 'main' })
    expect(names()).toEqual(['A', 'B'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 5, instance: 'main' })
  })

  it('learns through its write’s answer what another window wrote meanwhile', async () => {
    // Window B's write to ws2 lands at 6 while this window's ws1 write is
    // out; B's event is held and then older than this window's answer at 7.
    // The answer carries the whole state, B's pin and workspace with it
    // (round 1 of the verifier, F1).
    loaded = boot(5, [pin('a', 'A')])
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    fold!({
      workspaces: [WS, WS2],
      pins: [pin('a', 'A'), pin('c', 'C', 'ws2')],
      revision: 6,
      instance: 'main'
    })
    expect(names()).toEqual(['A', 'B'])
    await landAll({
      revision: 7,
      instance: 'main',
      workspaces: [WS, WS2],
      pins: [pin('a', 'A'), pin('c', 'C', 'ws2'), pin('b', 'B')]
    })
    expect(names()).toEqual(['A', 'C', 'B'])
    expect(registry()).toEqual(['ws1', 'ws2'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 7, instance: 'main' })
    expect(writes).toHaveLength(0)
    // The same with no hold: B's event arrives after the answer, is older,
    // and is dropped; the answer had already brought C.
    fold!({
      workspaces: [WS, WS2],
      pins: [pin('a', 'A'), pin('c', 'C', 'ws2')],
      revision: 6,
      instance: 'main'
    })
    expect(names()).toEqual(['A', 'C', 'B'])
    // And a later write of ws2 here carries C, not a stale copy without it.
    usePinnedStore.getState().addPinnedGroup(pin('d', 'D', 'ws2'))
    const ws2 = writes.find((w) => w.scope === 'ws2')
    expect((ws2?.pins as PinnedGroup[]).map((p) => p.name)).toEqual(['C', 'D'])
  })

  it('a window’s own answer never moves it off its workspace: the landing is its caller’s', async () => {
    loaded = boot(1, [])
    await actions.bootWorkspaces()
    useWorkspaceStore.setState({ workspaces: [WS, WS2], activeWorkspaceId: 'ws2' })
    // The window removed ws2 itself: its answer lacks ws2, and the fold must
    // not land anywhere; removeWorkspace does, after the write.
    useWorkspaceStore.setState({ workspaces: [WS] })
    const written = actions.persistWorkspaceRegistry()
    await writes[0].land({ revision: 2, instance: 'main', workspaces: [WS], pins: [] })
    await written
    expect(switches).toEqual([])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 2, instance: 'main' })
    // Another window's change that removes the shown workspace does land.
    fold!({ workspaces: [], pins: [], revision: 3, instance: 'main' })
    expect(switches).toEqual([null])
  })

  it('adopts a copy from another instance by partition: its own where it wrote, the copy’s elsewhere', async () => {
    // Attached, a window that booted on main's copy and reached the server
    // later: the server's stamp is another instance's. The window wrote ws1
    // this session (its boot refresh); ws2 and the registry it did not.
    loaded = boot(9, [pin('a', 'A'), pin('old', 'Old', 'ws2')], 'main')
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B'))
    await landAll({ revision: 10, instance: 'main' })
    fold!({
      workspaces: [WS, WS2],
      pins: [pin('x', 'X'), pin('y', 'Y', 'ws2')],
      revision: 5,
      instance: 'server'
    })
    // ws1 is this window's (X is not taken); ws2 is the server's (Old goes,
    // Y comes); the registry is the server's.
    expect(names()).toEqual(['Y', 'A', 'B'])
    expect(registry()).toEqual(['ws1', 'ws2'])
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 5, instance: 'server' })
    // Only what is this window's own is written to the new source.
    expect(scopes()).toEqual(['ws1'])
    expect((writes[0].pins as PinnedGroup[]).map((p) => p.name)).toEqual(['A', 'B'])
    await landAll({ revision: 6, instance: 'server' })
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 6, instance: 'server' })
    // From then on the server's revisions are the ones compared.
    fold!(fromServer(6, [], 'server'))
    expect(names()).toEqual(['Y', 'A', 'B'])
    fold!(fromServer(7, [pin('b', 'B')], 'server'))
    expect(names()).toEqual(['B'])
  })

  it('writes the registry it changed and a partition it emptied to the instance it adopts', async () => {
    // Both workspaces registered at boot: a pin of an unregistered one is
    // dropped by the boot's reconciliation.
    loaded = { ...boot(1, [pin('a', 'A'), pin('q', 'Q', 'ws2')], 'main'), workspaces: [WS, WS2] }
    await actions.bootWorkspaces()
    const renamed = actions.renameWorkspace('ws2', 'Deux')
    await landAll({ revision: 2, instance: 'main' })
    await renamed
    usePinnedStore.getState().removePinnedGroup('q')
    expect(scopes()).toEqual(['ws2'])
    await landAll({ revision: 3, instance: 'main' })
    // The answer's fold records the emptied partition as empty: nothing goes
    // out again (the first fix round sent it empty at every answer, without end).
    expect(writes).toHaveLength(0)
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 3, instance: 'main' })
    fold!({
      workspaces: [WS],
      pins: [pin('q', 'Q', 'ws2'), pin('s', 'S')],
      revision: 0,
      instance: 'server'
    })
    // The emptied ws2 is this window's and goes out empty (Q is not taken);
    // ws1, which this window never wrote, is the copy's (A gives way to S);
    // the registry it renamed goes out too and is kept over the copy's.
    expect(names()).toEqual(['S'])
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.name)).toEqual(['One', 'Deux'])
    expect(scopes().sort()).toEqual(['registry', 'ws2'])
    expect(writes.find((w) => w.scope === 'ws2')!.pins).toEqual([])
    expect(switches).toEqual([])
  })

  it('adopts the instance a write of its own landed on, without rewriting that partition', async () => {
    loaded = boot(4, [pin('a', 'A')], 'main')
    await actions.bootWorkspaces()
    usePinnedStore.getState().addPinnedGroup(pin('b', 'B', null))
    expect(scopes()).toEqual([null])
    // The answer is the server's state: the null partition as written, and
    // a ws1 of its own, taken since this window did not write ws1.
    await landAll({
      revision: 1,
      instance: 'server',
      workspaces: [WS],
      pins: [pin('s', 'S'), pin('b', 'B', null)]
    })
    expect(actions.knownWorkspaceStamp()).toEqual({ revision: 1, instance: 'server' })
    expect(names()).toEqual(['S', 'B'])
    // Nothing of this window's is left to write: the null partition just landed.
    expect(writes).toHaveLength(0)
  })

  it('takes the registry a fold carries, and the stamp of a registry write', async () => {
    loaded = boot(1, [])
    await actions.bootWorkspaces()
    fold!({ workspaces: [WS, WS2], pins: [], revision: 2, instance: 'main' })
    expect(registry()).toEqual(['ws1', 'ws2'])
    const renamed = actions.renameWorkspace('ws2', 'Deux')
    expect(scopes()).toEqual(['registry'])
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

  it('says a rejected write in the console and goes on', async () => {
    loaded = boot(1, [])
    await actions.bootWorkspaces()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    usePinnedStore.getState().addPinnedGroup(pin('a', 'A'))
    const write = writes.splice(0)[0]
    // A rejected write (not a refusal): the hold is released, the partition
    // goes out again at the next change, and the failure is said.
    fold!(fromServer(2, [pin('a', 'A'), pin('b', 'B')]))
    expect(names()).toEqual(['A'])
    await write.land({ ok: false })
    expect(error).not.toHaveBeenCalled()
    expect(names()).toEqual(['A', 'B'])
    error.mockRestore()
  })
})
