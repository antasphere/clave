/**
 * The routines in Electron main (ADR 0004): the service built over the
 * shell's own managers when the shell runs its server in-process, handed to
 * `startClaveServer` as the `routines` port, started once the server is up
 * and closed at quit. The IPC arm (`installRoutinesIpc`) answers a window's
 * calls before the preload has routed them to the server, and pushes every
 * change to every window; attached to a server elsewhere, the routines are
 * that server's and the IPC arm says so.
 */
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type { RoutinesService } from '@clave/server'
import { claudeAccountsManager } from '../claude-accounts'
import { codexAccountsManager } from '../codex-accounts'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { launchProfileManager } from '../launch-profile-manager'
import { preferencesManager, type Preferences } from '../preferences-manager'
import { workspaceManager } from '../workspace-manager'
import { ptyManager } from '../pty-manager'
import { loginShellEnvAsync } from '../sessions/adapters/pty-backend'
import { getSessionHost } from '../sessions/host'
import { sessionWindows } from '../sessions/windows'
import { installE2eHooks } from '../sessions/e2e-hooks'
import { shellSettingsSource } from '../settings/shell-source'
import { fileStorage } from '../ports/storage'
import { workspaceFiles } from '../workspace-files'
import { broadcastToAllWindows } from '../window-routing'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { waitForMcpRuntime } from '../mcp/mcp-runtime'
import { launchFactsFromManagers } from './facts'
import { SlidelessPublisher } from './publisher'
import { createRoutineService, type RoutineService } from './service'
import { contractPluginDir } from './skill'
import { claveServerId, ownServerName } from '../server/clave-server'

let service: RoutineService | null = null

/** The resources folder: beside the app's code in a checkout, in the asar when packaged. */
export function resourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar', 'resources')
    : join(app.getAppPath(), 'resources')
}

export function shellRoutines(): RoutineService {
  if (service) return service
  const userData = app.getPath('userData')
  service = createRoutineService({
    sessions: getSessionHost(),
    files: workspaceFiles(),
    workspaces: async () => workspaceManager.load().workspaces,
    onWorkspacesChanged: (listener) =>
      shellSettingsSource.subscribe((event) => {
        if (event._tag === 'workspaces.state_changed') listener()
      }),
    facts: launchFactsFromManagers({
      claudeAccounts: claudeAccountsManager,
      codexAccounts: codexAccountsManager,
      claudeUsage: usageManager,
      codexUsage: codexUsageManager,
      launchProfiles: launchProfileManager,
      preference: (key) => preferencesManager.get(key as keyof Preferences)
    }),
    storage: fileStorage(userData),
    dataDir: userData,
    // The e2e suite's claims stay under its own user-data directory: two
    // specs at once must never take each other's occurrences, and a run of
    // the suite must never claim one of the installed app's.
    ...(TEST_NO_ACTIVATE ? { claimsDir: join(userData, 'routine-claims') } : {}),
    holder: `clave-shell:${process.pid}`,
    pluginDir: contractPluginDir(resourcesDir()),
    // This Mac, as a routine's `server` field may name it (PRDCT-4149): the
    // in-process server's id once it listens, and the machine's own name
    // unless the environment gives one (the e2e harness does).
    identity: () => ({ id: claveServerId() ?? '', name: ownServerName() }),
    publisher: TEST_NO_ACTIVATE
      ? false
      : new SlidelessPublisher({
          env: () => loginShellEnvAsync(),
          log: (level, message) =>
            (level === 'warn' ? console.warn : console.log)(`[routines] ${message}`)
        }),
    viewer: TEST_NO_ACTIVATE ? false : { env: () => loginShellEnvAsync() },
    rehome: (sessionId, windowKey) => {
      ptyManager.setSessionWindowKey(sessionId, windowKey)
      sessionWindows().bind(sessionId, windowKey)
    },
    providerSessionIdOf: (sessionId) => {
      const record = ptyManager.getSessionRecord(sessionId)
      return record?.claudeSessionId ?? record?.codexThreadId ?? null
    },
    // A run reports through the shell's MCP server: a run starts once it listens.
    agentToolsReady: () => waitForMcpRuntime(),
    log: (level, message) =>
      (level === 'warn' ? console.warn : console.log)(`[routines] ${message}`)
  })
  installE2eHooks({ routines: service })
  return service
}

/** The IPC arm: the window's road before the preload reaches the server.
 *  `routines` is the shell's own service in-process, null when the server
 *  runs elsewhere (its routines answer over the server road alone). */
export function installRoutinesIpc(routines: RoutinesService | null): void {
  const elsewhere = (): never => {
    throw new Error("The routines are the server's: this window has not reached it yet")
  }
  ipcMain.handle('routines:list', async () => (routines ? await routines.list() : elsewhere()))
  ipcMain.handle('routines:run-now', async (_event, key: string) =>
    routines ? await routines.runNow(key) : elsewhere()
  )
  ipcMain.handle('routines:dismiss', (_event, runId: string) =>
    routines ? routines.dismiss(runId) : elsewhere()
  )
  ipcMain.handle(
    'routines:discussion',
    async (_event, runId: string, windowKey: string, mode: 'panel' | 'tab') =>
      routines ? await routines.openDiscussion(runId, windowKey, mode) : elsewhere()
  )
  routines?.subscribe((event) => broadcastToAllWindows('routines:changed', event))
}
