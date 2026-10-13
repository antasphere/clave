import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { Workspace, WorkspaceStateFile } from '../shared/workspace-types'
import { lazySettingsPorts, type SettingsPorts } from './ports/registry'
import { readJson, writeJson, type StoragePort } from './ports/storage'

const STATE_FILE = 'workspace-state.json'
const LEGACY_PREFERENCES_FILE = 'clave-preferences.json'
const TRUSTED_ROOTS_FILE = 'clave-trusted-roots.json'

/** Resolve symlinks + normalize, mirroring the trust-root normalization so the
 *  same path always compares equal regardless of how it was spelled. */
function normalizeDir(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

/** "/Users/x/.antasphere" → "Antasphere" — strip leading dots, capitalize. */
function workspaceNameFromRoot(rootDir: string): string {
  const base = path.basename(rootDir).replace(/^\.+/, '')
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : rootDir
}

/** True when child is parent itself or lives underneath it (both normalized). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Shape of the retired per-file registry entries in clave-preferences.json.
 *  Two generations existed: {claveFilePath, rootDir?} and the even older
 *  {path} (a folder holding workspace.clave). Read-only here — the keys are
 *  left in place as an implicit backup and are never written again. */
interface LegacyWorkspaceEntry {
  id?: string
  name?: string
  claveFilePath?: string
  path?: string
  rootDir?: string | null
}

function withLastActive(
  base: Omit<WorkspaceStateFile, 'lastActiveWorkspaceId' | 'activeWorkspaceId'>,
  lastActive: string | null
): WorkspaceStateFile {
  // Both keys carry the same value: the new one is what this build reads,
  // the old one is what the previous release reads after a downgrade.
  return { ...base, lastActiveWorkspaceId: lastActive, activeWorkspaceId: lastActive }
}

function emptyState(): WorkspaceStateFile {
  return withLastActive({ version: 1, workspaces: [], pins: [], pinsMigrated: true }, null)
}

/** Trust a workspace root for `.clave` files. The trusted-roots file is owned
 *  by the `.clave` trust boundary in `ipc-handlers/clave-file-handlers.ts`,
 *  which caches it on first read; this one-time migration writes it before any
 *  window exists, so that cache is still cold, and the file shape (a JSON
 *  array of normalized absolute paths) is the one that module reads. */
function grantTrustedRoot(storage: StoragePort, rootDir: string): void {
  const raw = readJson(storage, TRUSTED_ROOTS_FILE)
  const roots = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : []
  const norm = normalizeDir(rootDir)
  if (roots.includes(norm)) return
  roots.push(norm)
  writeJson(storage, TRUSTED_ROOTS_FILE, roots)
}

/** One-time Phase A migration: collapse the retired per-file registry into
 *  per-root workspaces. Runs only when workspace-state.json doesn't exist. */
function migrateLegacyRegistry(storage: StoragePort): WorkspaceStateFile {
  const legacy = readJson(storage, LEGACY_PREFERENCES_FILE) as Record<string, unknown> | null
  const rawEntries = legacy?.workspaces
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return emptyState()
  const legacyActiveId =
    typeof legacy?.activeWorkspaceId === 'string' ? legacy.activeWorkspaceId : null

  const userData = normalizeDir(storage.pathOf('.'))
  const byRoot = new Map<string, { entries: LegacyWorkspaceEntry[]; files: string[] }>()
  let activeFile: string | null = null

  for (const entry of rawEntries as LegacyWorkspaceEntry[]) {
    const filePath =
      entry.claveFilePath ?? (entry.path ? path.join(entry.path, 'workspace.clave') : null)
    if (!filePath) continue
    // The generated "Init" snapshot lived in userData — not a real workspace.
    if (isInside(userData, normalizeDir(path.dirname(filePath)))) continue

    const rootDir = normalizeDir(entry.rootDir ?? path.dirname(filePath))
    const group = byRoot.get(rootDir) ?? { entries: [], files: [] }
    group.entries.push(entry)
    group.files.push(filePath)
    byRoot.set(rootDir, group)
    if (entry.id && entry.id === legacyActiveId) activeFile = filePath
  }

  const workspaces: Workspace[] = []
  let activeWorkspaceId: string | null = null

  for (const [rootDir, group] of byRoot) {
    // Profile priority: the file that was active > default.clave > first.
    const profileFile =
      (activeFile && group.files.includes(activeFile) ? activeFile : null) ??
      group.files.find((f) => path.basename(f) === 'default.clave') ??
      group.files[0] ??
      null

    const ws: Workspace = {
      id: randomUUID(),
      name: workspaceNameFromRoot(rootDir),
      rootDir,
      profileFile,
      createdAt: Date.now()
    }
    workspaces.push(ws)
    grantTrustedRoot(storage, rootDir)
    if (activeFile && group.files.includes(activeFile)) activeWorkspaceId = ws.id
  }

  if (!activeWorkspaceId && workspaces.length > 0) activeWorkspaceId = workspaces[0].id

  // pinsMigrated: false → the renderer still has to import localStorage pins.
  return withLastActive(
    { version: 1, workspaces, pins: [], pinsMigrated: false },
    activeWorkspaceId
  )
}

/** The pins partition a blueprint belongs to: its workspace, or the null
 *  (unstamped) partition. The renderer's pinned-store owns the shape; main
 *  only ever looks at this one key. */
function pinPartition(pin: unknown): string | null {
  const ws = (pin as { workspaceId?: unknown } | null)?.workspaceId
  return typeof ws === 'string' ? ws : null
}

/** Replace the `scope` partition of `existing` with `incoming`. A pin id names
 *  ONE pin: a pin that arrives stamped for `scope` leaves whichever other
 *  partition still holds it (the renderer re-stamps a pin from null to a
 *  workspace id on its boot refresh; the write for the new partition must not
 *  leave the old copy behind, or the two hydrate side by side at the next
 *  boot and the group shows twice — then three times, then four). Exported
 *  for the unit test; `updatePins` is its only caller. */
export function mergePinsPartition(
  existing: unknown[],
  scope: string | null | 'all',
  pins: unknown[]
): unknown[] {
  const incoming = Array.isArray(pins) ? pins : []
  if (scope === 'all') return incoming
  const incomingIds = new Set<string>()
  for (const p of incoming) {
    const id = (p as { id?: unknown })?.id
    if (typeof id === 'string') incomingIds.add(id)
  }
  const kept = existing.filter((p) => {
    if (pinPartition(p) === scope) return false
    const id = (p as { id?: unknown })?.id
    return !(typeof id === 'string' && incomingIds.has(id))
  })
  return [...kept, ...incoming]
}

/** Persisted workspace registry + pins. Same philosophy as the sidebar
 *  layouts: synchronous write-then-rename on every change (survives a hard
 *  kill), the renderer as source of truth during a run, and an in-memory
 *  cache so the PTY layer can stamp spawns synchronously.
 *
 *  Since multi-window (PRDCT-1703) the file is written FIELD BY FIELD from
 *  main — `updateRegistry`, `updatePins`, `setLastActive` — instead of being
 *  replaced whole by whichever window saved last: the registry and the pins
 *  are global, each window only ever rewrites the pins of workspaces it
 *  hosts, and the old global "active workspace" survives only as the
 *  last-active default for the first window of the next run. */
export class WorkspaceManager {
  private cache: WorkspaceStateFile | null = null
  /** realpath is a syscall per call; roots barely change, so cache them. */
  private normalizedRoots = new Map<string, string>()

  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  load(): WorkspaceStateFile {
    if (this.cache) return this.cache
    const raw = readJson(this.ports.storage, STATE_FILE)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const data = raw as Partial<WorkspaceStateFile>
      // New key first, old key as the fallback for a file written by the
      // previous release.
      const lastActive =
        typeof data.lastActiveWorkspaceId === 'string'
          ? data.lastActiveWorkspaceId
          : typeof data.activeWorkspaceId === 'string'
            ? data.activeWorkspaceId
            : null
      this.cache = withLastActive(
        {
          version: 1,
          workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
          pins: Array.isArray(data.pins) ? data.pins : [],
          pinsMigrated: data.pinsMigrated !== false
        },
        lastActive
      )
      // A file from the previous release carries only the old key: write it
      // back once with both, so the new key exists from the first boot on.
      if (typeof data.lastActiveWorkspaceId !== 'string' && lastActive !== null) this.persist()
    } else {
      // First boot of the workspace model — migrate the retired registry.
      this.cache = migrateLegacyRegistry(this.ports.storage)
      this.persist()
    }
    return this.cache
  }

  private persist(): void {
    if (!this.cache) return
    try {
      // Write-then-rename (the port's) so a kill mid-write can never leave a truncated file.
      writeJson(this.ports.storage, STATE_FILE, this.cache)
    } catch (err) {
      console.error('[workspace] Failed to persist workspace state:', err)
    }
  }

  /** Replace the registry (the list of workspaces). Global: any window. */
  updateRegistry(workspaces: Workspace[]): void {
    const state = this.load()
    this.cache = { ...state, workspaces: Array.isArray(workspaces) ? workspaces : [] }
    this.persist()
  }

  /** Replace ONE partition of the pins — the blueprints stamped with
   *  `workspaceId` (null = the unstamped ones) — leaving every other
   *  workspace's pins untouched. `'all'` replaces the whole list: the one-time
   *  localStorage import (Phase B) is its only caller. Either way the pins
   *  are now migrated. */
  updatePins(scope: string | null | 'all', pins: unknown[]): void {
    const state = this.load()
    this.cache = { ...state, pins: mergePinsPartition(state.pins, scope, pins), pinsMigrated: true }
    this.persist()
  }

  setLastActive(workspaceId: string | null): void {
    const state = this.load()
    if (state.lastActiveWorkspaceId === workspaceId) return
    this.cache = withLastActive(state, workspaceId)
    this.persist()
  }

  getLastActiveWorkspaceId(): string | null {
    return this.load().lastActiveWorkspaceId
  }

  /** What the first window of a run opens on: the last-active workspace when
   *  it is still registered, else the first registered one, else null (the
   *  no-workspace onboarding state). */
  resolveInitialWorkspaceId(): string | null {
    const { workspaces, lastActiveWorkspaceId } = this.load()
    if (lastActiveWorkspaceId && workspaces.some((w) => w.id === lastActiveWorkspaceId)) {
      return lastActiveWorkspaceId
    }
    return workspaces[0]?.id ?? null
  }

  getWorkspaces(): Workspace[] {
    return this.load().workspaces
  }

  isRegistered(workspaceId: string): boolean {
    return this.load().workspaces.some((w) => w.id === workspaceId)
  }

  /** Workspace whose rootDir contains cwd (longest prefix wins — defense for
   *  nested roots even though registration rejects them). Null when outside
   *  every registered root. Used to place legacy, unstamped session records
   *  and, in the sidebar-layout migration, unstamped groups. Both sides are
   *  realpath-normalized: a root registered through a symlink (`/tmp` is one
   *  on macOS) must still contain the realpath'd cwd of its sessions. */
  resolveWorkspaceForCwd(cwd: string): string | null {
    const real = normalizeDir(cwd)
    let best: { id: string; len: number } | null = null
    for (const ws of this.load().workspaces) {
      let root = this.normalizedRoots.get(ws.rootDir)
      if (!root) {
        root = normalizeDir(ws.rootDir)
        this.normalizedRoots.set(ws.rootDir, root)
      }
      if (isInside(root, real) && (!best || root.length > best.len)) {
        best = { id: ws.id, len: root.length }
      }
    }
    return best?.id ?? null
  }
}

export const workspaceManager = new WorkspaceManager()
