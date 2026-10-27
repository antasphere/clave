import type {
  SavedServerConnection,
  SaveServerConnection,
  ServerConnectionStatus
} from '@clave/contract/fleet'
import type { LayoutSnapshot, WindowLayout } from '@clave/contract/sidebar/layout'
import type { Session } from '../shared/session-model'
import type { Workspace } from '../shared/workspace-types'
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
/** A server's own workspace registry, each id a remote key (#241). */
export interface FleetWorkspaces {
  serverId: string
  workspaces: Workspace[]
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
  /** The server's workspaces, read now, for the caller alone: the list the
   *  renderer shows comes from `onFleetWorkspaces`. */
  fleetWorkspaces(serverId: string): Promise<Workspace[]>
  /** Register a folder on the server's disk as one of its workspaces. */
  fleetAddWorkspace(
    serverId: string,
    input: { rootDir: string; name?: string; profileFile?: string | null }
  ): Promise<Workspace>
  /** Drop a server workspace (by its remote key) from that server's registry. */
  fleetRemoveWorkspace(workspaceId: string): Promise<void>
  /** Write a server's registry in the order of `workspaceIds` (remote keys of
   *  that server's workspaces). Entries another Mac added meanwhile keep their
   *  place; ids the registry no longer holds are ignored. */
  fleetReorderWorkspaces(serverId: string, workspaceIds: string[]): Promise<void>
  fleetResolve(requestKey: string, response: FleetRequestResponse): Promise<{ accepted: boolean }>
  fleetDownload(root: string, path: string, open?: boolean): Promise<void>
  fleetUpload(root: string, path: string, sourcePath: string): Promise<void>
  onFleetSnapshot(callback: (snapshot: FleetSnapshot) => void): () => void
  onFleetRequests(callback: (requests: FleetRequests) => void): () => void
  onFleetStatus(callback: (status: ServerConnectionStatus) => void): () => void
  onFleetConnectionsChanged(callback: (connections: SavedServerConnection[]) => void): () => void
  /** A server's workspace list, from its live socket: at each connect, then
   *  at each change. */
  onFleetWorkspaces(callback: (update: FleetWorkspaces) => void): () => void
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
