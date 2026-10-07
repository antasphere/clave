import { ipcMain, app } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { hapticTick, type HapticPattern } from '../haptic-manager'
import { isAppIcon } from '../app-icon'
import { shellSettingsSource as settings } from '../settings/shell-source'

// The icon helpers live in `../app-icon` now; the boot still imports this name from here.
export { applyPersistedIcon } from '../app-icon'

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

  // The app icon is a setting: the same source the server writes it through
  // (`settings/shell-source.ts`) stores the preference and paints the Dock.
  ipcMain.handle('app:set-icon', async (_event, icon: unknown) => {
    if (!isAppIcon(icon)) return
    await settings.preferences.setAppIcon(icon)
  })

  ipcMain.handle('app:get-version', () => {
    return app.getVersion()
  })
}
