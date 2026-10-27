/**
 * The Mac's side of "servers follow the app" (issue #266). Main reads every
 * enabled saved server's `GetServerInfo` (at boot, when the saved list
 * changes, every five minutes, and when the Servers page asks), decides what
 * its version means against this app's, and asks an older server installed
 * from a release tag to upgrade itself to EXACTLY this app's version once
 * none of its agents works. It asks once per server per version: a server
 * still older after that reads as a failed upgrade, which "Upgrade now"
 * retries, so a release whose build fails on a server is never retried in a
 * loop that restarts the server each time.
 *
 * A dev build never asks (its package.json version names no release), and
 * refuses "Upgrade now" too. `decideServerVersion` is the whole rule, pure;
 * the loop below only reads, asks and publishes. Nothing here imports Electron.
 */
import { gt, gte, valid } from 'semver'
import type {
  SavedServerConnection,
  ServerVersionDecision,
  ServerVersionStatus
} from '../../../packages/contract/src/fleet'
import type { ServerInfo, ServerUpgradeStatus } from '../../../packages/contract/src/server-info'
import { isReleaseTag } from '../../../packages/contract/src/release-version'

/** How often every enabled server is read again. */
export const VERSION_SYNC_INTERVAL_MS = 5 * 60_000

/** What reading a server's info gave. `missing`: it answered without the route. */
export type ServerRead =
  | { readonly kind: 'info'; readonly info: ServerInfo }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreachable' }

/** The one command an older server needs, run on it by hand. */
export function manualUpgradeCommand(appVersion: string): string {
  return `bash ~/install-server.sh --ref v${appVersion}`
}

export interface DecideInput {
  readonly appVersion: string
  readonly automatic: boolean
  readonly server: ServerRead
  /** The version this app already asked this server for, if it did. */
  readonly requested?: string
}

/** What a server's version means against this app's. Pure. */
export function decideServerVersion(input: DecideInput): ServerVersionDecision {
  const { appVersion, automatic, server } = input
  const base = { appVersion, automatic }
  if (server.kind === 'unreachable') return { kind: 'unreachable', ...base }
  if (server.kind === 'missing')
    return { kind: 'manual', ...base, command: manualUpgradeCommand(appVersion) }
  const { version, installRef, upgrade } = server.info
  const known = { ...base, serverVersion: version, installRef }
  if (!upgrade.supported)
    return { kind: 'unsupported', ...known, ...(upgrade.reason && { reason: upgrade.reason }) }
  // A branch or a custom ref is the operator's choice, whatever version it reports.
  if (!isReleaseTag(installRef) || !valid(version) || !valid(appVersion))
    return { kind: 'custom-ref', ...known }
  const target = upgrade.target
  const targetValid = target !== undefined && valid(target) !== null
  // Waiting or running for this version, or a later one another Mac asked for.
  if (
    (upgrade.state === 'waiting-for-idle' || upgrade.state === 'running') &&
    targetValid &&
    gte(target, appVersion)
  )
    return { kind: 'upgrading', ...known, target, upgradeState: upgrade.state }
  if (upgrade.state === 'failed' && targetValid && gte(target, appVersion))
    return {
      kind: 'failed',
      ...known,
      target,
      error: upgrade.error ?? 'The install script failed.'
    }
  if (gt(version, appVersion)) return { kind: 'server-newer', ...known }
  if (version === appVersion || !gt(appVersion, version)) return { kind: 'match', ...known }
  if (input.requested === appVersion)
    return {
      kind: 'failed',
      ...known,
      target: appVersion,
      error: `The server is still on ${version}: the upgrade did not finish. Its log is upgrade/upgrade.log in the server's data directory.`
    }
  return { kind: 'upgrade', ...known, target: appVersion }
}

