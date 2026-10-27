import { BrowserWindow, app, ipcMain } from 'electron'
import {
  IPC_SERVER_ENDPOINT,
  IPC_SERVER_ENDPOINT_NAMED,
  IPC_SERVER_EXTERNAL
} from '@clave/contract/env'
import {
  getClaveServerEndpoint,
  isServerExternal,
  onClaveServerEndpointNamed
} from '../server/endpoint'
import {
  FLEET_IPC,
  type SaveServerConnection,
  type ServerVersionStatus
} from '../../../packages/contract/src/fleet'
import { settingsPorts } from '../ports/registry'
import { ServerConnectionRegistry } from '../server-connections/registry'
import {
  createVersionSync,
  type ServerRead,
  type VersionSync
} from '../server-connections/version-sync'
import { TEST_NO_ACTIVATE, TEST_VERSION } from '../test-mode'

let shared: ServerConnectionRegistry | undefined
/** The saved server connections, one instance for main: the IPC below and
 *  the version sync resolve endpoints through it. Lazy: the boot may
 *  register IPC before safeStorage and userData are ready. */
export function serverConnectionRegistry(): ServerConnectionRegistry {
  return (shared ??= new ServerConnectionRegistry(settingsPorts()))
}

/** How long after the boot the first version read waits, so it never
 *  competes with the windows' own first connections. */
const FIRST_VERSION_READ_MS = 3_000

/** This app's version as the updater reports it (`runningVersion()` in
 *  `auto-updater.ts`: a spec's `--test-version` under test mode). */
const appVersion = (): string => TEST_VERSION ?? app.getVersion()

/** The version sync over the saved connections (issue #266): reads each
 *  enabled server through a client of main's own, never through a window. */
function mainVersionSync(connections: () => ServerConnectionRegistry): VersionSync {
  const withClient = async <T>(
    serverId: string,
    run: (api: import('../../../packages/client/src/api').ClaveApiClient) => Promise<T>
  ): Promise<T> => {
    const endpoint = connections().endpoint(serverId)
    const { createApiClient } = await import('../../../packages/client/src/api')
    const api = createApiClient(endpoint)
    try {
      return await run(api)
    } finally {
      await api.dispose()
    }
  }
  return createVersionSync({
    appVersion,
    // A packaged app, or a test instance told a version: a dev build's
    // package.json version names no release, so it never asks a server.
    automatic: app.isPackaged || (TEST_NO_ACTIVATE && TEST_VERSION !== null),
    connections: () => connections().list(),
    read: async (serverId): Promise<ServerRead> => {
      const { ServerInfoMissing } = await import('../../../packages/client/src/server-info')
      try {
        return { kind: 'info', info: await withClient(serverId, (api) => api.server.info()) }
      } catch (error) {
        return error instanceof ServerInfoMissing ? { kind: 'missing' } : { kind: 'unreachable' }
      }
    },
    request: (serverId, version, when) =>
      withClient(serverId, (api) => api.server.upgrade({ version, when })),
    publish: (results: ServerVersionStatus[]) => {
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed()) win.webContents.send(FLEET_IPC.versionsChanged, results)
    }
  })
}

export interface ServerHandlerOptions {
  /** The version sync; main's own by default, none when null (tests). */
  readonly versionSync?: VersionSync | null
}

/** Where the server is, for the preload's router: null until the shell has
 *  started it, and the router then keeps every method on IPC. IPC is the one
 *  way the address reaches a window. The moment a server is named, every
 *  window is told so and asks again (PRDCT-3527). */
export function registerServerHandlers(
  registry?: ServerConnectionRegistry,
  options: ServerHandlerOptions = {}
): void {
  ipcMain.handle(IPC_SERVER_ENDPOINT, () => getClaveServerEndpoint())
  ipcMain.handle(IPC_SERVER_EXTERNAL, () => isServerExternal())
  onClaveServerEndpointNamed(() => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC_SERVER_ENDPOINT_NAMED)
  })
  if (registry) shared = registry
  const connections = serverConnectionRegistry
  // ── Issue #266: every saved server's version against this app's ──
  const versions =
    options.versionSync === undefined ? mainVersionSync(connections) : options.versionSync
  const changed = (): void => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(FLEET_IPC.changed)
    void versions?.refresh().catch(() => undefined)
  }
  ipcMain.handle(FLEET_IPC.list, () => connections().list())
  ipcMain.handle(FLEET_IPC.save, (_event, input: SaveServerConnection) => {
    const result = connections().save(input)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.connect, (_event, id: string) => {
    const result = connections().connect(id)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.disconnect, (_event, id: string) => {
    const result = connections().disconnect(id)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.remove, (_event, id: string) => {
    connections().remove(id)
    changed()
  })
  // Privileged preload only. E must not bridge this channel to renderer.
  ipcMain.handle(FLEET_IPC.endpoint, (_event, id: string) => connections().endpoint(id))
  // The decisions carry versions, refs and the manual command, never a token.
  ipcMain.handle(FLEET_IPC.versions, (_event, refresh?: boolean) =>
    !versions ? [] : refresh === true ? versions.refresh() : versions.results()
  )
  // A window heard a server's upgrade change, or its welcome: read it again.
  ipcMain.handle(FLEET_IPC.versionRefresh, (_event, id: string) =>
    versions ? versions.refreshServer(id).then(() => undefined) : undefined
  )
  ipcMain.handle(FLEET_IPC.upgradeNow, (_event, id: string) => {
    if (!versions) throw new Error('Server upgrades are not available.')
    return versions.upgradeNow(id)
  })
  if (versions) {
    versions.start()
    setTimeout(() => void versions.refresh().catch(() => undefined), FIRST_VERSION_READ_MS).unref()
  }
}
