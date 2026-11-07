import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Stable directory where transient dropped files (e.g. macOS screenshot
 * previews) are copied so their paths survive long enough for the agent to
 * read them. macOS keeps an un-saved screenshot preview in a temp folder and
 * deletes it the moment the preview commits to the Desktop, leaving the path
 * the renderer handed to the PTY dangling.
 */
function getDroppedFilesDir(): string {
  return path.join(app.getPath('userData'), 'dropped-files')
}

/**
 * Source locations that macOS (and other apps) use for transient files that
 * may vanish before the agent reads them. Only files under these roots are
 * copied; files dragged from Finder already have stable paths and are passed
 * through untouched.
 */
function isTransientSource(sourcePath: string): boolean {
  const p = sourcePath.toLowerCase()
  return (
    p.includes('/temporaryitems/') ||
    p.includes('/t/com.apple.') ||
    p.includes('screencaptureui') ||
    p.startsWith('/private/var/folders/') ||
    p.startsWith('/var/folders/') ||
    p.startsWith('/tmp/') ||
    p.startsWith('/private/tmp/')
  )
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Delete dropped files older than MAX_AGE_MS so the directory doesn't grow unbounded. */
export function cleanupDroppedFiles(): void {
  const dir = getDroppedFilesDir()
  try {
    if (!fs.existsSync(dir)) return
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name)
      try {
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > MAX_AGE_MS) fs.rmSync(filePath, { force: true })
      } catch {
        // ignore individual file errors
      }
    }
  } catch (err) {
    console.warn('[dropped-files] cleanup failed:', (err as Error).message)
  }
}

export function registerDroppedFileHandlers(): void {
  // Copy a transient dropped file into stable storage and return the new path.
  // Returns the original path unchanged for non-transient sources, or null if
  // the source no longer exists / the copy fails.
  ipcMain.handle('files:persist-dropped', (_event, sourcePath: string): string | null => {
    try {
      if (!sourcePath) return null
      if (!isTransientSource(sourcePath)) return sourcePath
      if (!fs.existsSync(sourcePath)) return null
      // A folder (a repository or folder row of the Git tab, a Finder folder)
      // is passed through as it is: the copy below is for a single transient
      // file, and copyFileSync on a folder throws, which dropped the whole
      // drop on the floor for any folder under /tmp or /var/folders.
      if (fs.statSync(sourcePath).isDirectory()) return sourcePath

      const dir = getDroppedFilesDir()
      fs.mkdirSync(dir, { recursive: true })

      // Preserve the original filename but prefix with a high-resolution
      // timestamp to avoid collisions across drops of identically-named files.
      const base = path.basename(sourcePath)
      const destPath = path.join(dir, `${Date.now()}-${process.hrtime.bigint()}-${base}`)
      fs.copyFileSync(sourcePath, destPath)
      return destPath
    } catch (err) {
      console.warn('[dropped-files] persist failed:', (err as Error).message)
      return null
    }
  })
}
