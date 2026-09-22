import * as fs from 'fs'
import * as path from 'path'
import { isPrereleaseVersion } from '../shared/version'

/**
 * Data safety for the beta channel.
 *
 * A pre-release build shares `~/Library/Application Support/Clave` with the
 * stable app: same preferences, same session records, same layouts. A beta
 * that changes a file's shape changes it for the stable build the user may go
 * back to. So the FIRST time a pre-release starts on a data directory that a
 * stable version last wrote, the app's own state files are copied into
 * `backups/<stable-version>/` before anything else touches them. Copy only,
 * never restore — the Software Update pane says where the snapshot is.
 *
 * "Last written by" is a marker this module keeps itself
 * (`last-run-version.json`, stamped on every launch by every build that has
 * this code). No marker means a stable build older than the marker wrote the
 * directory, which is treated as stable, not as fresh.
 *
 * Pure decision + file copy, no Electron: `prerelease-snapshot-boot.ts` is
 * the import-time side effect that runs it before any manager can write.
 */

export const LAST_RUN_FILE = 'last-run-version.json'
export const BACKUPS_DIR = 'backups'

/**
 * The app's own state, by the file each manager owns. Chromium's directories
 * (Cache, Code Cache, Local Storage, Partitions, …) are deliberately absent:
 * they are the browser's, rebuilt on demand, and hundreds of megabytes.
 */
export const SNAPSHOT_FILES = [
  'preferences.json', // preferences-manager.ts
  'clave-preferences.json', // ipc-handlers/clave-file-handlers.ts (renderer prefs)
  'workspace-state.json', // workspace-manager.ts
  'windows.json', // window-state.ts
  'agent-launch-profiles.json', // launch-profile-manager.ts
  'locations.json', // location-manager.ts
  'locations-credentials.json',
  'claude-accounts.json', // claude-accounts.ts
  'claude-accounts-credentials.json',
  'ssh-known-hosts.json', // ssh-manager.ts
  'clave-trusted.json', // clave-file-handlers.ts
  'clave-trusted-roots.json'
] as const

export const SNAPSHOT_DIRS = [
  'session-records', // pty-manager.ts
  'sidebar-layouts', // sidebar-layout-manager.ts
  'agent-state', // agent-state-manager.ts
  'session-history', // session-history/service.ts
  'exchange-capture', // exchange-capture/service.ts
  'linked-documents' // linked-documents/runtime.ts
] as const

export interface LastRun {
  version: string
  at: string
}

export interface SnapshotDecision {
  snapshot: boolean
  /** The version the snapshot is named after; `stable-unknown` before the marker existed. */
  fromVersion: string | null
  reason: string
}

export interface SnapshotResult {
  dir: string
  fromVersion: string
  /** The entries copied, relative to the data directory. */
  copied: string[]
}

/** The whole rule, with no filesystem in it. */
export function snapshotDecision(
  lastRun: LastRun | null,
  currentVersion: string
): SnapshotDecision {
  if (!isPrereleaseVersion(currentVersion)) {
    return { snapshot: false, fromVersion: null, reason: 'the running build is a stable release' }
  }
  if (lastRun === null) {
    return {
      snapshot: true,
      fromVersion: 'stable-unknown',
      reason:
        'no last-run marker: the directory was last written by a stable build older than the marker'
    }
  }
  if (isPrereleaseVersion(lastRun.version)) {
    return {
      snapshot: false,
      fromVersion: null,
      reason: `the directory was last written by pre-release ${lastRun.version}`
    }
  }
  return {
    snapshot: true,
    fromVersion: lastRun.version,
    reason: `the directory was last written by stable ${lastRun.version}`
  }
}

export function readLastRun(userData: string): LastRun | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userData, LAST_RUN_FILE), 'utf-8'))
    return typeof raw?.version === 'string'
      ? { version: raw.version, at: String(raw.at ?? '') }
      : null
  } catch {
    return null
  }
}

export function writeLastRun(userData: string, version: string, now: Date): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, LAST_RUN_FILE),
    JSON.stringify({ version, at: now.toISOString() }, null, 2) + '\n',
    'utf-8'
  )
}

/** `backups/<from>/`, or `backups/<from>-2/` … when that one is already taken. */
export function snapshotDir(userData: string, fromVersion: string): string {
  const root = path.join(userData, BACKUPS_DIR)
  let candidate = path.join(root, fromVersion)
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(root, `${fromVersion}-${n}`)
  return candidate
}

/** Copy every state file and directory that exists; returns what was copied. */
export function copyStateFiles(userData: string, dir: string): string[] {
  const copied: string[] = []
  for (const name of [...SNAPSHOT_FILES, ...SNAPSHOT_DIRS]) {
    const source = path.join(userData, name)
    if (!fs.existsSync(source)) continue
    fs.mkdirSync(dir, { recursive: true })
    fs.cpSync(source, path.join(dir, name), { recursive: true, errorOnExist: false })
    copied.push(name)
  }
  return copied
}

/**
 * Decide, copy, stamp. Returns the snapshot taken, or null when none was
 * (a stable build, a second beta launch, or a directory with nothing in it
 * yet). The marker is written in every case so the next launch can decide.
 */
export function runPrereleaseSnapshot(
  userData: string,
  currentVersion: string,
  now: Date = new Date()
): SnapshotResult | null {
  const decision = snapshotDecision(readLastRun(userData), currentVersion)
  let result: SnapshotResult | null = null
  if (decision.snapshot && decision.fromVersion) {
    const dir = snapshotDir(userData, decision.fromVersion)
    const copied = copyStateFiles(userData, dir)
    if (copied.length > 0) result = { dir, fromVersion: decision.fromVersion, copied }
  }
  writeLastRun(userData, currentVersion, now)
  return result
}
