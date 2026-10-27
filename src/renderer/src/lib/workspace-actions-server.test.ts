/**
 * Server workspaces in a window (#241): a connected Clave server's own
 * registry, heard from the preload, kept per server beside this Mac's list,
 * cached for an offline boot, and never written to this Mac's registry. The
 * stores read localStorage and the bridge at import time, so both are
 * stubbed first, as workspace-actions.test.ts does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { Workspace } from '../../../shared/workspace-types'

vi.mock('./switch-account', () => ({
  resolveAccountRef: () => ({ id: 'default', label: 'Default' })
}))

const LOCAL: Workspace = { id: 'ws1', name: 'One', rootDir: '/w', profileFile: null, createdAt: 1 }
const serverWs = (server: string, id: string, rootDir = `/srv/${id}`): Workspace => ({
  id: resourceKey('workspace', server, id),
  name: id,
  rootDir,
  profileFile: null,
  createdAt: 2
})

const mem = new Map<string, string>()
const switches: unknown[] = []
const registryWrites: unknown[] = []
let heardWorkspaces: ((u: { serverId: string; workspaces: Workspace[] }) => void) | null = null
let heardConnections: ((c: Array<{ id: string }>) => void) | null = null
let shownAtBoot: string | null = 'ws1'
let localAtBoot: Workspace[] = [LOCAL]
/** When set, `fleetAddWorkspace` answers only once the test resolves it. */
let addGate: Promise<void> | null = null
/** The orders written to a server, and the refusal the next one meets. */
const reorders: Array<{ serverId: string; ids: string[] }> = []
let reorderFails: Error | null = null

let actions: typeof import('./workspace-actions')
let store: typeof import('../store/workspace-store')

beforeAll(() => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async () => undefined,
    captureTabClosed: () => {},
    windowIdentity: async () => ({
      windowId: 1,
      windowKey: 'win-1',
      workspaceId: shownAtBoot,
      isPrimary: true
    }),
    workspaceLoad: async () => ({
      version: 1,
      workspaces: localAtBoot,
      lastActiveWorkspaceId: null,
      activeWorkspaceId: null,
      pinsMigrated: true,
      pins: [],
      revision: 0,
      instance: 'main'
    }),
    workspaceUpdatePins: async () => ({ ok: true, workspaces: [LOCAL], pins: [] }),
    workspaceUpdateRegistry: async (list: unknown) => {
      registryWrites.push(list)
      return { ok: true, workspaces: list, pins: [] }
    },
    windowSetWorkspace: async (id: unknown) => {
      switches.push(id)
      return { ok: true }
    },
    onWindowIdentityChanged: () => () => {},
    onWorkspaceStateChanged: () => () => {},
    onFleetWorkspaces: (cb: typeof heardWorkspaces) => {
      heardWorkspaces = cb
      return () => {}
    },
    onFleetConnectionsChanged: (cb: typeof heardConnections) => {
      heardConnections = cb
      return () => {}
    },
    fleetAddWorkspace: async (serverId: string, input: { rootDir: string }) => {
      if (addGate) await addGate
      return serverWs(serverId, 'added', input.rootDir)
    },
    fleetReorderWorkspaces: async (serverId: string, ids: string[]) => {
      reorders.push({ serverId, ids })
      if (reorderFails) throw reorderFails
    },
    discoverClaveFiles: async () => [],
    trustWorkspaceRoot: async () => undefined,
    setSessionWorkspace: async () => undefined,
    watchClaveFile: async () => undefined,
    unwatchClaveFile: async () => undefined
  }
})

