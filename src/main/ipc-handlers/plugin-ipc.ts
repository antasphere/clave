/**
 * The IPC arms of the plugins domain (PRDCT-3433), and what stays the shell's
 * whichever process runs the plugins. The store, the host, the view leases and
 * the secret requests live in the plugin service beside the server's sessions
 * (`plugins/plugin-service.ts`): inside the app it is the shell's own instance
 * (`plugins/shell-plugins.ts`, also the server's `ports.plugins`); attached to
 * a server running apart, it is that server's, reached through the typed
 * client. Every arm below answers from whichever the boot named
 * (`pluginsFacade`), so a window that calls over IPC before the preload has
 * routed to the server gets the same answer as one that calls the server.
 *
 * What is Electron's and nothing else's: the folder dialog of "Link
 * folder…", the preview protocol that mints a plugin page's URL (the service
 * answers the file and its policy; `plugins:preview-url` is reached only
 * through the preload, after the server named the file), the OS notification
 * a plugin raises on a server that cannot show one, the window a focus report
 * comes from (its key, and the clearing of its report when it closes), and
 * the drop of a lease when the window that holds it reloads or dies.
 */
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import type { ClaveApiClient } from '@clave/client'
import type {
  PluginPage,
  PluginPermission,
  PluginSecretRequest,
  PluginViewLease
} from '@clave/contract/plugins'
import { windowRegistry } from '../window-registry'
import { registerPreviewFile } from '../preview-protocol'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { getClaveServerEndpoint, whenClaveServerBootSettled } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'
import { shellPlugins } from '../plugins/shell-plugins'

/** The plugins as the arms call them: every method a promise, whether the
 *  service is in this process or across the loopback. */
export interface PluginsFacade {
  list(): Promise<ReadonlyArray<unknown>>
  enable(id: string, grants: ReadonlyArray<PluginPermission>): Promise<void>
  disable(id: string): Promise<void>
  link(folder: string): Promise<string>
  remove(id: string): Promise<void>
  command(id: string, command: string): Promise<void>
  panel(pluginId: string, panelId: string): Promise<PluginPage>
  context(windowKey: string, sessionId: string | null): Promise<void>
  leaseView(pluginId: string, viewId: string, sessionId: string): Promise<PluginViewLease>
  requestView(leaseId: string, method: string, params: unknown): Promise<unknown>
  revokeView(leaseId: string): Promise<void>
  secrets(): Promise<ReadonlyArray<PluginSecretRequest>>
  replySecret(id: string, value: string | null): Promise<void>
}

const inProcessFacade = (): PluginsFacade => {
  const service = shellPlugins()
  return {
    list: async () => service.list(),
    enable: async (id, grants) => service.enable(id, grants),
    disable: async (id) => service.disable(id),
    link: async (folder) => service.link(folder),
    remove: async (id) => service.remove(id),
    command: (id, command) => service.command(id, command),
    panel: async (pluginId, panelId) => service.panel(pluginId, panelId),
    context: async (windowKey, sessionId) => service.context(windowKey, sessionId),
    leaseView: async (pluginId, viewId, sessionId) =>
      service.leaseView(pluginId, viewId, sessionId),
    requestView: async (leaseId, method, params) => service.requestView(leaseId, method, params),
    revokeView: async (leaseId) => service.revokeView(leaseId),
    secrets: async () => service.secrets(),
    replySecret: async (id, value) => service.replySecret(id, value)
  }
}

const attachedFacade = (api: ClaveApiClient): PluginsFacade => ({
  list: () => api.plugins.list(),
  enable: (id, grants) => api.plugins.enable(id, grants),
  disable: (id) => api.plugins.disable(id),
  link: (folder) => api.plugins.link(folder),
  remove: (id) => api.plugins.remove(id),
  command: (id, command) => api.plugins.command(id, command),
  panel: (pluginId, panelId) => api.plugins.panel(pluginId, panelId),
  context: (windowKey, sessionId) => api.plugins.context(windowKey, sessionId),
  leaseView: (pluginId, viewId, sessionId) => api.plugins.leaseView(pluginId, viewId, sessionId),
  requestView: (leaseId, method, params) => api.plugins.requestView(leaseId, method, params),
  revokeView: (leaseId) => api.plugins.revokeView(leaseId),
  secrets: () => api.plugins.secrets(),
  replySecret: (id, value) => api.plugins.replySecret(id, value)
})

/** The plugins the boot named: the shell's own service while the server runs
 *  in this process or there is none, the attached server's otherwise. Waits,
 *  boundedly, for the boot to decide, so an early window is answered rather
 *  than refused. */
export async function pluginsFacade(): Promise<PluginsFacade> {
  await whenClaveServerBootSettled()
  const endpoint = getClaveServerEndpoint()
  if (endpoint?.mode === 'attached') return attachedFacade(await serverClient.api())
  return inProcessFacade()
}

