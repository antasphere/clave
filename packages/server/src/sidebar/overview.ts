/**
 * The sidebar overview: every window's groups as a paired phone may read
 * them (`GetSidebarOverview`, `GET /sidebar/overview`). A projection, never
 * a second copy: it is read off whoever holds the layouts at the moment of
 * the call, through a source.
 *
 * Two sources exist because the layouts do not always live in the server a
 * phone reaches. In process and on a daemon the server holds them itself
 * (`layoutsOverviewSource` over the `SidebarLayouts` it was given). A Mac
 * that runs its server as a child of the app (`--server=separate`, the
 * packaged default) keeps them in the app's own process, written to the
 * app's data folder at every change, and the child holds none; there the
 * child reads those files (`shellFilesOverviewSource`), and never writes
 * them: the app stays the one writer.
 *
 * Imports nothing of Effect, like `layouts.ts`, so the entry can build a
 * source at boot through `@clave/server/sidebar-layouts`.
 */
import { type FSWatcher, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import type { OverviewGroup, OverviewWindow, SidebarOverview } from '@clave/contract/sidebar'
import { normalizeLayout } from '@clave/contract/sidebar/ops'
import type { SidebarLayouts, Unsubscribe } from './layouts'
import { fileSidebarStorage } from './ports'

/** What the projection reads of a group: the fields of any layout's group. */
export interface OverviewGroupInput {
  readonly id: string
  readonly name: string
  readonly sessionIds: ReadonlyArray<string>
  readonly collapsed: boolean
  readonly color?: string | null
  readonly workspaceId?: string
}

/** What the projection reads of a window. */
export interface OverviewWindowInput {
  readonly windowKey: string
  readonly workspaceId?: string | null
  readonly groups: ReadonlyArray<OverviewGroupInput>
  readonly displayOrder: ReadonlyArray<string>
}

/**
 * The overview of these windows, in the order given, each window's groups
 * and top level in the layout's own order. Every field is named here one by
 * one, so a field added to the layout later (a prompt, a terminal, a view)
 * does not reach a phone without somebody writing it into this function.
 */
export function projectSidebarOverview(
  windows: ReadonlyArray<OverviewWindowInput>
): SidebarOverview {
  return {
    windows: windows.map((window): OverviewWindow => {
      const groups = window.groups.map((group): OverviewGroup => {
        const out: { -readonly [K in keyof OverviewGroup]: OverviewGroup[K] } = {
          id: group.id,
          name: group.name,
          collapsed: group.collapsed,
          sessionIds: [...group.sessionIds]
        }
        if (typeof group.color === 'string') out.color = group.color
        if (typeof group.workspaceId === 'string') out.workspaceId = group.workspaceId
        return out
      })
      return {
        windowKey: window.windowKey,
        ...(typeof window.workspaceId === 'string' && { workspaceId: window.workspaceId }),
        displayOrder: [...window.displayOrder],
        groups
      }
    })
  }
}

/** Where the overview is read from, and word that it may have changed. */
export interface SidebarOverviewSource {
  read(): SidebarOverview
  /** Told after a change, with nothing about it: the listener reads again. */
  onChange(listener: () => void): Unsubscribe
}

/**
 * The overview of the layouts this server holds: every window key it knows
 * (one, `server`, on a daemon). `workspaceOf` names the workspace a window
 * shows, when whoever owns the windows knows it (the shell's window list).
 */
export function layoutsOverviewSource(
  layouts: SidebarLayouts,
  options: { workspaceOf?: (windowKey: string) => string | null | undefined } = {}
): SidebarOverviewSource {
  return {
    read: () =>
      projectSidebarOverview(
        layouts.list().map((layout) => ({
          ...layout,
          workspaceId: options.workspaceOf?.(layout.windowKey) ?? null
        }))
      ),
    onChange: (listener) => layouts.onChange(() => listener())
  }
}

/** The app's window list, `<dir>/windows.json` (`src/main/window-state.ts`):
 *  each window's key and the workspace it shows, in the app's order. A file
 *  that is absent or unreadable is no window. */
function readWindowList(dir: string): Array<{ key: string; workspaceId: string | null }> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'windows.json'), 'utf8')) as {
      windows?: unknown
    }
    if (!Array.isArray(raw.windows)) return []
    const out: Array<{ key: string; workspaceId: string | null }> = []
    for (const entry of raw.windows as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const { key, workspaceId } = entry as { key?: unknown; workspaceId?: unknown }
      if (typeof key !== 'string') continue
      out.push({ key, workspaceId: typeof workspaceId === 'string' ? workspaceId : null })
    }
    return out
  } catch {
    return []
  }
}

