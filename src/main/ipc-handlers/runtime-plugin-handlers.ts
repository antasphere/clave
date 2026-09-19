import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session as electronSession,
  type IpcMainInvokeEvent
} from 'electron'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import {
  RUNTIME_PLUGIN_ID_PATTERN,
  type PluginViewDescriptor,
  type PluginViewEntry
} from '../../shared/runtime-plugins'
import {
  conversationClient,
  ensureConversationPlugins,
  sendConversation
} from '../conversations/runtime'
import { runtimePluginRegistry } from '../runtime-plugins/registry-runtime'
import { readWorkspaceFile, RuntimePluginViews } from '../runtime-plugins/views'
import { installPluginProtocol } from '../runtime-plugins/protocol'
import { setRuntimePluginViewHost } from '../runtime-plugins/host'
import { getLoginShellEnv } from '../pty-manager'
import { callRenderer } from '../mcp/mcp-bridge'
import { windowRegistry } from '../window-registry'

function hostWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (
    !win ||
    event.senderFrame !== event.sender.mainFrame ||
    !windowRegistry.getKeyForWindow(win.id)
  ) {
    throw new Error('Runtime plugin operations require the trusted Clave host')
  }
  return win
}

function pluginId(value: unknown): string {
  if (typeof value !== 'string' || !RUNTIME_PLUGIN_ID_PATTERN.test(value))
    throw new Error('Invalid plugin ID')
  return value
}

function sessionOwner(sessionId: string): BrowserWindow {
  const win = windowRegistry.getWindowForSession(sessionId)
  if (!win || win.isDestroyed()) throw new Error('Open this conversation in Clave first')
  return win
}

async function requireHome(win: BrowserWindow, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !/^conversation-[a-f0-9-]{36}$/i.test(id))
    throw new Error('Invalid conversation ID')
  if (windowRegistry.getWindowForSession(id)?.id !== win.id) {
    const { session } = await (await conversationClient()).snapshot(id)
    if (session.windowKey !== windowRegistry.getKeyForWindow(win.id))
      throw new Error('Conversation belongs to another window')
    windowRegistry.bindSession(id, win.id)
  }
  return id
}

function jobEnvironment(): Record<string, string> {
  const login = getLoginShellEnv()
  const env: Record<string, string> = {}
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG'
  ]) {
    if (login[key]) env[key] = login[key]
  }
  return env
}

function refusePrivateAppData(path: string): void {
  const inside = relative(realpathSync(app.getPath('userData')), path)
  if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new Error('Private Clave profile files are not available to plugin views')
  }
}

