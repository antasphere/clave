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
 *   `failed`: the last attempt for this version failed (`error`);
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
export interface ServerVersionDecision {
  readonly kind: ServerVersionKind
  readonly appVersion: string
  /** Whether this app upgrades servers at all: a packaged app, never a dev build. */
  readonly automatic: boolean
  readonly serverVersion?: string
  readonly installRef?: string | null
  /** The version an upgrade goes, or went, to. */
  readonly target?: string
  /** For `upgrading`: whether the server waits for idle or runs it. */
  readonly upgradeState?: 'waiting-for-idle' | 'running'
  readonly reason?: string
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
  /** A window heard a server's upgrade change, or its welcome: read that server again. */
  versionRefresh: 'server:fleet:version-refresh'
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
