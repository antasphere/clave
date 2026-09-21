import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PluginStore, pluginFile } from '../plugins/plugin-store'
import { windowRegistry } from '../window-registry'
import { SessionInputSchema } from '../../shared/session-model'
import { PluginHost } from '../plugins/plugin-host'
import { sessionManager } from '../sessions/session-manager'
import { listPluginSessions, pluginSessionById } from '../sessions/plugin-sessions'
import { syncPluginAdapters } from '../sessions/plugin-adapters'
import { registerPreviewFile, unregisterPreviewFile } from '../preview-protocol'
import { TEST_NO_ACTIVATE } from '../test-mode'
import type { PluginPermission } from '@clave/plugin-sdk'

export function registerPluginHandlers(): void {
  const root = TEST_NO_ACTIVATE
    ? join(app.getPath('userData'), 'clave-plugins')
    : join(homedir(), '.clave')
  const bundled = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'plugins')
  let store: PluginStore
  let initializationError: string | undefined
  try {
    store = new PluginStore(root, bundled, app.getVersion())
    store.discover()
    syncPluginAdapters(store)
  } catch (error) {
    initializationError = `Plugin registry could not be read: ${String(error)}`
    console.error(initializationError)
  }
  const broadcast = (): void => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send('plugins:changed')
  }
  const surfaces = new Map<string, string>()
  /** Which session the user is looking at. Only a renderer knows this — focus is a
   *  renderer-store fact — so each window reports its own, and the most recent report
   *  wins: the host is one per application, and the last window to move focus is the
   *  window the user is in.
   *
   *  A window that goes away has its report cleared HERE, on the window's own `closed`
   *  event. The renderer's unmount does clear it on an ordinary teardown, but a renderer
   *  destroyed with its window never runs that cleanup and could not reach us afterwards
   *  anyway (`guard` throws for a destroyed window) — so every plugin holding
   *  `sessions.read` would have gone on being told a closed window's session was the
   *  focused one, and the id still resolves, because sessions outlive their window. */
  let focused: { windowId: number; sessionId: string } | null = null
  const watchedWindows = new Set<number>()
  /** A plugin view's authority over ONE session, held by the pane that opened
   *  it. The guest page never sees any of this: it talks to the app renderer
   *  over postMessage, the renderer names the lease, and main answers from what
   *  the lease says — so a guest can neither name another session nor outlive
   *  the pane, whatever its page does. */
  const viewLeases = new Map<
    string,
    {
      pluginId: string
      viewId: string
      sessionId: string
      windowId: number
      file: string
      stop: () => void
    }
  >()
  const revokeLease = (leaseId: string): void => {
    const lease = viewLeases.get(leaseId)
    if (!lease) return
    lease.stop()
    viewLeases.delete(leaseId)
    // The page stops being servable with the authority that opened it: a
    // revoked lease must not leave its token answering. The token is per FILE
    // and shared (`registerPreviewFile` is idempotent), so it goes only when
    // nothing else is still showing that page — another lease of the same
    // plugin, or its panel surface.
    const stillShown =
      [...viewLeases.values()].some((other) => other.file === lease.file) ||
      surfaces.get(lease.pluginId) === lease.file
    if (!stillShown) unregisterPreviewFile(lease.file)
  }
  const revokeLeasesOf = (pluginId: string): void => {
    for (const [id, lease] of viewLeases) if (lease.pluginId === pluginId) revokeLease(id)
  }
  const secretRequests = new Map<
    string,
    {
      pluginId: string
      windowId: number
      resolve: (value: string | null) => void
      timer: NodeJS.Timeout
      title: string
      description?: string
    }
  >()
  const clearSecrets = (id: string): void => {
    for (const [key, request] of secretRequests)
      if (request.pluginId === id) {
        clearTimeout(request.timer)
        secretRequests.delete(key)
        request.resolve(null)
      }
  }
  const host = !initializationError
    ? new PluginHost(store!, {
        sessions: {
          // The whole service reads the session registry, not the PTY manager:
          // one row per live session whatever its transport, `alive` from the
          // record's own state, and focus resolved the same way — so `list` and
          // `focused` can never disagree about a chat session.
          list: listPluginSessions,
          focused: () => (focused ? pluginSessionById(focused.sessionId) : null),
          send: (id, text) => {
            const session = sessionManager.get(id)
            if (!session || session.state === 'ended') throw new Error('Session is not running')
            // A granted sessions.write must reach a chat session too, not only a terminal.
            sessionManager.write(
              id,
              session.transport === 'events'
                ? { type: 'user_message', text }
                : new TextEncoder().encode(text)
            )
          }
        },
        // A linked plugin edited on disk re-discovers through the host's own
        // watcher, which never passes through the handlers below.
        changed: () => {
          syncPluginAdapters(store)
          broadcast()
        },
        stopped: (id) => {
          const file = surfaces.get(id)
          if (file) unregisterPreviewFile(file)
          surfaces.delete(id)
          // A stopped plugin keeps no authority over a session: its panes go
          // blank on the next render, and their leases answer nothing before.
          revokeLeasesOf(id)
          clearSecrets(id)
        },
        notify: (id, title, body) => {
          if (!TEST_NO_ACTIVATE && Notification.isSupported())
            new Notification({
              title: `${store.get(id).manifest?.name}: ${title}`,
              body: body ?? ''
            }).show()
        },
        requestSecret: (pluginId, title, description) => {
          if ([...secretRequests.values()].some((r) => r.pluginId === pluginId))
            return Promise.reject(new Error('A secret request is already pending'))
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          if (!win) return Promise.resolve(null)
          return new Promise((resolve) => {
            const id = randomUUID()
            const timer = setTimeout(() => {
              secretRequests.delete(id)
              resolve(null)
              broadcast()
            }, 120_000)
            secretRequests.set(id, {
              pluginId,
              windowId: win.id,
              resolve,
              timer,
              title,
              description
            })
            broadcast()
          })
        }
      })
    : undefined
  // Only the app's top-level renderer may invoke management IPC, never a guest.
  const guard = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Plugin management requires the app renderer')
    if (initializationError) throw new Error(initializationError)
    return win
  }
  ipcMain.handle('plugins:list', (event) => {
    guard(event)
    return store.list()
  })
  ipcMain.handle('plugins:enable', (event, id: string, grants: PluginPermission[]) => {
    guard(event)
    if (!Array.isArray(grants)) throw new Error('Permission grants are required')
    store.enable(id, grants)
    syncPluginAdapters(store)
    host!.start(id)
    broadcast()
  })
  ipcMain.handle('plugins:disable', (event, id: string) => {
    guard(event)
    store.disable(id)
    syncPluginAdapters(store)
    host!.stop(id)
    broadcast()
  })
  ipcMain.handle('plugins:link', async (event, folder?: string) => {
    const win = guard(event)
    const selected =
      folder ??
      (
        await dialog.showOpenDialog(win, {
          properties: ['openDirectory'],
          title: 'Link Clave plugin folder'
        })
      ).filePaths[0]
    if (!selected) return null
    const id = store.link(selected)
    host!.reload()
    syncPluginAdapters(store)
    return id
  })
  ipcMain.handle('plugins:remove', (event, id: string) => {
    guard(event)
    if (store.get(id).source === 'bundled')
      throw new Error('Bundled plugins can be disabled, not removed')
    host!.stop(id)
    store.remove(id)
    syncPluginAdapters(store)
    broadcast()
  })
  ipcMain.handle('plugins:command', (event, id: string, command: string) => {
    guard(event)
    return host!.execute(id, command)
  })
  ipcMain.handle('plugins:panel', (event, id: string, panel: string) => {
    guard(event)
    const record = store.get(id)
    if (
      !record.enabled ||
      record.status !== 'active' ||
      !record.panels.includes(panel) ||
      record.manifest?.ui !== 'surface' ||
      !record.manifest.uiEntry
    )
      throw new Error('Panel is not active')
    const file = pluginFile(record.directory, record.manifest.uiEntry)
    surfaces.set(id, file)
    const net = record.permissionsGranted.includes('net') ? 'https: http:' : ''
    return registerPreviewFile(
      file,
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${net}; connect-src 'self' ${net}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
    )
  })
  // The renderer reports its focused session whenever it changes; the host turns that
  // into the plugins' `context.changed`. Null clears this window's report.
  ipcMain.handle('plugins:context', (event, sessionId: string | null) => {
    const win = guard(event)
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256))
      throw new Error('Invalid session id')
    if (sessionId === null) {
      if (focused?.windowId === win.id) focused = null
    } else focused = { windowId: win.id, sessionId }
    // One listener per reporting window, attached where we first hear from it: this file
    // is registered once at startup and windows arrive later.
    if (!watchedWindows.has(win.id)) {
      const id = win.id
      watchedWindows.add(id)
      win.once('closed', () => {
        watchedWindows.delete(id)
        if (focused?.windowId === id) {
          focused = null
          host?.contextChanged()
        }
      })
    }
    host?.contextChanged()
  })
  /** Open a plugin's view on ONE session: check the plugin, the contribution
   *  and the grant, then hand back a URL and a lease id. The session id is
   *  fixed here and never travels again — every later call names the lease. */
  ipcMain.handle(
    'plugins:view-lease',
    (event, pluginId: string, viewId: string, sessionId: string) => {
      const win = guard(event)
      const record = store.get(pluginId)
      const manifest = record.manifest
      if (
        !record.enabled ||
        record.status !== 'active' ||
        record.error ||
        manifest?.ui !== 'surface' ||
        !manifest.uiEntry
      )
        throw new Error('View is not active')
      const view = manifest.contributes.views.find((entry) => entry.id === viewId)
      if (!view) throw new Error('Undeclared view')
      if (!record.permissionsGranted.includes('sessions.read'))
        throw new Error('Plugin may not read sessions')
      const session = sessionManager.get(sessionId)
      const windowKey = windowRegistry.getKeyForWindow(win.id)
      if (!session || !windowKey || session.windowKey !== windowKey)
        throw new Error('Session belongs to another window')
      if (!view.renders.includes(session.transport))
        throw new Error('View does not render this transport')
      const file = pluginFile(record.directory, manifest.uiEntry)
      const net = record.permissionsGranted.includes('net') ? 'https: http:' : ''
      const { url } = registerPreviewFile(
        file,
        `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${net}; connect-src 'self' ${net}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
      )
      const leaseId = randomUUID()
      // The events reach the app renderer, which relays them into the frame:
      // the guest has no channel of its own to main, by design.
      const stop = sessionManager.subscribe(
        sessionId,
        (stream) => {
          if (stream.kind !== 'event') return
          if (!win.isDestroyed())
            win.webContents.send(`plugins:view-event:${leaseId}`, stream.event)
        },
        windowKey
      )
      // A renderer that reloads or dies cannot revoke what it no longer
      // remembers, so main drops the lease itself. Without this a reload leaves
      // authority over a session behind, held by nobody and revoked by nothing.
      const drop = (): void => revokeLease(leaseId)
      // `did-navigate` is the MAIN frame's, never a guest iframe's (that is
      // `did-frame-navigate`), so a reload of the app drops the lease while the
      // plugin page loading inside it does not.
      win.webContents.on('did-navigate', drop)
      win.webContents.once('destroyed', drop)
      viewLeases.set(leaseId, {
        pluginId,
        viewId,
        sessionId,
        windowId: win.id,
        file,
        stop: () => {
          stop()
          if (!win.isDestroyed()) {
            win.webContents.off('did-navigate', drop)
            win.webContents.off('destroyed', drop)
          }
        }
      })
      sessionManager.ready(sessionId)
      return { leaseId, url, sessionId }
    }
  )
  /** One call from a plugin view, relayed by the pane that holds its lease. The
   *  grants are read HERE, not at the lease's birth: a permission taken away
   *  stops the next write, not only the next pane. */
  ipcMain.handle('plugins:view-request', (event, leaseId: string, method: string, params) => {
    const win = guard(event)
    const lease = viewLeases.get(leaseId)
    if (!lease || lease.windowId !== win.id) throw new Error('Unknown view lease')
    const record = store.get(lease.pluginId)
    if (!record.enabled || record.status !== 'active' || record.error)
      throw new Error('View is not active')
    const session = sessionManager.get(lease.sessionId)
    if (!session) throw new Error('Unknown session')
    if (method === 'session.get') {
      if (!record.permissionsGranted.includes('sessions.read'))
        throw new Error('Plugin may not read sessions')
      return session
    }
    if (method === 'session.write') {
      if (!record.permissionsGranted.includes('sessions.write'))
        throw new Error('Plugin may not write sessions')
      // The lease's session, never one the guest named: `params` carries the
      // input and nothing else that could select a target.
      sessionManager.write(lease.sessionId, SessionInputSchema.parse(params))
      return null
    }
    throw new Error(`Unknown plugin view method: ${method}`)
  })
  ipcMain.handle('plugins:view-revoke', (event, leaseId: string) => {
    const win = guard(event)
    const lease = viewLeases.get(leaseId)
    if (lease && lease.windowId === win.id) revokeLease(leaseId)
  })
  ipcMain.handle('plugins:secrets', (event) => {
    const win = guard(event)
    return [...secretRequests]
      .filter(([, r]) => r.windowId === win.id)
      .map(([id, { pluginId, title, description }]) => ({ id, pluginId, title, description }))
  })
  ipcMain.handle('plugins:secret-reply', (event, id: string, value: string | null) => {
    const win = guard(event)
    const request = secretRequests.get(id)
    if (!request || request.windowId !== win.id) throw new Error('Unknown secret request')
    if (value !== null && (typeof value !== 'string' || value.length > 64_000))
      throw new Error('Invalid secret')
    clearTimeout(request.timer)
    secretRequests.delete(id)
    request.resolve(value)
    broadcast()
  })
  host?.startAll()
  app.once('before-quit', () => host?.close())
}
