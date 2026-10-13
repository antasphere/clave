/**
 * The app icon: the one setting whose write needs Electron (the Dock tile,
 * the window icon, the `.icon` bundle of a packaged app). The helpers were
 * `ipc-handlers/app-handlers.ts`'s and moved here unchanged so the shell's
 * settings source (`settings/shell-source.ts`) and the IPC route paint the
 * same way; the preference itself is written by the settings source.
 */
import { app, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { preferencesManager, type AppIcon } from './preferences-manager'

export const VALID_ICONS = ['dark', 'light', 'claude'] as const

export const isAppIcon = (icon: unknown): icon is AppIcon =>
  VALID_ICONS.includes(icon as (typeof VALID_ICONS)[number])

// Resolved at the first write, not at import: this module is reached from
// the settings source, which a unit test loads without an Electron app.
const logPath = (): string => join(app.getPath('userData'), 'icon-debug.log')

function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.appendFileSync(logPath(), line)
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

/** Paint `icon` on the Dock and on every window (the packaged app's bundle
 *  too). The preference is the caller's to write. The body is the former
 *  `app:set-icon` handler's, with the window icon set on every window
 *  rather than the asking one, since a call through the server names none. */
export function applyAppIcon(icon: AppIcon): void {
  debugLog(`applyAppIcon: icon=${icon}`)

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

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setIcon(image)
    }
  }
}
