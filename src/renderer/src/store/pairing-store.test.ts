/**
 * A paired server workspace shows its items in the Mac workspace it is
 * paired with, and nowhere else (PRDCT-4151): the one visibility rule reads
 * the pairing map, the map comes from main's document, and a switch turned
 * off empties it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey, type ServerPairings } from '@clave/contract/fleet'

let store: typeof import('./session-store')
let pairing: typeof import('./pairing-store')
const memory = new Map<string, string>()
const changes: unknown[] = []
const state: ServerPairings = { version: 1, servers: {} }

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('electronAPI', {
    spawnSession: vi.fn(),
    killSession: vi.fn(),
    showNotification: async () => {},
    setSessionDisplayName: async () => {},
    serverPairingsLoad: async () => state,
    serverPairingsChange: async (change: unknown) => {
      changes.push(change)
      return state
    },
    onServerPairingsChanged: () => () => {}
  })
  store = await import('./session-store')
  pairing = await import('./pairing-store')
})
beforeEach(() => {
  changes.length = 0
  pairing.applyServerPairings({ version: 1, servers: {} })
})

const serverWs = (server: string, id: string): string => resourceKey('workspace', server, id)
const remoteTab = (server: string, workspaceId: string): { id: string; workspaceId: string } => ({
  id: resourceKey('session', server, 'tab'),
  workspaceId
})
const paired: ServerPairings = {
  version: 1,
  servers: {
    studio: { combine: true, color: '#5e6ad2', pairs: { ws: 'mac-ws' }, declined: [] }
  }
}

describe('inActiveWorkspace with a paired server workspace', () => {
  it('shows the server workspace’s tabs and groups in its Mac workspace, and only there', () => {
    pairing.applyServerPairings(paired)
    const ws = serverWs('studio', 'ws')
    expect(store.inActiveWorkspace(remoteTab('studio', ws), 'mac-ws')).toBe(true)
    expect(
      store.inActiveWorkspace(
        { id: resourceKey('group', 'studio', 'g'), workspaceId: ws },
        'mac-ws'
      )
    ).toBe(true)
    // Another Mac workspace, another server workspace: nothing leaks.
    expect(store.inActiveWorkspace(remoteTab('studio', ws), 'other-mac-ws')).toBe(false)
    expect(store.inActiveWorkspace(remoteTab('studio', serverWs('studio', 'two')), 'mac-ws')).toBe(
      false
    )
    // The server workspace itself still shows its own tabs.
    expect(store.inActiveWorkspace(remoteTab('studio', ws), ws)).toBe(true)
    // A pin or a file viewer loaded for the server workspace (a local id
    // carrying the server workspace's id) is not combined: the Mac workspace
    // shows its own pins, not the same tree's pins twice (verifier, round 1).
    expect(store.inActiveWorkspace({ id: 'pin-1', workspaceId: ws }, 'mac-ws')).toBe(false)
    expect(store.inActiveWorkspace({ id: 'pin-1', workspaceId: ws }, ws)).toBe(true)
    expect(store.inActiveWorkspace({ workspaceId: ws }, 'mac-ws')).toBe(false)
  })

  it('never shows a Mac tab in the server workspace, whatever the pairing', () => {
    pairing.applyServerPairings(paired)
    const ws = serverWs('studio', 'ws')
    expect(store.inActiveWorkspace({ id: 'local', workspaceId: 'mac-ws' }, ws)).toBe(false)
    // An unstamped server tab still shows in the server's workspaces only.
    expect(store.inActiveWorkspace({ id: resourceKey('session', 'studio', 'u') }, 'mac-ws')).toBe(
      false
    )
  })

  it('shows nothing combined while the switch is off, and again once it is on', () => {
    const ws = serverWs('studio', 'ws')
    expect(store.inActiveWorkspace(remoteTab('studio', ws), 'mac-ws')).toBe(false)
    pairing.applyServerPairings({
      version: 1,
      servers: { studio: { ...paired.servers.studio, combine: false } }
    })
    expect(store.inActiveWorkspace(remoteTab('studio', ws), 'mac-ws')).toBe(false)
    pairing.applyServerPairings(paired)
    expect(store.inActiveWorkspace(remoteTab('studio', ws), 'mac-ws')).toBe(true)
    expect(pairing.pairedServerWorkspaces('mac-ws')).toEqual([
      { serverId: 'studio', workspaceId: ws }
    ])
    expect(pairing.pairedServerWorkspaces(ws)).toEqual([])
    expect(pairing.serverColor('studio')).toBe('#5e6ad2')
  })

  it('renews the sessions so the lists redraw, and drops the proposal a change answered', () => {
    const before = store.useSessionStore.getState().sessions
    pairing.setPairingProposals([
      {
        serverId: 'studio',
        serverWorkspaceId: serverWs('studio', 'ws'),
        localWorkspaceId: 'mac-ws',
        remote: 'github.com/acme/shop'
      }
    ])
    expect(pairing.usePairingStore.getState().proposals).toHaveLength(1)
    pairing.applyServerPairings(paired)
    expect(store.useSessionStore.getState().sessions).not.toBe(before)
    expect(pairing.usePairingStore.getState().proposals).toEqual([])
  })

  it('sends a confirmation and a decline to main with the server’s own workspace id', async () => {
    const proposal = {
      serverId: 'studio',
      serverWorkspaceId: serverWs('studio', 'ws'),
      localWorkspaceId: 'mac-ws',
      remote: 'github.com/acme/shop'
    }
    await pairing.confirmProposal(proposal)
    await pairing.declineProposal(proposal)
    expect(changes).toEqual([
      { kind: 'confirm', serverId: 'studio', serverWorkspaceId: 'ws', localWorkspaceId: 'mac-ws' },
      { kind: 'decline', serverId: 'studio', serverWorkspaceId: 'ws' }
    ])
  })
})
