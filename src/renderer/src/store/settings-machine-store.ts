import { create } from 'zustand'
import {
  LOCAL_SERVER_ID,
  type SavedServerConnection,
  type ServerConnectionStatus
} from '@clave/contract/fleet'
import { useFleetStore } from './fleet-store'

/** Which machine the Agents group of Settings shows: this Mac, or a saved server by its id. */
export type SettingsMachine = string // LOCAL_SERVER_ID or a server id

interface State {
  machine: SettingsMachine
  setMachine: (machine: SettingsMachine) => void
}

export const useSettingsMachineStore = create<State>((set) => ({
  machine: LOCAL_SERVER_ID,
  setMachine: (machine) => set({ machine })
}))

export interface SettingsServer {
  connection: SavedServerConnection
  status: ServerConnectionStatus | undefined
  connected: boolean
}

/** The saved connection and live status behind a non-local machine, null for this Mac. */
export function useSettingsServer(): SettingsServer | null {
  const machine = useSettingsMachineStore((s) => s.machine)
  const connection = useFleetStore((s) =>
    machine === LOCAL_SERVER_ID ? undefined : s.connections.find((c) => c.id === machine)
  )
  const status = useFleetStore((s) =>
    machine === LOCAL_SERVER_ID ? undefined : s.statuses[machine]
  )
  if (!connection) return null
  return { connection, status, connected: connection.enabled && status?.state === 'connected' }
}

/** A picked server that is gone or switched off leaves nothing to show, so
 *  the page returns to this Mac; one merely reconnecting stays picked, its
 *  page saying so, since it comes back on its own. */
function guard(): void {
  const { machine, setMachine } = useSettingsMachineStore.getState()
  if (machine === LOCAL_SERVER_ID) return
  const connection = useFleetStore.getState().connections.find((c) => c.id === machine)
  if (!connection || connection.enabled === false) setMachine(LOCAL_SERVER_ID)
}

let guarding = false
/** Once per window: a server that is removed or disconnected while picked falls back to this Mac. */
export function startSettingsMachineGuard(): void {
  if (guarding) return
  guarding = true
  useFleetStore.subscribe(guard)
}
