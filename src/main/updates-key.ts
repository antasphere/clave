import { BrowserWindow, globalShortcut, ipcMain, type IpcMainEvent } from 'electron'
import { chordToAccelerator, type ResolvedKeymapConfig } from '../shared/keymaps'
import { getStoredKeymapConfig } from './ipc-handlers/keymap-handlers'
import { preferencesManager } from './preferences-manager'
import { installE2eHooks } from './sessions/e2e-hooks'
import { TEST_NO_ACTIVATE } from './test-mode'

/* The update key of Folio's play mode (PRDCT-4832). Each window reports its
   updates (`updates:status`: whether an update waits or a reading plays, and
   the oldest update's time); the key, from any window or from another app,
   goes to the window it concerns (`pickWindow`): the one playing, else the
   one holding the oldest update. System-wide, the key is held ONLY while some
   window is active and the preference `updatesKeyEverywhere` is on: the
   accelerators of the single-chord bindings of `playUpdate`, registered by
   name and unregistered by name (never `unregisterAll`: another module may
   register its own one day). Under `--test-no-activate` nothing reaches the
   OS: the list that would be registered is kept for the specs
   (`__claveE2E.updatesKey`). */

export interface UpdatesStatus {
  active: boolean
  playing: boolean
  oldestAt: number | null
}

/** The window the key goes to: a window that is playing wins; else the one
 *  with the oldest waiting update; else none. Pure. */
export function pickWindow(statuses: ReadonlyMap<number, UpdatesStatus>): number | null {
  let oldest: { id: number; at: number } | null = null
  for (const [id, status] of statuses) {
    if (status.playing) return id
    if (status.active && status.oldestAt !== null && (!oldest || status.oldestAt < oldest.at))
      oldest = { id, at: status.oldestAt }
  }
  return oldest?.id ?? null
}

/** The accelerators the key is held under, from the bindings. Pure. */
export function updateAccelerators(
  config: ResolvedKeymapConfig,
  platform: NodeJS.Platform
): string[] {
  const out: string[] = []
  for (const binding of config.bindings.playUpdate ?? []) {
    const accelerator = chordToAccelerator(binding, platform)
    if (accelerator && !out.includes(accelerator)) out.push(accelerator)
  }
  return out
}

export function readStatus(raw: unknown): UpdatesStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.active !== 'boolean' || typeof value.playing !== 'boolean') return null
  const oldestAt = typeof value.oldestAt === 'number' ? value.oldestAt : null
  return { active: value.active, playing: value.playing, oldestAt }
}

const statuses = new Map<number, UpdatesStatus>()
/** The accelerators held now (registered with the OS, or kept for the specs
 *  in test mode). */
let held: string[] = []
const refusedOnce = new Set<string>()

function route(): boolean {
  const id = pickWindow(statuses)
  if (id === null) return false
  const window = BrowserWindow.fromId(id)
  if (!window || window.isDestroyed()) {
    statuses.delete(id)
    sync()
    return false
  }
  window.webContents.send('updates:toggle')
  return true
}

function release(): void {
  if (!TEST_NO_ACTIVATE)
    for (const accelerator of held) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* already gone */
      }
    }
  held = []
}

/** Hold the key while it is wanted, under the bindings of now; release it
 *  the moment it is not. */
function sync(): void {
  const wanted =
    preferencesManager.get('updatesKeyEverywhere') !== false &&
    [...statuses.values()].some((status) => status.active)
  const next = wanted ? updateAccelerators(getStoredKeymapConfig(), process.platform) : []
  if (next.length === held.length && next.every((a, i) => a === held[i])) return
  release()
  for (const accelerator of next) {
    if (TEST_NO_ACTIVATE) {
      held.push(accelerator)
      continue
    }
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => void route())
    } catch {
      ok = false
    }
    if (ok) held.push(accelerator)
    else if (!refusedOnce.has(accelerator)) {
      refusedOnce.add(accelerator)
      console.warn(`[updates-key] the system refused ${accelerator}; the key works inside Clave`)
    }
  }
}

/** The keymap changed: hold the new bindings. */
export function updatesKeyBindingsChanged(): void {
  release()
  sync()
}

export function registerUpdatesKey(): void {
  ipcMain.on('updates:status', (event: IpcMainEvent, raw: unknown) => {
    const status = readStatus(raw)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!status || !window) return
    const id = window.id
    if (!statuses.has(id))
      window.once('closed', () => {
        statuses.delete(id)
        sync()
      })
    statuses.set(id, status)
    sync()
  })
  ipcMain.handle('updates:toggle', () => route())
  ipcMain.handle(
    'updates:key-everywhere:get',
    () => preferencesManager.get('updatesKeyEverywhere') !== false
  )
  ipcMain.handle('updates:key-everywhere:set', (_event, value: unknown) => {
    preferencesManager.set('updatesKeyEverywhere', value === true)
    sync()
    return value === true
  })
  installE2eHooks({
    updatesKey: { registered: () => [...held], press: () => route() }
  })
}

/** On quit: the OS gets its keys back. */
export function releaseUpdatesKey(): void {
  release()
}
