import { useMemo } from 'react'
import { create } from 'zustand'
import {
  LOCAL_SERVER_ID,
  type SavedServerConnection,
  type ServerConnectionStatus,
  type ServerPairings,
  type ServerVersionStatus
} from '@clave/contract/fleet'
import type { RoutineRun, RoutineView, RoutinesListing } from '@clave/contract/routines/model'
import { useFleetStore } from './fleet-store'
import { usePairingStore } from './pairing-store'
import { mergeRoutineSurfaces, type RoutineSurface } from '../components/routines/routine-servers'

/**
 * The routines as the servers list them (ADR 0004, PRDCT-4149): a mirror of
 * this window's own server's listing, re-read on every `routines.changed` and
 * at init, the way the copy-offer store mirrors main; beside it, the last
 * listing each connected server published (`onFleetRoutines`). The servers
 * own the scheduler and the runs; this store only reads them and asks for a
 * run, a dismissal or a discussion, each act sent to the server that runs the
 * routine (`RoutineSurface.serverId`).
 */
interface RoutinesState {
  /** This window's own server's routines, as `local.routines` (kept flat for the session view). */
  routines: RoutineView[]
  viewer: RoutinesListing['viewer']
  /** This window's own server's whole listing, null before the first read. */
  local: RoutinesListing | null
  /** Each connected server's last listing, by server id. */
  remote: Record<string, RoutinesListing>
  /** The last error a read or an act met, shown in the panel; null when none. */
  error: string | null
  loaded: boolean
  setListing: (listing: RoutinesListing) => void
  setRemoteListing: (serverId: string, listing: RoutinesListing) => void
  refresh: () => Promise<void>
  runNow: (surface: RoutineTarget, key: string) => Promise<RoutineRun | null>
  dismiss: (surface: RoutineTarget, runId: string) => Promise<void>
  /** The discussion's session id: a local id, or a remote key for a server's run. */
  openDiscussion: (
    surface: RoutineTarget,
    runId: string,
    mode: 'panel' | 'tab'
  ) => Promise<string | null>
}

/** What an act needs of a surface: the server it goes to. */
export type RoutineTarget = Pick<RoutineSurface, 'serverId'>

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isLocal = (surface: RoutineTarget): boolean => surface.serverId === LOCAL_SERVER_ID

export const useRoutinesStore = create<RoutinesState>((set, get) => {
  const act = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await work()
      set({ error: null })
      return result
    } catch (error) {
      set({ error: message(error) })
      return null
    }
  }
  return {
    routines: [],
    viewer: { url: null, note: '' },
    local: null,
    remote: {},
    error: null,
    loaded: false,
    setListing: (listing) =>
      set({
        routines: [...listing.routines],
        viewer: listing.viewer,
        local: listing,
        loaded: true,
        error: null
      }),
    setRemoteListing: (serverId, listing) =>
      set((state) => ({ remote: { ...state.remote, [serverId]: listing } })),
    refresh: async () => {
      try {
        get().setListing(await window.electronAPI.routinesList())
      } catch (error) {
        // A window that has not reached the server yet asks again once it does
        // (`onServerConnected`, below) and on every change.
        set({ error: message(error) })
      }
    },
    runNow: (surface, key) =>
      act(() =>
        isLocal(surface)
          ? window.electronAPI.routinesRunNow(key)
          : window.electronAPI.fleetRoutineRunNow(surface.serverId, key)
      ),
    dismiss: async (surface, runId) => {
      await act(() =>
        isLocal(surface)
          ? window.electronAPI.routinesDismiss(runId)
          : window.electronAPI.fleetRoutineDismiss(surface.serverId, runId)
      )
    },
    openDiscussion: async (surface, runId, mode) => {
      const opened = await act(() =>
        isLocal(surface)
          ? window.electronAPI.routinesOpenDiscussion(runId, mode)
          : window.electronAPI.fleetRoutineDiscussion(surface.serverId, runId, mode)
      )
      return opened?.sessionId ?? null
    }
  }
})

