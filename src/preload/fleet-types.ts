import type {
  SavedServerConnection,
  SaveServerConnection,
  ServerConnectionStatus,
  ServerVersionStatus
} from '@clave/contract/fleet'
import type { LayoutSnapshot, WindowLayout } from '@clave/contract/sidebar/layout'
import type { Session } from '../shared/session-model'
import type { Workspace } from '../shared/workspace-types'
import type {
  SessionRecord,
  SessionInfo,
  LaunchProfilePreferences,
  ClaudeAccount,
  CodexAccount,
  UsageLimits,
  UsageError
} from './index.d'
import type { LaunchProfile, LauncherFamily } from '../shared/agent-launch'
import type { InputKind } from '@clave/contract/input-kinds'

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
/** One change of a server's settings, as its push socket announced it. */
export type FleetSettingsEvent = { serverId: string } & (
  | { kind: 'claude-accounts'; accounts: ClaudeAccount[] }
  | { kind: 'codex-accounts'; accounts: CodexAccount[] }
  | { kind: 'claude-usage'; accountId: string; result: UsageLimits | UsageError }
  | { kind: 'codex-usage'; accountId: string; result: UsageLimits | UsageError }
)
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
  /** The recent output of a tab running on a server, read from that server
   *  (PRDCT-4166): `sessionId` is the tab's remote key; the lines are the
   *  server's retained screen, the way its own agent tools read it. Refused
   *  for a tab of this Mac, whose pane holds the buffer. */
  fleetScreen(sessionId: string, lines?: number): Promise<{ lines: readonly string[] }>
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
  // ── Issue #266: each saved server's version against this app's, decided in main ──
  /** The last decisions; read every enabled server again first with `refresh`. */
  fleetServerVersions(refresh?: boolean): Promise<ServerVersionStatus[]>
  /** Upgrade the server to this app's version now, without waiting for idle. */
  fleetUpgradeServer(serverId: string): Promise<ServerVersionStatus>
  /** Every decision main publishes, for all enabled servers at once. */
  onFleetServerVersions(callback: (statuses: ServerVersionStatus[]) => void): () => void
  // ── Lane B (server wave): a server's accounts, usage and profiles, read and followed from the Mac ──
  fleetAccounts(
    serverId: string
  ): Promise<{ claude: ClaudeAccount[]; codex: CodexAccount[]; migrated: string[] }>
  fleetUsage(
    serverId: string,
    provider: 'claude' | 'codex',
    accountId?: string,
    force?: boolean
  ): Promise<UsageLimits | UsageError>
  fleetUsageSnapshot(
    serverId: string,
    provider: 'claude' | 'codex'
  ): Promise<Record<string, UsageLimits | UsageError>>
  fleetLaunchProfileUpsert(
    serverId: string,
    profile: LaunchProfile
  ): Promise<LaunchProfilePreferences>
  fleetLaunchProfileDelete(serverId: string, profileId: string): Promise<LaunchProfilePreferences>
  fleetLaunchProfileSetGlobal(
    serverId: string,
    family: LauncherFamily,
    profileId: string | null
  ): Promise<LaunchProfilePreferences>
  /** A server's settings as they change, from its live push socket: delivered while the connection is open; a page reads the lists again when the server (re)connects. */
  onFleetSettingsEvent(callback: (event: FleetSettingsEvent) => void): () => void
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
    /** A hosted input request's question (PRDCT-4157); see the contract's `input-kinds.ts`. */
    kind?: InputKind
    hint?: string
    placeholder?: string
    default?: string
    optional?: boolean
    url?: string
    confirm?: string
    min?: number
    max?: number
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
  | { type: 'permission'; optionId: string; answers?: Record<string, string | string[]> }
  | { type: 'clarification'; answers: Record<string, string | string[]> }
  | { type: 'secret'; value: string }
  | { type: 'dismiss' }
