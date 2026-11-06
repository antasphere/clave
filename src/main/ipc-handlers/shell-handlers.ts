import { ipcMain, shell, BrowserWindow } from 'electron'
import { openDialogs } from '../dialog-paths'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    // Only http(s)/mailto may be opened. Terminal output (incl. spoofed OSC-8
    // hyperlinks whose display text differs from the URI) and agent-rendered
    // markdown both reach this sink, so an unrestricted handler would let a
    // single click launch arbitrary URI-scheme handlers (file:, smb:, vscode:,
    // raycast:, …) with attacker-chosen payloads.
    try {
      const { protocol } = new URL(url)
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        return shell.openExternal(url)
      }
    } catch {
      // invalid URL — fall through to the block path
    }
    console.warn('[shell] blocked openExternal for disallowed URL:', url)
    return Promise.resolve()
  })

  ipcMain.handle('net:check-port', (_event, port: number) => {
    const tryConnect = (host: string): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = net.createConnection({ port, host, timeout: 2000 })
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => {
          socket.destroy()
          resolve(false)
        })
        socket.once('timeout', () => {
          socket.destroy()
          resolve(false)
        })
      })

    // Try IPv4 first, then IPv6 — covers servers bound to 127.0.0.1, ::1, or 0.0.0.0
    return tryConnect('127.0.0.1').then((ok) => (ok ? true : tryConnect('::1')))
  })

  // HTTP liveness probe for toolbar server buttons. Stricter than net:check-port:
  // a TCP connect proves only that something *bound* the port, while any HTTP
  // response (any status code) proves a server is actually answering. Known
  // residual, by design: an unrelated process answering on the declared port
  // passes the probe (port hijack) — we do not engineer around it.
  ipcMain.handle('net:probe-url', (_event, url: string, timeoutMs?: number): Promise<boolean> => {
    return new Promise((resolve) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        resolve(false)
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        resolve(false)
        return
      }
      const timeout = timeoutMs ?? 500
      const mod = parsed.protocol === 'https:' ? https : http
      const req = mod.get(url, { timeout, rejectUnauthorized: false }, (res) => {
        // Headers received — the server is up. Status code irrelevant.
        res.destroy()
        resolve(true)
      })
      req.once('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.once('error', () => {
        resolve(false)
      })
    })
  })

  ipcMain.handle('shell:openPath', (_event, filePath: string) => {
    return shell.openPath(filePath)
  })

  ipcMain.handle('dialog:openFolder', async (_event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    const result = await openDialogs.open('folder', win ?? undefined, {
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
