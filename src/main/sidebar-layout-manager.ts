import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import {
  concatLayouts,
  partitionLegacyLayout,
  type PartitionContext,
  type SidebarLayoutData
} from './sidebar-layout-migration'

/** The one-shot migration of the older sidebar-layout shapes into the first
 *  window's file. The layouts themselves (one file per window under
 *  `sidebar-layouts/windows/<windowKey>.json`, the orphans the primary takes
 *  in, the moves between windows) are the sidebar domain's since PRDCT-3241:
 *  `src/main/sidebar-layouts.ts` runs it in this process and the server
 *  package's `fileSidebarStorage` reads and writes the same files. What
 *  stays here is what runs once, on the first boot with no windows.json:
 *  the single `sidebar-layout.json` every release before multi-window
 *  wrote, and the per-workspace `sidebar-layouts/<workspaceId>.json` files
 *  of the halted one-workspace-per-window build (dev only), concatenated
 *  into the first window's file. Sources are RENAMED to `.migrated-backup`,
 *  never deleted. */
export type SidebarLayout = SidebarLayoutData

export const LEGACY_LAYOUT_FILE = 'sidebar-layout.json'
export const LAYOUTS_DIR = 'sidebar-layouts'
export const WINDOW_LAYOUTS_DIR = 'windows'
export const MIGRATED_BACKUP_SUFFIX = '.migrated-backup'

/** Keys become file names: only the id alphabet we mint (uuids) is accepted,
 *  so a malformed key can never escape the layouts directory. */
export function isValidLayoutKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key)
}

function normalize(data: unknown): SidebarLayout {
  const d = data as Partial<SidebarLayout> | null
  return {
    groups: Array.isArray(d?.groups) ? d!.groups : [],
    displayOrder: Array.isArray(d?.displayOrder) ? d!.displayOrder : []
  }
}

export const EMPTY_LAYOUT: SidebarLayout = { groups: [], displayOrder: [] }

export class SidebarLayoutManager {
  private readonly legacyPath: string
  private readonly workspaceDir: string
  private readonly windowDir: string

  constructor(userData: string) {
    this.legacyPath = path.join(userData, LEGACY_LAYOUT_FILE)
    this.workspaceDir = path.join(userData, LAYOUTS_DIR)
    this.windowDir = path.join(userData, LAYOUTS_DIR, WINDOW_LAYOUTS_DIR)
  }

  fileForWindow(key: string): string | null {
    return isValidLayoutKey(key) ? path.join(this.windowDir, `${key}.json`) : null
  }

  private readFile(file: string): SidebarLayout | null {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf-8')))
    } catch {
      return null
    }
  }

  private writeFile(file: string, data: SidebarLayout): void {
    const payload = JSON.stringify(normalize(data), null, 2)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Write-then-rename so a kill mid-write can never leave a truncated file.
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, payload, 'utf-8')
    fs.renameSync(tmp, file)
  }

  /** A window's own layout as the file holds it; empty when it has none yet. */
  loadForWindow(key: string): SidebarLayout {
    const file = this.fileForWindow(key)
    return (file ? this.readFile(file) : null) ?? { groups: [], displayOrder: [] }
  }

  saveForWindow(key: string, data: SidebarLayout): boolean {
    const file = this.fileForWindow(key)
    if (!file) return false
    this.writeFile(file, data)
    return true
  }

  /**
   * One-time migration into the FIRST window's file, run by main on the first
   * boot with no windows.json. Gathers, in this order: the legacy single file
   * (partitioned by workspace when any is registered — that stamps each
   * unstamped group with the workspace its cwd falls under, the same rule the
   * halted build applied — else taken as is), then every per-workspace file.
   * Concatenated (ids deduplicated), written under `windowKey`, every source
   * renamed to `.migrated-backup`. Idempotent: a second run finds no sources.
   * Returns the number of sources migrated.
   */
  migrateIntoWindow(windowKey: string, ctx: PartitionContext | null): number {
    const sources: { file: string; layout: SidebarLayout | null }[] = []
    if (fs.existsSync(this.legacyPath)) {
      const legacy = this.readFile(this.legacyPath)
      let layout: SidebarLayout | null = legacy
      if (legacy && ctx && ctx.workspaceIds.length > 0) {
        layout = concatLayouts([...partitionLegacyLayout(legacy, ctx).values()])
      }
      sources.push({ file: this.legacyPath, layout })
    }
    let perWorkspace: string[] = []
    try {
      perWorkspace = fs
        .readdirSync(this.workspaceDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(this.workspaceDir, f))
    } catch {
      perWorkspace = []
    }
    for (const file of perWorkspace) sources.push({ file, layout: this.readFile(file) })
    if (sources.length === 0) return 0

    const merged = concatLayouts(
      [this.loadForWindow(windowKey), ...sources.map((s) => s.layout)].filter(
        (l): l is SidebarLayout => l !== null
      )
    )
    this.saveForWindow(windowKey, merged)
    for (const s of sources) {
      // Unreadable sources are parked too, so they are never re-attempted
      // (and never lost) — there is nothing to migrate from them.
      fs.renameSync(s.file, `${s.file}${MIGRATED_BACKUP_SUFFIX}`)
    }
    console.log(
      `[sidebar-layout] migrated ${sources.length} layout file(s) into window ${windowKey}; sources kept as ${MIGRATED_BACKUP_SUFFIX}`
    )
    return sources.length
  }
}

export const sidebarLayoutManager = new SidebarLayoutManager(app.getPath('userData'))
