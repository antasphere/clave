import { ipcMain, app, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { preferencesManager, type AppIcon } from '../preferences-manager'
import { hapticTick, type HapticPattern } from '../haptic-manager'

const VALID_ICONS = ['dark', 'light', 'claude'] as const

const logPath = join(app.getPath('userData'), 'icon-debug.log')

function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.appendFileSync(logPath, line)
  } catch {
    // ignore
  }
}

/**
 * Resolve the on-disk path for an icon PNG (fallback for dev mode).
 * In packaged builds, resources are asar-unpacked so osascript can read them.
 * In dev, __dirname is src/main/ → ../../resources/ works directly.
 */
function getIconPath(icon: string): string {
  const base = join(__dirname, '../../resources')
  const asarUnpacked = base.replace('app.asar', 'app.asar.unpacked')
  return join(asarUnpacked, `icon-${icon}.png`)
}

/**
 * Resolve the on-disk path for an .icon bundle.
 */
function getIconBundlePath(icon: string): string {
  const base = join(__dirname, '../../resources')
  const asarUnpacked = base.replace('app.asar', 'app.asar.unpacked')
  return join(asarUnpacked, `AppIcon-${icon}.icon`)
}

/**
 * Derive the .app bundle path from the executable path.
 * e.g. /Applications/Clave.app/Contents/MacOS/Clave → /Applications/Clave.app
 */
function getAppBundlePath(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null
  const exePath = app.getPath('exe')
  const appPath = exePath.replace(/\/Contents\/MacOS\/.*$/, '')
  return appPath.endsWith('.app') ? appPath : null
}

/**
 * Copy a directory recursively (sync).
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Copy the selected .icon bundle into the .app's Contents/Resources,
 * then refresh the Dock so macOS re-renders with the native Tahoe glass effect.
 *
 * This replaces the build-time AppIcon.icon with the selected variant.
 * The glass/translucency/shadow metadata in the .icon bundle is preserved,
 * so macOS renders the icon natively (including the Tahoe glow effect).
 */
function setAppBundleIconBundle(icon: string): void {
  const appPath = getAppBundlePath()
  if (!appPath) return

  const srcBundle = getIconBundlePath(icon)
  const destBundle = join(appPath, 'Contents', 'Resources', 'AppIcon.icon')

  debugLog(`setAppBundleIconBundle: icon=${icon} src=${srcBundle} dest=${destBundle}`)

  if (!fs.existsSync(srcBundle)) {
    debugLog(`  source bundle not found: ${srcBundle}`)
    return
  }

  try {
    // Remove old bundle and copy new one
    if (fs.existsSync(destBundle)) {
      fs.rmSync(destBundle, { recursive: true, force: true })
    }
    copyDirSync(srcBundle, destBundle)
    debugLog(`  copied .icon bundle`)

    // Bust macOS Dock icon cache: touch the .app to update mtime,
    // then force Launch Services to re-read app metadata.
    const now = new Date()
    fs.utimesSync(appPath, now, now)

    const lsregister =
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
    if (fs.existsSync(lsregister)) {
      try {
        execFileSync(lsregister, ['-f', appPath], { timeout: 5000 })
        debugLog(`  lsregister: refreshed`)
      } catch (lsErr) {
        debugLog(`  lsregister ERROR: ${lsErr}`)
      }
    }

    // Also clear any NSWorkspace custom icon that might override the bundle icon
    const clearScript = [
      `ObjC.import('AppKit')`,
      `$.NSWorkspace.sharedWorkspace.setIconForFileOptions(null, '${appPath}', 0)`
    ].join('; ')
    try {
      execFileSync('osascript', ['-l', 'JavaScript', '-e', clearScript], {
        encoding: 'utf-8',
        timeout: 5000
      })
      debugLog(`  cleared NSWorkspace custom icon`)
    } catch {
      // Not critical — the bundle icon takes precedence if no custom icon is set
    }
  } catch (err) {
    debugLog(`  ERROR: ${err}`)
  }
}

export function applyPersistedIcon(): void {
  if (process.platform !== 'darwin') return
  const savedIcon = preferencesManager.get('appIcon')
  debugLog(`applyPersistedIcon: savedIcon=${savedIcon}`)
  setAppBundleIconBundle(savedIcon)
}

export function registerAppHandlers(): void {
  // Trackpad tick (the sidebar's drop line moving to a new row). Fire-and-
  // forget: no reply, nothing to await, silent where unsupported.
  ipcMain.on('haptic:tick', (_event, pattern: unknown) => {
    const p: HapticPattern = pattern === 'generic' || pattern === 'level' ? pattern : 'alignment'
    hapticTick(p)
  })

  ipcMain.handle('app:get-username', () => {
    try {
      const info = os.userInfo()
      // Return the full name from the OS (macOS: dscl), falling back to login username
      if (process.platform === 'darwin') {
        try {
          const fullName = execFileSync('id', ['-F'], { encoding: 'utf-8', timeout: 2000 }).trim()
          if (fullName) return fullName
        } catch {
          /* fall through */
        }
      }
      return info.username
    } catch {
      return null
    }
  })

  ipcMain.handle('app:save-avatar', async (_event, sourcePath: string) => {
    try {
      const ext = sourcePath.split('.').pop() || 'png'
      const destDir = join(app.getPath('userData'), 'avatars')
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
      const destPath = join(destDir, `avatar.${ext}`)
      fs.copyFileSync(sourcePath, destPath)
      return destPath
    } catch {
      return null
    }
  })

  ipcMain.handle('app:set-icon', (event, icon: string) => {
    if (!VALID_ICONS.includes(icon as (typeof VALID_ICONS)[number])) return

    debugLog(`IPC app:set-icon: icon=${icon}`)

    preferencesManager.set('appIcon', icon as AppIcon)

    if (app.isPackaged && process.platform === 'darwin') {
      // Packaged macOS: copy .icon bundle for native Tahoe glass effect
      setAppBundleIconBundle(icon)
    } else {
      // Dev mode: use flat PNG (no .app bundle to modify)
      const iconPath = getIconPath(icon)
      const image = nativeImage.createFromPath(iconPath)
      if (image.isEmpty()) {
        debugLog(`  nativeImage is empty for ${iconPath}`)
        return
      }

      if (process.platform === 'darwin') {
        app.dock?.setIcon(image)
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        win.setIcon(image)
      }
    }
  })

  ipcMain.handle('app:get-version', () => {
    return app.getVersion()
  })
}