export function registerRuntimePluginHandlers(): void {
  const registry = runtimePluginRegistry()
  const changed = (): void => {
    for (const win of windowRegistry.listWindows()) win.webContents.send('runtime-plugins:changed')
  }
  const candidates = async (
    sessionId: string,
    entry: PluginViewEntry
  ): Promise<PluginViewDescriptor[]> => {
    const snapshot = await ensureConversationPlugins(sessionId)
    const pins = [...snapshot.session.pluginBindings!.views]
    for (const installed of registry.list()) {
      if (
        !installed.enabled ||
        !installed.manifest.views.length ||
        pins.some((pin) => pin.pluginId === installed.manifest.id)
      )
        continue
      pins.push({
        pluginId: installed.manifest.id,
        version: installed.manifest.version,
        revision: installed.revision
      })
    }
    return registry.viewsFor(pins, entry)
  }
  const views = new RuntimePluginViews({
    snapshot: async (id) => (await conversationClient()).snapshot(id),
    cwd: async (id) => (await (await conversationClient()).snapshot(id)).session.cwd,
    readFile: async (path) => {
      refusePrivateAppData(path)
      return readWorkspaceFile(dirname(path), basename(path))
    },
    isAvailable: (pin) => registry.isEnabled(pin.pluginId),
    resolveView: async (id, entry, requested) => {
      // The client may choose a descriptor but cannot supply its permissions,
      // entrypoint, label, or revision. Re-resolve it from the registry.
      const view = (await candidates(id, entry)).find(
        (item) =>
          item.id === requested.id &&
          item.plugin.pluginId === requested.plugin.pluginId &&
          item.plugin.revision === requested.plugin.revision
      )
      if (!view) throw new Error('View plugin is unavailable for this entry')
      await (await conversationClient()).pinView(id, view.plugin)
      return { descriptor: view, html: registry.readView(view.plugin, view.id) }
    },
    confirm: async (ownerId, method, params, scope) => {
      const win = windowRegistry
        .listWindows()
        .find((candidate) => candidate.webContents.id === ownerId)
      if (!win || win.isDestroyed()) return false
      if (sessionOwner(scope.sessionId).webContents.id !== ownerId) return false
      const snapshot = await (await conversationClient()).snapshot(scope.sessionId)
      const answer = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Plugin action',
        message:
          method === 'workspace.execute'
            ? 'Allow this plugin to run a workspace command?'
            : 'Allow this plugin to send a message?',
        detail: `${scope.plugin.pluginId} · ${scope.plugin.version}\n${snapshot.session.cwd}\n\n${JSON.stringify(params, null, 2)}`,
        buttons: ['Cancel', 'Allow'],
        defaultId: 0,
        cancelId: 0
      })
      return answer.response === 1
    },
    executeJob: async (scope, argv, requestId) =>
      (await conversationClient()).executePluginJob(
        scope.sessionId,
        scope.plugin,
        argv,
        requestId,
        jobEnvironment()
      ),
    readJob: async (scope, id) =>
      (await conversationClient()).readPluginJob(scope.sessionId, scope.plugin, id),
    cancelJob: async (scope, id) =>
      (await conversationClient()).cancelPluginJob(scope.sessionId, scope.plugin, id),
    setDraft: async (id, text) =>
      callRenderer('pluginSetDraft', { sessionId: id, text }, sessionOwner(id)),
    send: async (scope, text, requestId) => {
      const key = createHash('sha256')
        .update(JSON.stringify([scope, requestId]))
        .digest('hex')
      await sendConversation(scope.sessionId, text, `rpc-${key}`)
    },
    openFile: async (id, path) => {
      refusePrivateAppData(path)
      return callRenderer('pluginOpenFile', { sessionId: id, path }, sessionOwner(id))
    },
    openArtifact: async (id, entryId) =>
      callRenderer('pluginOpenArtifact', { sessionId: id, entryId }, sessionOwner(id))
  })
  setRuntimePluginViewHost(views)
  installPluginProtocol(electronSession.defaultSession.protocol, views)

  ipcMain.handle('runtime-plugins:list', (event) => {
    hostWindow(event)
    return registry.list()
  })
  ipcMain.handle('runtime-plugins:providers', (event) => {
    hostWindow(event)
    return registry.providers()
  })
  const confirmInstall = async (
    win: BrowserWindow,
    prepared: ReturnType<typeof registry.inspectFolder>,
    update: boolean
  ): Promise<boolean> => {
    const manifest = prepared.manifest
    const capabilities = [...new Set(manifest.views.flatMap((view) => view.capabilities))]
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Trust internal plugin',
      message: `${update ? 'Update' : 'Install'} ${manifest.name}?`,
      detail: [
        `${manifest.id} · ${manifest.version}`,
        manifest.provider
          ? 'This provider runs trusted native code with your account’s filesystem and process privileges. It is not sandboxed.'
          : 'This plugin adds isolated HTML views.',
        `View capabilities: ${capabilities.join(', ') || 'none'}`,
        'Only install code you trust. Existing sessions keep their pinned versions.'
      ].join('\n\n'),
      buttons: ['Cancel', update ? 'Update plugin' : 'Install plugin'],
      defaultId: 0,
      cancelId: 0
    })
    return answer.response === 1
  }
  ipcMain.handle('runtime-plugins:install', async (event) => {
    const win = hostWindow(event)
    const selected = await dialog.showOpenDialog(win, {
      title: 'Install a local runtime plugin',
      properties: ['openDirectory']
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    const prepared = registry.inspectFolder(selected.filePaths[0])
    if (!(await confirmInstall(win, prepared, false))) return null
    const installed = registry.installPrepared(prepared)
    changed()
    return installed
  })
  ipcMain.handle('runtime-plugins:update', async (event, id: unknown) => {
    const win = hostWindow(event)
    const prepared = registry.prepareUpdate(pluginId(id))
    if (!(await confirmInstall(win, prepared, true))) throw new Error('Plugin update cancelled')
    const installed = registry.installPrepared(prepared)
    changed()
    return installed
  })
  ipcMain.handle('runtime-plugins:set-enabled', (event, id: unknown, enabled: unknown) => {
    hostWindow(event)
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled state')
    registry.setEnabled(pluginId(id), enabled)
    changed()
  })
  ipcMain.handle('runtime-plugins:views', async (event, sessionId: unknown, entryId: unknown) => {
    const id = await requireHome(hostWindow(event), sessionId)
    if (typeof entryId !== 'string') throw new Error('Invalid entry ID')
    const { entries } = await (await conversationClient()).snapshot(id)
    const entry = entries.find((item) => item.id === entryId)
    if (!entry || entry.kind === 'message') return []
    return candidates(id, entry)
  })
  ipcMain.handle(
    'runtime-plugins:open-view',
    async (event, sessionId: unknown, entryId: unknown, view?: PluginViewDescriptor) => {
      const id = await requireHome(hostWindow(event), sessionId)
      if (typeof entryId !== 'string' || entryId.length > 512) throw new Error('Invalid entry ID')
      return views.open(event.sender.id, id, entryId, view)
    }
  )
  ipcMain.handle('runtime-plugins:close-view', (event, leaseId: string) => {
    hostWindow(event)
    return views.close(event.sender.id, leaseId)
  })
  ipcMain.handle('runtime-plugins:request', (event, leaseId: string, request: unknown) => {
    hostWindow(event)
    return views.request(event.sender.id, leaseId, request)
  })
  app.once('before-quit', () => {
    for (const win of windowRegistry.listWindows()) views.revokeOwner(win.webContents.id)
  })
}
