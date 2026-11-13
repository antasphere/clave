import { beforeAll, describe, expect, it } from 'vitest'
import type { RoutineView, RoutinesListing } from '@clave/contract/routines/model'
import type { FleetRoutines } from '../../../preload/fleet-types'

/**
 * The routines store reaching its server late (ADR 0004). A packaged app runs
 * its server as a child, so the window's first read goes to main's own arm,
 * which refuses ("this window has not reached it yet"). The store must read
 * again once the connection opens, and a good read must clear the refusal:
 * before, the toolbar stayed empty with the error on show until a routine
 * happened to change.
 */
const LISTING: RoutinesListing = {
  routines: [],
  viewer: { url: null, note: '' },
  server: { id: 'local-server', name: 'Mac' }
}

const bridge = {
  connected: null as (() => void) | null,
  changed: null as (() => void) | null,
  reached: false,
  routinesList: async (): Promise<RoutinesListing> => {
    if (!bridge.reached)
      throw new Error("The routines are the server's: this window has not reached it yet")
    return LISTING
  },
  onRoutinesChanged: (cb: () => void) => {
    bridge.changed = cb
    return () => (bridge.changed = null)
  },
  onServerConnected: (cb: () => void) => {
    bridge.connected = cb
    return () => (bridge.connected = null)
  },
  fleetHeard: null as ((update: FleetRoutines) => void) | null,
  fleetReads: [] as string[],
  onFleetRoutines: (cb: (update: FleetRoutines) => void) => {
    bridge.fleetHeard = cb
    return () => (bridge.fleetHeard = null)
  },
  fleetRoutines: async (serverId: string): Promise<RoutinesListing> => {
    bridge.fleetReads.push(serverId)
    throw new Error('CapabilityUnavailable')
  },
  // PRDCT-4242: a delete the machine may refuse (a run in flight).
  deleteRefusal: null as string | null,
  deleted: [] as string[],
  routinesDelete: async (key: string): Promise<void> => {
    if (bridge.deleteRefusal) throw new Error(bridge.deleteRefusal)
    bridge.deleted.push(`local:${key}`)
  },
  fleetRoutineDelete: async (serverId: string, key: string): Promise<void> => {
    if (bridge.deleteRefusal) throw new Error(bridge.deleteRefusal)
    bridge.deleted.push(`${serverId}:${key}`)
  }
}

let mod: typeof import('./routines-store')

beforeAll(async () => {
  // The surfaces read the fleet and pairing stores, which reach the session
  // store and its saved preferences.
  const memory = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge
  mod = await import('./routines-store')
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('routines store', () => {
  it('reads again when the server connects, and the refusal clears', async () => {
    const stop = mod.initRoutinesStore()
    await settle()
    expect(mod.useRoutinesStore.getState().loaded).toBe(false)
    expect(mod.useRoutinesStore.getState().error).toMatch(/not reached it yet/)

    bridge.reached = true
    bridge.connected?.()
    await settle()
    expect(mod.useRoutinesStore.getState().loaded).toBe(true)
    expect(mod.useRoutinesStore.getState().error).toBeNull()

    stop()
    expect(bridge.connected).toBeNull()
    expect(bridge.changed).toBeNull()
  })

  it('keeps a server listing by server id and merges it into the surfaces', async () => {
    const { useFleetStore } = await import('./fleet-store')
    const { usePairingStore } = await import('./pairing-store')
    useFleetStore.setState({
      connections: [{ id: 's1', name: 'Box', url: 'http://box', enabled: true }],
      statuses: { s1: { serverId: 's1', state: 'connected' } as never }
    })
    usePairingStore.setState({
      servers: { s1: { combine: true, color: '#f00', pairs: { raw: 'mac-ws' }, declined: [] } }
    })
    const stop = mod.initRoutinesStore()
    await settle()
    // A server connected before the store subscribed is read once at init.
    expect(bridge.fleetReads).toEqual(['s1'])

    const routine = {
      key: '/box/r/default.clave::Digest',
      name: 'Digest',
      file: '/box/r/default.clave',
      rootDir: '/box/r',
      workspaceId: 'raw',
      runsHere: true,
      server: null,
      invalid: null
    } as unknown as RoutineView['routine']
    const listing: RoutinesListing = {
      routines: [{ routine, nextRunAt: null, runs: [] }],
      viewer: { url: null, note: '' },
      server: { id: 's1', name: 'box' }
    }
    bridge.fleetHeard?.({ serverId: 's1', listing })
    expect(mod.useRoutinesStore.getState().remote).toEqual({ s1: listing })

    const state = mod.useRoutinesStore.getState()
    const fleet = useFleetStore.getState()
    const surfaces = mod.surfacesOf(
      state,
      fleet.connections,
      fleet.statuses,
      usePairingStore.getState().servers
    )
    expect(surfaces).toEqual([
      expect.objectContaining({
        serverId: 's1',
        serverName: 'box',
        runsOn: 'server',
        reachable: true,
        workspaceId: 'mac-ws'
      })
    ])
    // A connection removed from this Mac takes its routines with it.
    expect(mod.surfacesOf(state, [], fleet.statuses, {})).toEqual([])
    stop()
    expect(bridge.fleetHeard).toBeNull()
  })

  it('sends a server routine’s acts to that server, a local one’s to the bridge', async () => {
    const calls: unknown[][] = []
    Object.assign(bridge, {
      routinesRunNow: async (key: string) => (calls.push(['local', key]), { id: 'r' }),
      fleetRoutineRunNow: async (serverId: string, key: string) => (
        calls.push([serverId, key]),
        { id: 'r' }
      ),
      fleetRoutineDiscussion: async () => ({ sessionId: 'remote-key' })
    })
    const store = mod.useRoutinesStore.getState()
    await store.runNow({ serverId: 'local' }, 'k1')
    await store.runNow({ serverId: 's1' }, 'k2')
    expect(calls).toEqual([
      ['local', 'k1'],
      ['s1', 'k2']
    ])
    expect(await store.openDiscussion({ serverId: 's1' }, 'run', 'panel')).toBe('remote-key')
  })

  it('a delete answers whether the machine took it, the refusal on the error line (verifier round 2, N12)', async () => {
    const { remove } = mod.useRoutinesStore.getState()
    bridge.deleteRefusal = '"Digest" is running; wait for it to end'
    expect(await remove({ serverId: 'local' }, 'created::a')).toBe(false)
    expect(mod.useRoutinesStore.getState().error).toBe('"Digest" is running; wait for it to end')
    bridge.deleteRefusal = null
    expect(await remove({ serverId: 'local' }, 'created::a')).toBe(true)
    expect(await remove({ serverId: 's1' }, 'created::b')).toBe(true)
    expect(bridge.deleted).toEqual(['local:created::a', 's1:created::b'])
    expect(mod.useRoutinesStore.getState().error).toBeNull()
  })
})
