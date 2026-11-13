import type { ServerUpgradeFailureCode, ServerUpgradePhase } from './upgrade-failure'

/** Device-local connection identity. Names and URLs never identify an owner. */
export type ServerId = string
export const LOCAL_SERVER_ID = 'local'
export type ResourceKind = 'session' | 'group' | 'workspace' | 'file' | 'request'
export interface OwnedRef {
  readonly serverId: ServerId
  readonly id: string
}
export interface SessionRef {
  readonly serverId: ServerId
  readonly sessionId: string
}
export interface GroupRef {
  readonly serverId: ServerId
  readonly groupId: string
}
export interface WorkspaceRef {
  readonly serverId: ServerId
  readonly path: string
}
export interface FileRef {
  readonly serverId: ServerId
  readonly path: string
}
export interface RequestRef {
  readonly serverId: ServerId
  readonly requestId: string
}

export interface SavedServerConnection {
  readonly id: ServerId
  readonly name: string
  readonly url: string
  readonly enabled: boolean
}
export interface SaveServerConnection {
  readonly id?: ServerId
  readonly name: string
  readonly url: string
  readonly token?: string
}
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'unauthorized'
  | 'disconnected'
export interface ServerConnectionStatus {
  readonly serverId: ServerId
  readonly state: ConnectionState
  readonly attempt?: number
  readonly error?: 'unreachable' | 'unauthorized' | 'credentials-unavailable'
}
export interface Sourced<T> {
  readonly serverId: ServerId
  readonly value: T
}

/**
 * How a saved server's version stands against this app's (issue #266), as
 * main's version sync decided it (`src/main/server-connections/version-sync.ts`):
 * - `match`: same version; `server-newer`: never downgraded;
 * - `upgrade`: older, installed from a release tag, able to upgrade itself;
 *   `upgrading`: waiting for its agents to be idle, or running the upgrade;
 *   `failed`: the last attempt for this version failed: `failure` when the
 *   server ran it (codes from closed lists, never text from the run), `error`
 *   when this Mac's own ask was refused or never took;
 * - `custom-ref`: installed from a branch or a custom ref, left alone;
 * - `manual`: a server older than self-upgrades, `command` run by hand once;
 * - `unsupported`: not installed by the script (`reason`);
 * - `unreachable`: no answer, nothing known.
 */
export type ServerVersionKind =
  | 'match'
  | 'upgrade'
  | 'upgrading'
  | 'server-newer'
  | 'custom-ref'
  | 'manual'
  | 'unsupported'
  | 'failed'
  | 'unreachable'
/** A failed run as the server told it (`ServerUpgradeFailure` on the wire). */
export interface ServerVersionFailure {
  readonly code?: ServerUpgradeFailureCode
  readonly phase?: ServerUpgradePhase
  readonly exitCode?: number
  readonly logPath?: string
}
export interface ServerVersionDecision {
  readonly kind: ServerVersionKind
  readonly appVersion: string
  /** Whether this app upgrades servers at all: a packaged app, never a dev build. */
  readonly automatic: boolean
  readonly serverVersion?: string
  readonly installRef?: string | null
  /** The server's own name, as its info reports it (PRDCT-4241): what a
   *  routine's `runsOn` names it by, kept while the server is away. */
  readonly serverName?: string
  /** The version an upgrade goes, or went, to. */
  readonly target?: string
  /** For `upgrading`: whether the server waits for idle or runs it. */
  readonly upgradeState?: 'waiting-for-idle' | 'running'
  readonly reason?: string
  /** For `failed`: how the server's run failed. The Mac words it from the code. */
  readonly failure?: ServerVersionFailure
  /** For `failed`: this Mac's ask refused (the server's fixed refusal) or
   *  never taken (this Mac's own sentence). Never text from a run. */
  readonly error?: string
  /** For `manual`: the command to run on the server. */
  readonly command?: string
  /** False for `upgrading` and `failed` on a server as new as this app or
   *  newer: another Mac's upgrade, shown, never this app's to act on. */
  readonly ownAction?: false
}
export interface ServerVersionStatus extends ServerVersionDecision {
  readonly serverId: ServerId
}

