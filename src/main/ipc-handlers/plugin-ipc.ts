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
 * folder…"; the preview protocol that mints a plugin page's URL (the service
 * answers the file and its policy, the arm registers the page and holds it
 * for the lease or the panel that shows it, and releases it when the lease
 * is revoked, when the window holding it reloads or dies, and when the plugin
 * is no longer active, so a revoked page stops answering); the OS
 * notification a plugin raises on a server that cannot show one; the window
 * a focus report comes from (its key, and the clearing of its report when it
 * closes); and the drop of a lease when the window that holds it reloads or
 * dies. The lease, the panel and the revoke therefore come through these arms
 * in both modes; the other methods the preload sends to the server itself.
 */
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import type { ClaveApiClient } from '@clave/client'
import type {
  PluginPage,
  PluginPermission,
  PluginRecord,
  PluginSecretRequest,
  PluginViewLease
} from '@clave/contract/plugins'
import { windowRegistry } from '../window-registry'
import { registerPreviewFile, unregisterPreviewFile } from '../preview-protocol'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { getClaveServerEndpoint, whenClaveServerBootSettled } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'
import { shellPlugins } from '../plugins/shell-plugins'

/** The plugins as the arms call them: every method a promise, whether the
 *  service is in this process or across the loopback. */
export interface PluginsFacade {
  list(): Promise<ReadonlyArray<PluginRecord>>
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

  /** The pages this shell serves to its windows: one holder per lease
   *  (`lease:<id>`) and per panel (`panel:<plugin>/<panel>`), with the file
   *  and the plugin behind it. The token is per FILE and shared
   *  (`registerPreviewFile` is idempotent), so a page stops being served only
   *  when nothing else still shows that file: another lease of the same
   *  plugin, or its panel. A page released and asked for again gets a new
   *  token, so the URL a revoked lease or a disabled plugin held answers 404. */
  const pages = new Map<string, { file: string; pluginId: string }>()
  const hold = (holder: string, pluginId: string, page: PluginPage): { url: string } => {
    pages.set(holder, { file: page.file, pluginId })
    return registerPreviewFile(page.file, page.csp)
  }
  const release = (holder: string): void => {
    const page = pages.get(holder)
    if (!page) return
    pages.delete(holder)
    for (const other of pages.values()) if (other.file === page.file) return
    unregisterPreviewFile(page.file)
  }
  /** A plugin that is no longer active keeps no page: the service dropped its
   *  leases already, and the window took its panel down. */
  const releaseStale = (records: ReadonlyArray<PluginRecord>): void => {
    const active = new Set(
      records.filter((r) => r.enabled && r.status === 'active' && !r.error).map((r) => r.id)
    )
    for (const [holder, page] of [...pages]) if (!active.has(page.pluginId)) release(holder)
  }
  const refreshPages = (): Promise<void> =>
    pages.size === 0
      ? Promise.resolve()
      : pluginsFacade()
          .then((plugins) => plugins.list())
          .then(releaseStale)
          .catch(() => undefined)
  // In this process the shell's own service says when the plugins changed;
  // attached, the windows relay the server's event (`plugins:changed-heard`).
  void whenClaveServerBootSettled().then(() => {
    if (getClaveServerEndpoint()?.mode === 'attached') return
    shellPlugins().subscribe((event) => {
      if (event._tag === 'plugins.changed') void refreshPages()
    })
  })

  /** A renderer that reloads or dies cannot revoke what it no longer
   *  remembers, so main drops the lease itself. `did-navigate` is the MAIN
   *  frame's, never a guest iframe's, so a reload of the app drops the lease
   *  while the plugin page loading inside it does not. */
  const drops = new Map<string, () => void>()
  const dropOnReload = (win: BrowserWindow, leaseId: string): void => {
    const drop = (): void => {
      drops.get(leaseId)?.()
      release(`lease:${leaseId}`)
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
    return hold(`panel:${id}/${panel}`, id, page)
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
      const { url } = hold(`lease:${lease.leaseId}`, pluginId, lease)
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
    release(`lease:${leaseId}`)
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
  /** The server's plugin events a window relays here when the server runs
   *  apart from the app, each acted on once whichever windows relayed it (the
   *  first relay of an event's id counts): a notification the server could
   *  not show itself, and a change of the plugins, on which the pages of a
   *  plugin no longer active are released. */
  const relayed = new Set<string>()
  const once = (id: unknown): boolean => {
    if (typeof id !== 'string' || relayed.has(id)) return false
    relayed.add(id)
    if (relayed.size > 200) relayed.delete(relayed.values().next().value as string)
    return true
  }
  ipcMain.handle(
    'plugins:show-notification',
    (event, id: string, name: string, title: string, body?: string) => {
      guard(event)
      if (!once(id)) return
      if (!TEST_NO_ACTIVATE && Notification.isSupported())
        new Notification({ title: `${name}: ${title}`, body: body ?? '' }).show()
    }
  )
  ipcMain.handle('plugins:changed-heard', async (event, id: string) => {
    guard(event)
    if (!once(id)) return
    await refreshPages()
  })
  app.once('before-quit', () => {
    for (const drop of [...drops.values()]) drop()
  })
}