export function registerPluginHandlers(): void {
  // Only the app's top-level renderer may invoke management IPC, never a guest.
  const guard = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Plugin management requires the app renderer')
    return win
  }
  const keyOf = (win: BrowserWindow): string =>
    windowRegistry.getKeyForWindow(win.id) ?? `window-${win.id}`
  /** A closed window's focus report is cleared HERE, on the window's own
   *  `closed` event: a renderer destroyed with its window never runs its
   *  unmount, and every plugin holding `sessions.read` would go on being
   *  told that window's session was the focused one. */
  const watchedWindows = new Set<number>()
  const watchClose = (win: BrowserWindow): void => {
    if (watchedWindows.has(win.id)) return
    const id = win.id
    const key = keyOf(win)
    watchedWindows.add(id)
    win.once('closed', () => {
      watchedWindows.delete(id)
      void pluginsFacade()
        .then((plugins) => plugins.context(key, null))
        .catch(() => undefined)
    })
  }
  /** A renderer that reloads or dies cannot revoke what it no longer
   *  remembers, so main drops the lease itself. `did-navigate` is the MAIN
   *  frame's, never a guest iframe's, so a reload of the app drops the lease
   *  while the plugin page loading inside it does not. */
  const drops = new Map<string, () => void>()
  const dropOnReload = (win: BrowserWindow, leaseId: string): void => {
    const drop = (): void => {
      drops.get(leaseId)?.()
      void pluginsFacade()
        .then((plugins) => plugins.revokeView(leaseId))
        .catch(() => undefined)
    }
    win.webContents.on('did-navigate', drop)
    win.webContents.once('destroyed', drop)
    drops.set(leaseId, () => {
      drops.delete(leaseId)
      if (!win.isDestroyed()) {
        win.webContents.off('did-navigate', drop)
        win.webContents.off('destroyed', drop)
      }
    })
  }

  ipcMain.handle('plugins:list', async (event) => {
    guard(event)
    return (await pluginsFacade()).list()
  })
  ipcMain.handle('plugins:enable', async (event, id: string, grants: PluginPermission[]) => {
    guard(event)
    if (!Array.isArray(grants)) throw new Error('Permission grants are required')
    await (await pluginsFacade()).enable(id, grants)
  })
  ipcMain.handle('plugins:disable', async (event, id: string) => {
    guard(event)
    await (await pluginsFacade()).disable(id)
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
    return (await pluginsFacade()).link(selected)
  })
  ipcMain.handle('plugins:remove', async (event, id: string) => {
    guard(event)
    await (await pluginsFacade()).remove(id)
  })
  ipcMain.handle('plugins:command', async (event, id: string, command: string) => {
    guard(event)
    await (await pluginsFacade()).command(id, command)
  })
  ipcMain.handle('plugins:panel', async (event, id: string, panel: string) => {
    guard(event)
    const page = await (await pluginsFacade()).panel(id, panel)
    return registerPreviewFile(page.file, page.csp)
  })
  /** The URL of a page the server named: reached only through the preload,
   *  which passes what `GetPluginPanel` or `LeasePluginView` answered. */
  ipcMain.handle('plugins:preview-url', (event, file: string, csp: string) => {
    guard(event)
    if (typeof file !== 'string' || !file || typeof csp !== 'string')
      throw new Error('A plugin page needs a file and a policy')
    return registerPreviewFile(file, csp)
  })
  // The renderer reports its focused session whenever it changes; the host
  // turns that into the plugins' `context.changed`. Null clears this window's report.
  ipcMain.handle('plugins:context', async (event, sessionId: string | null) => {
    const win = guard(event)
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256))
      throw new Error('Invalid session id')
    watchClose(win)
    await (await pluginsFacade()).context(keyOf(win), sessionId)
  })
  ipcMain.handle(
    'plugins:view-lease',
    async (event, pluginId: string, viewId: string, sessionId: string) => {
      const win = guard(event)
      const lease = await (await pluginsFacade()).leaseView(pluginId, viewId, sessionId)
      const { url } = registerPreviewFile(lease.file, lease.csp)
      dropOnReload(win, lease.leaseId)
      return { leaseId: lease.leaseId, url, sessionId: lease.sessionId }
    }
  )
  ipcMain.handle('plugins:view-request', async (event, leaseId: string, method: string, params) => {
    guard(event)
    return (await pluginsFacade()).requestView(leaseId, method, params)
  })
  ipcMain.handle('plugins:view-revoke', async (event, leaseId: string) => {
    guard(event)
    drops.get(leaseId)?.()
    await (await pluginsFacade()).revokeView(leaseId)
  })
  ipcMain.handle('plugins:secrets', async (event) => {
    guard(event)
    return (await pluginsFacade()).secrets()
  })
  ipcMain.handle('plugins:secret-reply', async (event, id: string, value: string | null) => {
    guard(event)
    if (value !== null && (typeof value !== 'string' || value.length > 64_000))
      throw new Error('Invalid secret')
    await (await pluginsFacade()).replySecret(id, value)
  })
  /** A notification the attached server could not show itself
   *  (`plugins.notified`): the preload relays it here once per window; the
   *  first relay of an event shows it, the others are dropped by its id. */
  const shown = new Set<string>()
  ipcMain.handle(
    'plugins:show-notification',
    (event, id: string, name: string, title: string, body?: string) => {
      guard(event)
      if (typeof id !== 'string' || shown.has(id)) return
      shown.add(id)
      if (shown.size > 200) shown.delete(shown.values().next().value as string)
      if (!TEST_NO_ACTIVATE && Notification.isSupported())
        new Notification({ title: `${name}: ${title}`, body: body ?? '' }).show()
    }
  )
  app.once('before-quit', () => {
    for (const drop of [...drops.values()]) drop()
  })
}