const connectedIds = (statuses: Record<string, ServerConnectionStatus>): Set<string> =>
  new Set(
    Object.values(statuses)
      .filter((s) => s.state === 'connected')
      .map((s) => s.serverId)
  )

/** Read a connected server's routines now; the listing arrives through
 *  `onFleetRoutines`. A server that runs no routines refuses, and is left be. */
const readServer = (serverId: string): void => {
  void window.electronAPI.fleetRoutines?.(serverId).catch(() => {})
}

/** Subscribe to the servers' changes and read the first listings. */
export function initRoutinesStore(): () => void {
  const store = useRoutinesStore.getState()
  const unsubscribe = window.electronAPI.onRoutinesChanged(() => void store.refresh())
  // The first read can come before the window reaches its server (a packaged
  // app runs it as a child, so main's own arm refuses): read again each time
  // the connection opens, as the plugin views do, or the toolbar stays empty
  // with the refusal on show until a routine happens to change.
  const stopConnected = window.electronAPI.onServerConnected(() => void store.refresh())
  // The connected servers' listings: the bridge publishes one at each connect
  // and each change. A server connected before this window subscribed is read
  // once here, and once more the first time the fleet store sees it connected
  // without a listing (the fleet store may fill after this init).
  const stopRemote =
    window.electronAPI.onFleetRoutines?.(({ serverId, listing }) =>
      useRoutinesStore.getState().setRemoteListing(serverId, listing)
    ) ?? (() => {})
  const asked = new Set<string>()
  const askNew = (statuses: Record<string, ServerConnectionStatus>): void => {
    for (const serverId of connectedIds(statuses)) {
      if (asked.has(serverId) || serverId in useRoutinesStore.getState().remote) continue
      asked.add(serverId)
      readServer(serverId)
    }
  }
  const fleet = useFleetStore.getState()
  for (const c of fleet.connections)
    if (fleet.statuses[c.id]?.state === 'connected') {
      asked.add(c.id)
      readServer(c.id)
    }
  const stopFleet = useFleetStore.subscribe((state, previous) => {
    if (state.statuses !== previous.statuses) askNew(state.statuses)
  })
  void store.refresh()
  return () => {
    unsubscribe()
    stopConnected()
    stopRemote()
    stopFleet()
  }
}

/** The surfaces of a store state, the fleet's and the pairings': only the
 *  listings of servers still saved on this Mac, a removed one gone with it. */
export function surfacesOf(
  routines: Pick<RoutinesState, 'local' | 'remote'>,
  connections: readonly SavedServerConnection[],
  statuses: Record<string, ServerConnectionStatus>,
  pairings: ServerPairings['servers'],
  versions: Record<string, ServerVersionStatus> = {}
): RoutineSurface[] {
  const saved = new Set(connections.map((c) => c.id))
  // A saved server's own name, as the version sync last heard it: what
  // tells a server that is away from a name nobody has (PRDCT-4241).
  const knownNames: Record<string, string> = {}
  for (const [id, status] of Object.entries(versions))
    if (saved.has(id) && status.serverName) knownNames[id] = status.serverName
  return mergeRoutineSurfaces({
    local: routines.local,
    remote: Object.fromEntries(Object.entries(routines.remote).filter(([id]) => saved.has(id))),
    connected: connectedIds(statuses),
    connectionNames: Object.fromEntries(connections.map((c) => [c.id, c.name])),
    knownNames,
    pairings
  })
}

/** Every routine the toolbar may show, each once, on the server that runs it. */
export function useRoutineSurfaces(): RoutineSurface[] {
  const local = useRoutinesStore((s) => s.local)
  const remote = useRoutinesStore((s) => s.remote)
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const pairings = usePairingStore((s) => s.servers)
  const versions = useFleetStore((s) => s.versions)
  return useMemo(
    () => surfacesOf({ local, remote }, connections, statuses, pairings, versions),
    [local, remote, connections, statuses, pairings, versions]
  )
}

/** The latest run of a routine, newest first in the listing. */
export const latestRun = (view: RoutineView): RoutineRun | undefined => view.runs[0]
