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
      workspaces: [LOCAL],
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
    discoverClaveFiles: async () => [],
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
