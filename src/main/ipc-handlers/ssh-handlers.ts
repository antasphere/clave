import { ipcMain } from 'electron'
import { sshManager } from '../ssh-manager'
import { locationManager } from '../location-manager'
import { BrowserWindow } from 'electron'
import { broadcastToAllWindows } from '../window-routing'

export function registerSshHandlers(): void {
  ipcMain.handle('ssh:connect', async (_event, locationId: string) => {
    const config = locationManager.getCredentials(locationId)
    if (!config) throw new Error('No credentials for location')
    await sshManager.connect(locationId, config)
    locationManager.setLocationStatus(locationId, 'connected')
  })

  ipcMain.handle('ssh:disconnect', (_event, locationId: string) => {
    sshManager.disconnect(locationId)
    locationManager.setLocationStatus(locationId, 'disconnected')
  })

  ipcMain.handle('ssh:exec', async (_event, locationId: string, command: string) => {
    return sshManager.exec(locationId, command)
  })

  ipcMain.handle('ssh:open-shell', async (event, locationId: string, cwd?: string) => {
    const { shellId, channel } = await sshManager.openShell(locationId, cwd)
    // A remote shell's data/exit belong to the ONE window that opened it: its
    // renderer holds the xterm. Bind the shell to that window (weakly — a
    // closed window just drops the writes, exactly as pty:data does).
    const openerId = BrowserWindow.fromWebContents(event.sender)?.id ?? null
    const opener = (): BrowserWindow | null => {
      if (openerId == null) return null
      const w = BrowserWindow.fromId(openerId)
      return w && !w.isDestroyed() ? w : null
    }

    // Forward shell data to renderer
    channel.on('data', (data: Buffer) => {
      opener()?.webContents.send(`ssh:shell-data:${shellId}`, data.toString('utf-8'))
    })

    channel.on('close', () => {
      opener()?.webContents.send(`ssh:shell-exit:${shellId}`, 0)
    })

    return shellId
  })

  ipcMain.on('ssh:shell-write', (_event, shellId: string, data: string) => {
    const channel = sshManager.getShell(shellId)
    channel?.write(data)
  })

  ipcMain.on('ssh:shell-resize', (_event, shellId: string, cols: number, rows: number) => {
    const channel = sshManager.getShell(shellId)
    channel?.setWindow(rows, cols, 0, 0)
  })

  ipcMain.handle('ssh:shell-close', (_event, shellId: string) => {
    sshManager.closeShell(shellId)
  })

  // SFTP handlers
  ipcMain.handle('sftp:read-dir', async (_event, locationId: string, dirPath: string) => {
    const sftp = await sshManager.getSftp(locationId)
    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err)
        resolve(
          list.map((item) => ({
            name: item.filename,
            path: dirPath === '/' ? `/${item.filename}` : `${dirPath}/${item.filename}`,
            type: item.attrs.isDirectory() ? ('directory' as const) : ('file' as const),
            size: item.attrs.size
          }))
        )
      })
    })
  })

  ipcMain.handle('sftp:read-file', async (_event, locationId: string, filePath: string) => {
    const sftp = await sshManager.getSftp(locationId)
    return new Promise<string>((resolve, reject) => {
      let data = ''
      const stream = sftp.createReadStream(filePath, { encoding: 'utf-8' })
      stream.on('data', (chunk: string) => {
        data += chunk
      })
      stream.on('end', () => resolve(data))
      stream.on('error', reject)
    })
  })

  ipcMain.handle('sftp:stat', async (_event, locationId: string, filePath: string) => {
    const sftp = await sshManager.getSftp(locationId)
    return new Promise((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) return reject(err)
        resolve({
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          size: stats.size,
          mtime: stats.mtime
        })
      })
    })
  })

  // SSH connection lifecycle — forward close/error to renderer
  // Connection lifecycle is location-level, not window-level: broadcast so
  // every window's location UI updates.
  sshManager.onClose((locationId) => {
    broadcastToAllWindows('ssh:connection-closed', locationId)
    locationManager.setLocationStatus(locationId, 'disconnected')
  })

  sshManager.onError((locationId) => {
    broadcastToAllWindows('ssh:connection-closed', locationId)
    locationManager.setLocationStatus(locationId, 'error')
  })
}
