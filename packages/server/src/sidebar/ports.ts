/**
 * The sidebar's two ports: where the layouts are kept, and what the server
 * needs from whoever owns the windows. In this wave the Electron shell owns
 * the windows (which exist, which is primary, how a tab is handed from one
 * to another), so the server asks it through `SidebarHost` and keeps only
 * the layouts; the storage is a folder of JSON documents in the app's data
 * directory, or a Map for the tests and a server started without one.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MoveRefusal, MoveResult, WindowLayout } from '@clave/contract/sidebar'

type Refusal = typeof MoveRefusal.Type

/** Where window layouts are kept, one document per window key. */
export interface SidebarStorage {
  /** The stored layout as it is, unknown shape, or null when there is none. */
  read(windowKey: string): unknown
  write(windowKey: string, layout: WindowLayout): void
  remove(windowKey: string): void
  /** Every window key that has a document. */
  keys(): string[]
}

/** What the server needs from whoever owns the windows (the Electron shell). */
export interface SidebarHost {
  /** Whether this entry hosts windows at all. A server with none keeps the
   *  layouts and cannot move a tab between windows: the moves answer
   *  `CapabilityUnavailable` instead of pretending a window is missing. */
  readonly hostsWindows: boolean
  /** Every window that exists: live now, or persisted for the next boot. */
  knownWindowKeys(): ReadonlySet<string>
  isPrimary(windowKey: string): boolean
  isLive(windowKey: string): boolean
  /** Which of these sessions can move to the target window, and why the others cannot. */
  movable(
    sessionIds: ReadonlyArray<string>,
    targetWindowKey: string
  ): { movable: string[]; refused: Refusal[] }
  /** Detach the sessions from the windows that hold them and hand them to the target, with a layout for it to take in first; answers what moved. */
  rehome(
    sessionIds: ReadonlyArray<string>,
    targetWindowKey: string,
    options: { layout: WindowLayout | null; focus: boolean }
  ): MoveResult
  /** Tell the window that held a group that the group moved away whole. */
  groupMovedAway(windowKey: string, groupId: string): void
}

/** A storage that lives as long as the process: the tests' and a server's
 *  with no data directory. The documents are kept as written, so a test can
 *  seed an old-shaped one or compare one before and after. */
export function memorySidebarStorage(): SidebarStorage & { documents: Map<string, unknown> } {
  const documents = new Map<string, unknown>()
  return {
    documents,
    read: (windowKey) =>
      documents.has(windowKey) ? structuredClone(documents.get(windowKey)) : null,
    write: (windowKey, layout) => {
      documents.set(windowKey, structuredClone(layout))
    },
    remove: (windowKey) => {
      documents.delete(windowKey)
    },
    keys: () => [...documents.keys()]
  }
}

/** The key alphabet the contract accepts; a file named otherwise is not a window's. */
const KEY = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The layouts as files, `<dir>/sidebar-layouts/windows/<key>.json`, the
 * place the shell has always kept them. A write goes to a `.tmp` beside the
 * file and is renamed over it, so a crash mid-write leaves the old document
 * whole rather than half of the new one. A file that cannot be read or
 * parsed reads as no layout: the window starts empty instead of failing.
 */
export function fileSidebarStorage(dir: string): SidebarStorage {
  const folder = join(dir, 'sidebar-layouts', 'windows')
  const fileOf = (windowKey: string): string => join(folder, `${windowKey}.json`)
  return {
    read: (windowKey) => {
      try {
        return JSON.parse(readFileSync(fileOf(windowKey), 'utf8')) as unknown
      } catch {
        return null
      }
    },
    write: (windowKey, layout) => {
      mkdirSync(folder, { recursive: true })
      const file = fileOf(windowKey)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(layout, null, 2))
      renameSync(tmp, file)
    },
    remove: (windowKey) => {
      rmSync(fileOf(windowKey), { force: true })
    },
    keys: () => {
      let names: string[]
      try {
        names = readdirSync(folder)
      } catch {
        return []
      }
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((key) => KEY.test(key))
    }
  }
}

/** A host with no window at all: every move is refused, nothing is primary,
 *  so a server started without the shell keeps layouts and nothing else. */
export const noWindowsHost: SidebarHost = {
  hostsWindows: false,
  knownWindowKeys: () => new Set<string>(),
  isPrimary: () => false,
  isLive: () => false,
  movable: (sessionIds) => ({
    movable: [],
    refused: sessionIds.map((sessionId) => ({ sessionId, reason: 'not-live' as const }))
  }),
  rehome: (sessionIds) => ({
    moved: [],
    refused: sessionIds.map((sessionId) => ({ sessionId, reason: 'not-live' as const }))
  }),
  groupMovedAway: () => {}
}
