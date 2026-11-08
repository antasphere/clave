import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type { PersistedWindow } from '../../shared/src/workspace-types'

/**
 * The windows to bring back at boot (PRDCT-1703). A window is the whole app
 * once more; several may show the same workspace. Each carries a persisted
 * `key` — the name of its sidebar layout file and the stamp on the session
 * records it opened — because BrowserWindow ids restart at 1 every launch.
 *
 * `<userData>/windows.json`: `{ version: 1, windows: [{ key, workspaceId,
 * bounds }] }`. Absent on the first boot of the multi-window build: that boot
 * mints the first window's key and migrates the older layout files into it
 * (see sidebar-layout-manager). Closing a non-last window removes it here;
 * quitting keeps every window so the next launch restores them all.
 *
 * Same discipline as the other main-side state files: synchronous
 * write-then-rename on every change, an in-memory cache during the run.
 */
interface WindowStateFile {
  version: 1
  windows: PersistedWindow[]
}

export const WINDOWS_FILE = 'windows.json'

function isBounds(x: unknown): x is NonNullable<PersistedWindow['bounds']> {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.x === 'number' &&
    typeof b.y === 'number' &&
    typeof b.width === 'number' &&
    typeof b.height === 'number' &&
    b.width > 0 &&
    b.height > 0
  )
}

export function isValidWindowKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key)
}

export class WindowStateStore {
  private cache: WindowStateFile | null = null

  constructor(private readonly filePath: string) {}

  private load(): WindowStateFile {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<WindowStateFile>
      const windows: PersistedWindow[] = []
      const seen = new Set<string>()
      for (const w of Array.isArray(raw.windows) ? raw.windows : []) {
        const entry = w as Partial<PersistedWindow> | null
        if (!entry || !isValidWindowKey(entry.key) || seen.has(entry.key)) continue
        seen.add(entry.key)
        windows.push({
          key: entry.key,
          workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
          ...(isBounds(entry.bounds) ? { bounds: entry.bounds } : {})
        })
      }
      this.cache = { version: 1, windows }
    } catch {
      // Absent or unreadable: no window to bring back. The entry treats an
      // empty list as the first boot of this build (it migrates the older
      // layout files into the first window it mints) — the one decision,
      // made in one place.
      this.cache = { version: 1, windows: [] }
    }
    return this.cache
  }

  private persist(): void {
    if (!this.cache) return
    try {
      const tmp = `${this.filePath}.tmp`
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('[windows] Failed to persist window state:', err)
    }
  }

  list(): PersistedWindow[] {
    return this.load().windows.map((w) => ({ ...w }))
  }

  keys(): Set<string> {
    return new Set(this.load().windows.map((w) => w.key))
  }

  has(key: string): boolean {
    return this.load().windows.some((w) => w.key === key)
  }

  mintKey(): string {
    return randomUUID()
  }

  /** Add or update a window entry. Fields not given keep their value. */
  upsert(key: string, patch: Partial<Omit<PersistedWindow, 'key'>>): void {
    const state = this.load()
    const existing = state.windows.find((w) => w.key === key)
    if (existing) {
      if (patch.workspaceId !== undefined) existing.workspaceId = patch.workspaceId
      if (patch.bounds !== undefined && isBounds(patch.bounds)) existing.bounds = patch.bounds
    } else {
      state.windows.push({
        key,
        workspaceId: patch.workspaceId ?? null,
        ...(patch.bounds && isBounds(patch.bounds) ? { bounds: patch.bounds } : {})
      })
    }
    this.persist()
  }

  remove(key: string): void {
    const state = this.load()
    const next = state.windows.filter((w) => w.key !== key)
    if (next.length === state.windows.length) return
    state.windows = next
    this.persist()
  }
}

export const windowState = new WindowStateStore(path.join(app.getPath('userData'), WINDOWS_FILE))
