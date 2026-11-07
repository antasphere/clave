import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { fileManager } from '../file-manager'
import { IGNORED_DIRECTORIES_SET, FS_WATCH_DEBOUNCE_MS } from '../constants'

/**
 * Active file system watchers keyed by webContents id. Each window holds a SET
 * of NON-recursive watchers — one per visible directory (the root plus every
 * expanded folder) — rather than a single recursive watch over the whole tree.
 * This keeps the watch scope equal to the display scope: opening "/" watches
 * only "/" itself, not the entire filesystem.
 */
interface WatchEntry {
  cwd: string
  /** relDir ('.' for root, else path relative to cwd) -> watcher */
  watchers: Map<string, fs.FSWatcher>
  changedDirs: Set<string>
  debounceTimer: NodeJS.Timeout | null
}

const fsWatchers = new Map<number, WatchEntry>()

function closeWatchEntry(wcId: number): void {
  const entry = fsWatchers.get(wcId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  for (const w of entry.watchers.values()) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  fsWatchers.delete(wcId)
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:save-download', async (event, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('Downloads require an application window.')
    const { remoteDownloadBytes } = await import('../server/file-transfers')
    const { name, bytes } = remoteDownloadBytes(input)
    const chosen = await dialog.showSaveDialog(win, { defaultPath: name })
    if (chosen.canceled || !chosen.filePath) return null
    await fs.promises.writeFile(chosen.filePath, bytes, { mode: 0o600 })
    return chosen.filePath
  })
  ipcMain.handle('fs:open-download', async (event, input: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender))
      throw new Error('Downloads require an application window.')
    const { saveRemoteDownload } = await import('../server/file-transfers')
    const local = await saveRemoteDownload(
      path.join(app.getPath('userData'), 'downloaded-files'),
      input
    )
    const error = await shell.openPath(local)
    if (error) throw new Error(error)
  })
  ipcMain.handle('fs:list-files', (_event, cwd: string) => fileManager.listFiles(cwd))
  ipcMain.handle('fs:read-dir', (_event, rootCwd: string, dirPath: string) =>
    fileManager.readDir(rootCwd, dirPath)
  )
  // Synchronous: lets the renderer's synchronous right-click handler check for a
  // file (e.g. slideless.json) without async flicker. Single boolean payload.
  ipcMain.on('fs:exists-sync', (event, rootCwd: string, relPath: string) => {
    event.returnValue = fileManager.existsSync(rootCwd, relPath)
  })
  ipcMain.handle('fs:read-file', (_event, rootCwd: string, filePath: string) =>
    fileManager.readFile(rootCwd, filePath)
  )
  ipcMain.handle('fs:stat', (_event, rootCwd: string, filePath: string) =>
    fileManager.stat(rootCwd, filePath)
  )
  ipcMain.handle('fs:write-file', (_event, rootCwd: string, filePath: string, content: string) =>
    fileManager.writeFile(rootCwd, filePath, content)
  )
  ipcMain.handle('fs:create-file', (_event, rootCwd: string, filePath: string) =>
    fileManager.createFile(rootCwd, filePath)
  )
  ipcMain.handle('fs:create-directory', (_event, rootCwd: string, dirPath: string) =>
    fileManager.createDirectory(rootCwd, dirPath)
  )
  ipcMain.handle('shell:showItemInFolder', (_event, fullPath: string) => {
    shell.showItemInFolder(fullPath)
  })

  // File system watcher — reconciles a set of non-recursive watches to exactly
  // the directories currently visible in the tree (root + expanded folders).
  // `relDirs` are paths relative to `cwd` ('.' for the root is implicit).
  ipcMain.handle('fs:watch', (_event, cwd: string, relDirs: string[] = []) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return

    const wcId = _event.sender.id

    // A different cwd means a different tree — start fresh.
    let entry = fsWatchers.get(wcId)
    if (entry && entry.cwd !== cwd) {
      closeWatchEntry(wcId)
      entry = undefined
    }
    if (!entry) {
      entry = { cwd, watchers: new Map(), changedDirs: new Set(), debounceTimer: null }
      fsWatchers.set(wcId, entry)
    }
    const e = entry

    const flush = (): void => {
      if (e.debounceTimer) clearTimeout(e.debounceTimer)
      e.debounceTimer = setTimeout(() => {
        if (win && !win.isDestroyed() && e.changedDirs.size > 0) {
          win.webContents.send('fs:changed', cwd, Array.from(e.changedDirs))
        }
        e.changedDirs.clear()
      }, FS_WATCH_DEBOUNCE_MS)
    }

    const desired = new Set<string>(['.', ...relDirs])

    // Add watches for newly-visible directories.
    for (const relDir of desired) {
      if (e.watchers.has(relDir)) continue
      const absDir = relDir === '.' ? cwd : path.join(cwd, relDir)
      try {
        const watcher = fs.watch(absDir, (_eventType, filename) => {
          // Non-recursive: filename is the changed entry's basename in this dir.
          if (filename) {
            const base = filename.toString().split(path.sep).pop() ?? ''
            if (IGNORED_DIRECTORIES_SET.has(base)) return
          }
          e.changedDirs.add(relDir)
          flush()
        })
        watcher.on('error', () => {
          try {
            watcher.close()
          } catch {
            /* already closed */
          }
          e.watchers.delete(relDir)
        })
        e.watchers.set(relDir, watcher)
      } catch {
        // Directory may not exist or be unreadable — skip it.
      }
    }

    // Drop watches for directories that are no longer visible.
    for (const relDir of [...e.watchers.keys()]) {
      if (desired.has(relDir)) continue
      try {
        e.watchers.get(relDir)?.close()
      } catch {
        /* already closed */
      }
      e.watchers.delete(relDir)
    }
  })

  ipcMain.handle('fs:unwatch', (_event) => {
    closeWatchEntry(_event.sender.id)
  })
}