beforeEach(async () => {
  vi.resetModules()
  mem.clear()
  switches.length = 0
  registryWrites.length = 0
  heardWorkspaces = null
  heardConnections = null
  shownAtBoot = 'ws1'
  localAtBoot = [LOCAL]
  addGate = null
  reorders.length = 0
  reorderFails = null
  actions = await import('./workspace-actions')
  store = await import('../store/workspace-store')
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('server workspaces beside the local registry', () => {
  it('keeps each server list apart from the local one and never writes it locally', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    const state = store.useWorkspaceStore.getState()
    expect(state.workspaces.map((w) => w.id)).toEqual(['ws1'])
    expect(state.serverWorkspaces.srv.map((w) => w.id)).toEqual([
      resourceKey('workspace', 'srv', 'repo')
    ])
    expect(store.allWorkspaces(state).map((w) => w.id)).toEqual([
      'ws1',
      resourceKey('workspace', 'srv', 'repo')
    ])
    expect(store.getWorkspaceById(resourceKey('workspace', 'srv', 'repo'))?.rootDir).toBe(
      '/srv/repo'
    )
    expect(store.workspaceServer(resourceKey('workspace', 'srv', 'repo'))).toBe('srv')
    expect(store.workspaceServer('ws1')).toBeNull()
    await tick()
    expect(registryWrites).toEqual([])
  })

  it('waits for the server’s list carrying an added workspace, and never invents it', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    const adding = actions.addServerWorkspace('srv', '/srv/added')
    await tick()
    heardWorkspaces!({
      serverId: 'srv',
      workspaces: [serverWs('srv', 'repo'), serverWs('srv', 'added', '/srv/added')]
    })
    const added = await adding
    await actions.setActiveWorkspace(added.id)
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe(added.id)
  })

  it('holds an add until the server’s list carries it, three seconds at most', async () => {
    vi.useFakeTimers()
    try {
      await actions.bootWorkspaces()
      heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
      let settled = false
      const adding = actions.addServerWorkspace('srv', '/srv/added').then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(2_900)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await adding
      expect(settled).toBe(true)
      // With the list arriving, the add settles at once.
      settled = false
      const again = actions.addServerWorkspace('srv', '/srv/second').then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      heardWorkspaces!({
        serverId: 'srv',
        workspaces: [serverWs('srv', 'repo'), serverWs('srv', 'added', '/srv/second')]
      })
      await vi.advanceTimersByTimeAsync(0)
      await again
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not bring back an added workspace another Mac removed meanwhile', async () => {
    vi.useFakeTimers()
    try {
      await actions.bootWorkspaces()
      heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
      let answer = (): void => {}
      addGate = new Promise((resolve) => (answer = resolve))
      const adding = actions.addServerWorkspace('srv', '/srv/added')
      await vi.advanceTimersByTimeAsync(0)
      // The add's own list is pushed, then another Mac's removal, and only
      // then does the add's answer arrive.
      heardWorkspaces!({
        serverId: 'srv',
        workspaces: [serverWs('srv', 'repo'), serverWs('srv', 'added', '/srv/added')]
      })
      heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
      answer()
      await vi.advanceTimersByTimeAsync(3_000)
      await adding
      expect(store.useWorkspaceStore.getState().serverWorkspaces.srv.map((w) => w.name)).toEqual([
        'repo'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an entry that names another server', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({
      serverId: 'srv',
      workspaces: [serverWs('srv', 'repo'), serverWs('other', 'x'), LOCAL]
    })
    expect(store.useWorkspaceStore.getState().serverWorkspaces.srv.map((w) => w.name)).toEqual([
      'repo'
    ])
  })

  it('lists the last known workspaces of a server that is down at boot', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    vi.resetModules()
    shownAtBoot = resourceKey('workspace', 'srv', 'repo')
    actions = await import('./workspace-actions')
    store = await import('../store/workspace-store')
    await actions.bootWorkspaces()
    const state = store.useWorkspaceStore.getState()
    expect(state.activeWorkspaceId).toBe(resourceKey('workspace', 'srv', 'repo'))
    expect(state.serverWorkspaces.srv.map((w) => w.rootDir)).toEqual(['/srv/repo'])
  })

  it('switches to a server workspace through main, like a local one', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    await actions.setActiveWorkspace(resourceKey('workspace', 'srv', 'repo'))
    expect(switches).toEqual([resourceKey('workspace', 'srv', 'repo')])
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe(
      resourceKey('workspace', 'srv', 'repo')
    )
    actions.cycleWorkspace(1)
    await tick()
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe('ws1')
  })

  it('lands on another workspace when the shown one leaves its server', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    await actions.setActiveWorkspace(resourceKey('workspace', 'srv', 'repo'))
    heardWorkspaces!({ serverId: 'srv', workspaces: [] })
    await tick()
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe('ws1')
    expect(switches.at(-1)).toBe('ws1')
  })

  it('stays on a server workspace while another server changes', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    await actions.setActiveWorkspace(resourceKey('workspace', 'srv', 'repo'))
    heardWorkspaces!({ serverId: 'other', workspaces: [] })
    await tick()
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe(
      resourceKey('workspace', 'srv', 'repo')
    )
  })

  it('forgets a removed server and lands the window when it showed one of its workspaces', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    heardWorkspaces!({ serverId: 'kept', workspaces: [serverWs('kept', 'k')] })
    await actions.setActiveWorkspace(resourceKey('workspace', 'srv', 'repo'))
    heardConnections!([{ id: 'kept' }])
    await tick()
    const state = store.useWorkspaceStore.getState()
    expect(Object.keys(state.serverWorkspaces)).toEqual(['kept'])
    expect(state.activeWorkspaceId).toBe('ws1')
    expect(JSON.parse(mem.get('clave-server-workspaces')!)).toEqual({
      kept: [serverWs('kept', 'k')]
    })
  })
})