export interface VersionSyncDeps {
  /** This app's version, the updater's `runningVersion()`. */
  readonly appVersion: () => string
  /** A packaged app, or a test instance told a version: never a dev build. */
  readonly automatic: boolean
  readonly connections: () => SavedServerConnection[]
  readonly read: (serverId: string) => Promise<ServerRead>
  /** `RequestServerUpgrade` on that server; throws what the server refused. */
  readonly request: (
    serverId: string,
    version: string,
    when: 'idle' | 'now'
  ) => Promise<ServerUpgradeStatus>
  readonly publish: (results: ServerVersionStatus[]) => void
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface VersionSync {
  start(): void
  stop(): void
  /** Read every enabled server, ask the ones to upgrade, publish, answer. */
  refresh(): Promise<ServerVersionStatus[]>
  results(): ServerVersionStatus[]
  /** Ask the server to upgrade to this app's version now, without waiting for idle. */
  upgradeNow(serverId: string): Promise<ServerVersionStatus>
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The server refused the upgrade.'

const withStatus = (read: ServerRead, upgrade: ServerUpgradeStatus): ServerRead =>
  read.kind === 'info' ? { kind: 'info', info: { ...read.info, upgrade } } : read

export function createVersionSync(deps: VersionSyncDeps): VersionSync {
  const requested = new Map<string, string>()
  const failures = new Map<string, { version: string; error: string }>()
  let current: ServerVersionStatus[] = []
  let running: Promise<ServerVersionStatus[]> | null = null
  let queued: Promise<ServerVersionStatus[]> | null = null
  let timer: unknown = null

  const decideOne = (serverId: string, read: ServerRead): ServerVersionStatus => {
    const appVersion = deps.appVersion()
    const failure = failures.get(serverId)
    if (failure?.version === appVersion)
      return {
        serverId,
        ...decideServerVersion({ appVersion, automatic: deps.automatic, server: read }),
        kind: 'failed',
        target: appVersion,
        error: failure.error
      }
    return {
      serverId,
      ...decideServerVersion({
        appVersion,
        automatic: deps.automatic,
        server: read,
        requested: requested.get(serverId)
      })
    }
  }

  const ask = async (
    serverId: string,
    read: ServerRead,
    when: 'idle' | 'now'
  ): Promise<ServerVersionStatus> => {
    const appVersion = deps.appVersion()
    requested.set(serverId, appVersion)
    try {
      const status = await deps.request(serverId, appVersion, when)
      failures.delete(serverId)
      return decideOne(serverId, withStatus(read, status))
    } catch (error) {
      failures.set(serverId, { version: appVersion, error: messageOf(error) })
      return decideOne(serverId, read)
    }
  }

  const one = async (connection: SavedServerConnection): Promise<ServerVersionStatus> => {
    let read: ServerRead
    try {
      read = await deps.read(connection.id)
    } catch {
      read = { kind: 'unreachable' }
    }
    // A version already asked for never reads as `upgrade` again: the rule
    // reads a server still older after the ask as failed.
    const decided = decideOne(connection.id, read)
    if (decided.kind === 'upgrade' && deps.automatic) return ask(connection.id, read, 'idle')
    return decided
  }

  const pass = async (): Promise<ServerVersionStatus[]> => {
    const enabled = deps.connections().filter((connection) => connection.enabled)
    const results = await Promise.all(enabled.map(one))
    current = results
    deps.publish(results)
    return results
  }

  /** One pass at a time; a call during a pass gets ONE more pass after it,
   *  shared by every call made meanwhile, so a change is never missed. */
  const refresh = (): Promise<ServerVersionStatus[]> => {
    if (!running) {
      running = pass().finally(() => {
        running = null
      })
      return running
    }
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null
        return refresh()
      })
    return queued
  }

  return {
    start: () => {
      if (timer !== null) return
      const set = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms).unref())
      timer = set(() => void refresh().catch(() => {}), VERSION_SYNC_INTERVAL_MS)
    },
    stop: () => {
      if (timer === null) return
      ;(deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout)))(timer)
      timer = null
    },
    refresh,
    results: () => current,
    upgradeNow: async (serverId) => {
      if (!deps.automatic)
        throw new Error(
          'A development build does not upgrade servers. Run install-server.sh on the server.'
        )
      const connection = deps.connections().find((c) => c.id === serverId && c.enabled)
      if (!connection) throw new Error('Unknown server connection.')
      const read = await deps.read(serverId).catch((): ServerRead => ({ kind: 'unreachable' }))
      failures.delete(serverId)
      const decided = decideServerVersion({
        appVersion: deps.appVersion(),
        automatic: true,
        server: read
      })
      if (
        !(
          decided.kind === 'upgrade' ||
          decided.kind === 'failed' ||
          (decided.kind === 'upgrading' && decided.upgradeState === 'waiting-for-idle')
        )
      )
        throw new Error('This server has nothing to upgrade to.')
      const result = await ask(serverId, read, 'now')
      current = [...current.filter((r) => r.serverId !== serverId), result]
      deps.publish(current)
      return result
    }
  }
}
