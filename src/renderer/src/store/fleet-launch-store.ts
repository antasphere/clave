import { create } from 'zustand'
import type { AgentSetup } from './launch-prefs'
export interface FleetLaunchRequest {
  serverId: string
  setup: AgentSetup | null
  groupId?: string
  cwd?: string
  initialPrompt?: string
  resolve: (id: string | null) => void
}
export const useFleetLaunchStore = create<{ request: FleetLaunchRequest | null }>(() => ({
  request: null
}))
export function requestFleetLaunch(
  input: Omit<FleetLaunchRequest, 'resolve'>
): Promise<string | null> {
  useFleetLaunchStore.getState().request?.resolve(null)
  return new Promise((resolve) => useFleetLaunchStore.setState({ request: { ...input, resolve } }))
}
export function finishFleetLaunch(id: string | null): void {
  useFleetLaunchStore.getState().request?.resolve(id)
  useFleetLaunchStore.setState({ request: null })
}