describe('the first Mac workspace beside server workspaces', () => {
  const remoteTab = {
    id: resourceKey('session', 'srv', 'tab'),
    name: 'Remote',
    cwd: '/srv/repo',
    alive: true
  }
  const remoteGroup = { id: resourceKey('group', 'srv', 'g'), name: 'G', sessionIds: [] }
  const localTab = { id: 'local-tab', name: 'Local', cwd: '/w', alive: true, sessionType: 'local' }
  const seed = async (): Promise<typeof import('../store/session-store')> => {
    const sessions = await import('../store/session-store')
    sessions.useSessionStore.setState({
      sessions: [remoteTab, localTab] as never,
      groups: [remoteGroup] as never
    })
    return sessions
  }

  it('stamps only this Mac’s unowned tabs when leaving no-workspace mode', async () => {
    localAtBoot = []
    shownAtBoot = null
    await actions.bootWorkspaces()
    const sessions = await seed()
    const added = await actions.addWorkspace('/w', null)
    const state = sessions.useSessionStore.getState()
    expect(state.sessions.find((x) => x.id === 'local-tab')?.workspaceId).toBe(added!.id)
    expect(state.sessions.find((x) => x.id === remoteTab.id)?.workspaceId).toBeUndefined()
    expect(state.groups.find((g) => g.id === remoteGroup.id)?.workspaceId).toBeUndefined()
    expect(sessions.inActiveWorkspace(remoteTab, added!.id)).toBe(false)
  })

  it('leaves a window on its server workspace when the first Mac workspace is added', async () => {
    localAtBoot = []
    shownAtBoot = resourceKey('workspace', 'srv', 'repo')
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    const sessions = await seed()
    const added = await actions.addWorkspace('/w', null)
    expect(store.useWorkspaceStore.getState().activeWorkspaceId).toBe(shownAtBoot)
    expect(store.useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual([added!.id])
    const state = sessions.useSessionStore.getState()
    expect(state.sessions.find((x) => x.id === remoteTab.id)?.workspaceId).toBeUndefined()
    expect(switches).toEqual([])
  })
})

// Round 9 of verification (B9-F2): a transport failure is told in plain words.
describe('what a failed add or removal of a server workspace says', () => {
  it('passes a refusal through and words a transport failure plainly', () => {
    const refusal = new Error('That folder overlaps a workspace already on this server.')
    expect(actions.serverWorkspaceError(refusal, 'VPS', 'add')).toBe(refusal.message)
    const transport = new Error('Decode error (502 GET http://127.0.0.1:1/files/stat)')
    expect(actions.serverWorkspaceError(transport, 'VPS', 'add')).toBe(
      'VPS could not add the workspace. Check that it is connected, then try again.'
    )
    expect(actions.serverWorkspaceError('gone', 'VPS', 'remove')).toBe(
      'VPS could not remove the workspace. Check that it is connected, then try again.'
    )
  })
})

// #257: a workspace moves within its own machine's list, never across.
describe('reordering workspaces', () => {
  const TWO: Workspace = { id: 'ws2', name: 'Two', rootDir: '/w2', profileFile: null, createdAt: 2 }
  const THREE: Workspace = {
    id: 'ws3',
    name: 'Three',
    rootDir: '/w3',
    profileFile: null,
    createdAt: 3
  }
  const ids = (list: Workspace[]): string[] => list.map((w) => w.id)
  const repo = resourceKey('workspace', 'srv', 'repo')
  const docs = resourceKey('workspace', 'srv', 'docs')
  const site = resourceKey('workspace', 'srv', 'site')

  it('writes this Mac’s registry whole, in the new order', async () => {
    localAtBoot = [LOCAL, TWO, THREE]
    await actions.bootWorkspaces()
    await actions.moveWorkspace('ws3', 'ws1', 'before')
    expect(ids(store.useWorkspaceStore.getState().workspaces)).toEqual(['ws3', 'ws1', 'ws2'])
    expect(registryWrites.map((w) => ids(w as Workspace[]))).toEqual([['ws3', 'ws1', 'ws2']])
    await actions.moveWorkspace('ws3', 'ws2', 'after')
    expect(registryWrites.map((w) => ids(w as Workspace[])).at(-1)).toEqual(['ws1', 'ws2', 'ws3'])
    expect(reorders).toEqual([])
  })

  it('writes nothing for a move that leaves the list as it is', async () => {
    localAtBoot = [LOCAL, TWO, THREE]
    await actions.bootWorkspaces()
    await actions.moveWorkspace('ws1', 'ws2', 'before')
    await actions.moveWorkspace('ws2', 'ws1', 'after')
    await actions.moveWorkspace('ws2', 'ws2', 'after')
    await actions.moveWorkspace('ws2', 'gone', 'after')
    expect(registryWrites).toEqual([])
  })

  it('moves the next/previous shortcut along the new order', async () => {
    localAtBoot = [LOCAL, TWO, THREE]
    await actions.bootWorkspaces()
    await actions.moveWorkspace('ws3', 'ws1', 'after')
    actions.cycleWorkspace(1)
    await tick()
    expect(switches.at(-1)).toBe('ws3')
  })

  it('writes a server’s list to that server alone, shown at once', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({
      serverId: 'srv',
      workspaces: [serverWs('srv', 'repo'), serverWs('srv', 'docs'), serverWs('srv', 'site')]
    })
    const moving = actions.moveWorkspace(site, repo, 'before')
    expect(ids(store.useWorkspaceStore.getState().serverWorkspaces.srv)).toEqual([site, repo, docs])
    await moving
    expect(reorders).toEqual([{ serverId: 'srv', ids: [site, repo, docs] }])
    expect(registryWrites).toEqual([])
  })

  it('refuses a drop across machines', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({ serverId: 'srv', workspaces: [serverWs('srv', 'repo')] })
    heardWorkspaces!({ serverId: 'other', workspaces: [serverWs('other', 'x')] })
    await actions.moveWorkspace(repo, 'ws1', 'before')
    await actions.moveWorkspace('ws1', repo, 'after')
    await actions.moveWorkspace(repo, resourceKey('workspace', 'other', 'x'), 'before')
    expect(reorders).toEqual([])
    expect(registryWrites).toEqual([])
    expect(ids(store.allWorkspaces(store.useWorkspaceStore.getState()))).toEqual([
      'ws1',
      repo,
      resourceKey('workspace', 'other', 'x')
    ])
  })

  it('puts the server’s order back when the server refuses it', async () => {
    await actions.bootWorkspaces()
    heardWorkspaces!({
      serverId: 'srv',
      workspaces: [serverWs('srv', 'repo'), serverWs('srv', 'docs')]
    })
    reorderFails = new Error('The server refused the workspace list.')
    await expect(actions.moveWorkspace(docs, repo, 'before')).rejects.toThrow('refused')
    expect(ids(store.useWorkspaceStore.getState().serverWorkspaces.srv)).toEqual([repo, docs])
    expect(actions.serverWorkspaceError(reorderFails, 'VPS', 'reorder')).toBe(reorderFails.message)
    expect(actions.serverWorkspaceError(new Error('socket'), 'VPS', 'reorder')).toBe(
      'VPS could not reorder the workspace. Check that it is connected, then try again.'
    )
  })
})
