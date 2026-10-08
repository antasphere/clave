/**
 * The `.clave` files over IPC: every arm calls the shell's one
 * `WorkspaceFiles` instance (`../workspace-files.ts`), the same object the
 * in-process server answers from, so a window on IPC and a window on the
 * server read one truth and one trust. The parser, the writer, the trust
 * store and the watchers moved to `@clave/server/workspace-files` (wave 3,
 * lane A); what stays here is Electron's: the review dialog on the asking
 * window, the IPC fan-out of a watched file's change to every window (the
 * push channel carries it to a window on the server; the preload hears one
 * of the two), and the save dialog, the paths and the preferences that were
 * always this file's.
 */
import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { ClaveFileWriteData, ReviewAnswer } from '@clave/contract/workspace-files'
import { windowRegistry } from '../window-registry'
import { shellReviewer, showReview, workspaceFiles } from '../workspace-files'

let fanOut: (() => void) | null = null

export function registerClaveFileHandlers(): void {
  const files = workspaceFiles()

  // Read a .clave file and resolve relative paths to absolute; an elevated
  // file nobody trusted is reviewed on the asking window.
  ipcMain.handle('clave:read-file', (event, absolutePath: string, rootDir?: string) =>
    files.read(absolutePath, {
      rootDir,
      reviewer: shellReviewer(BrowserWindow.fromWebContents(event.sender))
    })
  )

  // The dialog for a review the SERVER asked for: the preload that owns the
  // read hears the event on the push channel and asks here; it answers the
  // server itself.
  ipcMain.handle(
    'clave:review-dialog',
    (
      event,
      review: {
        path: string
        folder: string
        autoCommands: string[]
        prompts: string[]
        dangerous: boolean
      }
    ): Promise<ReviewAnswer> => showReview(BrowserWindow.fromWebContents(event.sender), review)
  )

  ipcMain.handle(
    'clave:write-file',
    (_event, absolutePath: string, pinned: ClaveFileWriteData, rootDir?: string): void => {
      try {
        files.write(absolutePath, pinned, rootDir)
      } catch (err) {
        console.error('[clave] Failed to write .clave file:', absolutePath, err)
      }
    }
  )

  ipcMain.handle('clave:discover-files', (_event, folderPath: string) => files.discover(folderPath))

  ipcMain.handle(
    'clave:discover-files-recursive',
    (
      _event,
      rootDir: string,
      config?: { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }
    ) => files.discoverRecursive(rootDir, config)
  )

  ipcMain.handle('clave:read-auto-discover', (_event, filePath: string) =>
    files.readAutoDiscover(filePath)
  )

  ipcMain.handle('clave:file-exists', (_event, absolutePath: string) => files.exists(absolutePath))

  ipcMain.handle('clave:watch-file', (_event, absolutePath: string) => files.watch(absolutePath))
  ipcMain.handle('clave:unwatch-file', (_event, absolutePath: string) =>
    files.unwatch(absolutePath)
  )

  // A watched file's change reaches every window over IPC; a window on the
  // server hears the same change on the push channel and listens to exactly
  // one of the two (`src/preload/dual-listener.ts`).
  fanOut?.()
  fanOut = files.onEvent((event) => {
    for (const win of windowRegistry.listWindows()) {
      if (!win.isDestroyed()) win.webContents.send('clave:file-changed', event.path)
    }
  })

  ipcMain.handle('clave:read-image', (_event, absolutePath: string) =>
    files.readImage(absolutePath)
  )

  // Trusted workspace roots (folder-level trust for .clave files)
  ipcMain.handle('clave:trust-root', (_event, root: string) => files.trustRoot(root))
  ipcMain.handle('clave:untrust-root', (_event, root: string) => files.untrustRoot(root))
  ipcMain.handle('clave:list-trusted-roots', () => files.listTrustedRoots())

  // Save dialog for exporting .clave files
  ipcMain.handle(
    'dialog:saveFile',
    async (
      _event,
      defaultName: string,
      filters: { name: string; extensions: string[] }[]
    ): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(_event.sender)
      const result = await dialog.showSaveDialog(win!, {
        defaultPath: defaultName,
        filters
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // Get the Downloads folder path
  ipcMain.handle('app:get-downloads-path', () => app.getPath('downloads'))
  ipcMain.handle('app:get-user-data-path', () => app.getPath('userData'))

  // Preferences get/set
  ipcMain.handle('preferences:get', (_event, key: string) => {
    return preferencesManager.get(key)
  })

  ipcMain.handle('preferences:set', (_event, key: string, value: unknown) => {
    preferencesManager.set(key, value)
  })
}

/** Cleanup all watchers (call on app quit) */
export function cleanupClaveWatchers(): void {
  workspaceFiles().close()
}

// ── Inline preferences manager (simple key-value JSON file) ──

class PreferencesManager {
  private filePath: string
  private cache: Record<string, unknown> = {}

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'clave-preferences.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      this.cache = JSON.parse(raw)
    } catch {
      this.cache = {}
    }
  }

  get(key: string): unknown {
    return this.cache[key] ?? null
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value
    this.save()
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('[preferences] Failed to save:', err)
    }
  }
}

const preferencesManager = new PreferencesManager()

/** Read a persisted app preference from the main process (e.g. the global
 *  tmux toggle, which the PTY spawn handler consults as a default). */
export function getPreference(key: string): unknown {
  return preferencesManager.get(key)
}

/** Persist one app preference from a main-process feature. */
export function setPreference(key: string, value: unknown): void {
  preferencesManager.set(key, value)
}
