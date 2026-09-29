import { ipcMain } from 'electron'
import { locationManager } from '../location-manager'
import { sshManager } from '../ssh-manager'
import { openclawClient } from '../openclaw-client'
import type { Location } from '../../shared/remote-types'

export function registerLocationHandlers(): void {
  ipcMain.handle('location:list', () => locationManager.getLocations())

  ipcMain.handle(
    'location:add',
    (_event, loc: Omit<Location, 'id' | 'status'>, password?: string) => {
      return locationManager.addLocation(loc, password)
    }
  )

  ipcMain.handle('location:update', (_event, id: string, updates: Partial<Location>) => {
    return locationManager.updateLocation(id, updates)
  })

  ipcMain.handle('location:remove', (_event, id: string) => {
    sshManager.disconnect(id)
    openclawClient.disconnect(id)
    locationManager.removeLocation(id)
  })

  ipcMain.handle('location:test-connection', async (_event, id: string) => {
    const config = locationManager.getCredentials(id)
    if (!config) return { success: false, error: 'No credentials found' }
    try {
      await sshManager.connect(id, config)
      // Check for OpenClaw (use login shell to get full PATH with npm globals, homebrew, etc.)
      let openclawVersion: string | undefined
      let openclawPort: number | undefined
      let openclawToken: string | undefined
      try {
        const result = await sshManager.exec(
          id,
          'bash -lc "openclaw --version" 2>/dev/null || echo ""'
        )
        if (result.stdout.trim()) {
          openclawVersion = result.stdout.trim()
          // Read gateway port and auth token from config
          const cfgResult = await sshManager.exec(
            id,
            'cat ~/.openclaw/openclaw.json 2>/dev/null || echo "{}"'
          )
          try {
            const cfg = JSON.parse(cfgResult.stdout)
            openclawPort = cfg.gateway?.port || 18789
            openclawToken = cfg.gateway?.auth?.token
          } catch {
            openclawPort = 18789
          }
        }
      } catch {
        /* no openclaw */
      }
      sshManager.disconnect(id)
      return { success: true, openclawVersion, openclawPort, openclawToken }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('location:install-plugin', async (_event, id: string) => {
    try {
      // Reconnect SSH — test-connection disconnects after testing
      if (!sshManager.isConnected(id)) {
        const config = locationManager.getCredentials(id)
        if (!config) return { success: false, error: 'No credentials found' }
        await sshManager.connect(id, config)
      }
      // Use login shell to ensure npm/node are in PATH
      const result = await sshManager.exec(
        id,
        'bash -lc "npm install -g @codika-io/clave-channel && clave-channel install"'
      )
      sshManager.disconnect(id)
      return { success: result.code === 0, output: result.stdout + result.stderr }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