/** How long the files are left to settle before a change is told: a save is
 *  a write to a `.tmp` and a rename, two or more watch events for one change. */
const SETTLE_MS = 250
/** How often a folder that does not exist yet is looked for again. */
const REARM_MS = 5_000

/**
 * The overview of the layouts the app keeps in its own data folder
 * (`<dir>/sidebar-layouts/windows/<key>.json`, written by the app's
 * `SidebarLayouts` over `fileSidebarStorage`), read at every call and never
 * written. The windows come in the app's own order (`windows.json`), with
 * the workspace each one shows; a layout file of a window the list does not
 * name (a window closed while the app was not running) comes after, by key.
 *
 * A change is noticed by watching the folder, once somebody listens, and
 * told once the files have settled. A folder that does not exist yet (an
 * app that never saved a layout) is looked for again every few seconds.
 */
export function shellFilesOverviewSource(
  dir: string,
  options: { settleMs?: number; rearmMs?: number } = {}
): SidebarOverviewSource {
  const storage = fileSidebarStorage(dir)
  const folder = join(dir, 'sidebar-layouts', 'windows')
  const settleMs = options.settleMs ?? SETTLE_MS
  const rearmMs = options.rearmMs ?? REARM_MS
  const listeners = new Set<() => void>()
  let watcher: FSWatcher | null = null
  let settle: ReturnType<typeof setTimeout> | null = null
  let rearm: ReturnType<typeof setTimeout> | null = null

  const tell = (): void => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[clave-server] sidebar overview listener failed', error)
        }
      }
    }, settleMs)
    settle.unref?.()
  }
  /** Watch the folder. `news`: the folder appeared after a first look
   *  found none, so what it holds now is a change; the first look is not. */
  const open = (news: boolean): void => {
    rearm = null
    if (watcher || listeners.size === 0) return
    try {
      watcher = watch(folder, (_event, name) => {
        // The `.tmp` beside a file is half a save; its rename is the change.
        if (name === null || String(name).endsWith('.json')) tell()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        schedule()
      })
      watcher.unref?.()
      if (news) tell()
    } catch {
      schedule()
    }
  }
  const schedule = (): void => {
    if (rearm || listeners.size === 0) return
    rearm = setTimeout(() => open(true), rearmMs)
    rearm.unref?.()
  }
  const disarm = (): void => {
    watcher?.close()
    watcher = null
    if (settle) clearTimeout(settle)
    if (rearm) clearTimeout(rearm)
    settle = null
    rearm = null
  }

  return {
    read: () => {
      const stored = new Set(storage.keys())
      const named: Array<{ key: string; workspaceId: string | null }> = []
      for (const window of readWindowList(dir)) {
        // A window with no layout file has no sidebar to show yet; a key the
        // list names twice is one window.
        if (!stored.has(window.key) || named.some((w) => w.key === window.key)) continue
        named.push(window)
      }
      const rest = [...stored]
        .filter((key) => !named.some((w) => w.key === key))
        .sort()
        .map((key) => ({ key, workspaceId: null }))
      return projectSidebarOverview(
        [...named, ...rest].map(({ key, workspaceId }) => ({
          windowKey: key,
          workspaceId,
          ...normalizeLayout(storage.read(key))
        }))
      )
    },
    onChange: (listener) => {
      listeners.add(listener)
      if (!watcher && !rearm) open(false)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) disarm()
      }
    }
  }
}