export const FLEET_IPC = {
  list: 'server:fleet:list',
  save: 'server:fleet:save',
  connect: 'server:fleet:connect',
  disconnect: 'server:fleet:disconnect',
  remove: 'server:fleet:remove',
  endpoint: 'server:fleet:endpoint',
  changed: 'server:fleet:changed',
  // ── Issue #266: each saved server's version against this app's ──
  versions: 'server:fleet:versions',
  versionsChanged: 'server:fleet:versions-changed',
  upgradeNow: 'server:fleet:upgrade-now',
  /** The server's own name set from this Mac (PRDCT-4241), then read again. */
  setServerName: 'server:fleet:set-server-name',
  /** A window heard a server's upgrade change, or its welcome: read that server again. */
  versionRefresh: 'server:fleet:version-refresh',
  /** A window's connection to a server changed state (PRDCT-4165): main writes
   *  the line in its log, the one place a failed connection says why. */
  status: 'server:fleet:status'
} as const

/** Reserved prefix is escaped for local resources too, so any local ID can
 * coexist with a remote key. IDs on the wire are never rewritten. */
const PREFIX = 'clave-owner:'
const nonempty = (value: string): void => {
  if (typeof value !== 'string' || !value.length)
    throw new Error('An owner and resource ID are required.')
}
export function resourceKey(kind: ResourceKind, serverId: ServerId, id: string): string {
  nonempty(serverId)
  nonempty(id)
  if (serverId === LOCAL_SERVER_ID && !id.startsWith(PREFIX)) return id
  return `${PREFIX}${kind}:${encodeURIComponent(serverId)}:${encodeURIComponent(id)}`
}
export function parseResourceKey(kind: ResourceKind, key: string): OwnedRef {
  nonempty(key)
  if (!key.startsWith(PREFIX)) return { serverId: LOCAL_SERVER_ID, id: key }
  const parts = key.slice(PREFIX.length).split(':')
  if (parts.length !== 3 || parts[0] !== kind)
    throw new Error('Invalid owner key or resource kind.')
  try {
    const serverId = decodeURIComponent(parts[1])
    const id = decodeURIComponent(parts[2])
    nonempty(serverId)
    nonempty(id)
    // One canonical spelling prevents alternate encodings from splitting caches.
    if (resourceKey(kind, serverId, id) !== key) throw new Error('noncanonical')
    return { serverId, id }
  } catch {
    throw new Error('Invalid owner key.')
  }
}
export function sessionKey(ref: SessionRef): string {
  return resourceKey('session', ref.serverId, ref.sessionId)
}
export function parseSessionKey(key: string): SessionRef {
  const ref = parseResourceKey('session', key)
  return { serverId: ref.serverId, sessionId: ref.id }
}

// ── Paired workspaces (PRDCT-4151) ──
/**
 * One server's pairing settings, kept on this Mac alone: whether the server's
 * tabs show inside the Mac workspaces paired with its own, the colour its
 * badges wear here, which of its workspaces (by the server's own id) is paired
 * with which Mac workspace, and which proposals the person declined.
 * `combine` is undefined until the person answers: a confirmed pairing turns
 * it on, and a switch turned off stays off, proposing nothing, until it is
 * turned on again. Off, a server's tabs show only in its own workspaces, as
 * they did before any pairing existed.
 */
export interface ServerPairing {
  readonly combine?: boolean
  readonly color: string
  readonly pairs: Readonly<Record<string, string>>
  readonly declined: ReadonlyArray<string>
}
export interface ServerPairings {
  readonly version: 1
  readonly servers: Readonly<Record<ServerId, ServerPairing>>
}
export type ServerPairingChange =
  | {
      readonly kind: 'confirm'
      readonly serverId: ServerId
      readonly serverWorkspaceId: string
      readonly localWorkspaceId: string
    }
  | { readonly kind: 'decline'; readonly serverId: ServerId; readonly serverWorkspaceId: string }
  | { readonly kind: 'forget'; readonly serverId: ServerId; readonly serverWorkspaceId: string }
  /** Take a declined server workspace off the declined list, so it is proposed again. */
  | { readonly kind: 'ask-again'; readonly serverId: ServerId; readonly serverWorkspaceId: string }
  /** The switch; turned on, every decline is forgotten too. */
  | { readonly kind: 'combine'; readonly serverId: ServerId; readonly on: boolean }
export const PAIRING_IPC = {
  load: 'server:pairings:load',
  change: 'server:pairings:change',
  changed: 'server:pairings:changed'
} as const
/** The badge colours a server may wear on this Mac, given out in this order. */
export const SERVER_PAIRING_COLORS: ReadonlyArray<string> = [
  '#5e6ad2',
  '#4cb782',
  '#db8b4e',
  '#53b7c5',
  '#d45461',
  '#e8b931',
  '#8b95a8'
]
