import type {
  SavedServerConnection,
  SaveServerConnection,
  ServerConnectionStatus
} from '@clave/contract/fleet'
import type { LayoutSnapshot, WindowLayout } from '@clave/contract/sidebar/layout'
import type { Session } from '../shared/session-model'
import type { SessionRecord, SessionInfo, LaunchProfilePreferences } from './index.d'

export interface FleetSnapshot {
  serverId: string
  sessions: Session[]
  records: SessionRecord[]
  layout: LayoutSnapshot
}
export interface FleetRequests {
  serverId: string
  revision: number
  pending: FleetPendingRequest[]
}
export interface FleetDesktopAPI {
  fleetList(): Promise<SavedServerConnection[]>
  fleetSave(input: SaveServerConnection): Promise<SavedServerConnection>
  fleetConnect(serverId: string): Promise<void>
  fleetDisconnect(serverId: string): Promise<void>
  fleetRemove(serverId: string): Promise<void>
  fleetSnapshot(serverId: string): Promise<FleetSnapshot>
  fleetLaunchSettings(serverId: string): Promise<{
    profiles: LaunchProfilePreferences
    claudeAccounts: Array<{ id: string; label: string }>
    codexAccounts: Array<{ id: string; label: string }>
  }>
  fleetStart(
    serverId: string,
    cwd: string,
    options?: Parameters<import('./index.d').ElectronAPI['spawnSession']>[1]
  ): Promise<SessionInfo>
  fleetSaveLayout(
    serverId: string,
    layout: WindowLayout,
    baseRevision: number
  ): Promise<LayoutSnapshot>
  fleetResolve(requestKey: string, response: FleetRequestResponse): Promise<{ accepted: boolean }>
  fleetDownload(root: string, path: string, open?: boolean): Promise<void>
  fleetUpload(root: string, path: string, sourcePath: string): Promise<void>
  onFleetSnapshot(callback: (snapshot: FleetSnapshot) => void): () => void
  onFleetRequests(callback: (requests: FleetRequests) => void): () => void
  onFleetStatus(callback: (status: ServerConnectionStatus) => void): () => void
  onFleetConnectionsChanged(callback: (connections: SavedServerConnection[]) => void): () => void
}

/** Secret-free request projection for contextBridge; no server runtime dependencies. */
export interface FleetPendingRequest {
  id: string
  sessionId: string
  kind: 'permission' | 'clarification' | 'secret'
  description: string
  createdAt: number
  providerRequestId?: string
  options?: readonly { id: string; label: string }[]
  questions?: readonly {
    id?: string
    question: string
    header?: string
    options: readonly { label: string; description?: string }[]
    multiSelect?: boolean
  }[]
  secretQuestions?: readonly string[]
  toolName?: string
  detail?: string
  input?: unknown
  action?:
    | { type: 'run'; command: string; cwd: string; envVar: string }
    | { type: 'env-file'; file: string; key: string }
}
export type FleetRequestResponse =
  | { type: 'permission'; optionId: string; answers?: Record<string, string> }
  | { type: 'clarification'; answers: Record<string, string> }
  | { type: 'secret'; value: string }
  | { type: 'dismiss' }
