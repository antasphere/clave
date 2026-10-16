// MUST stay the first import: applies --user-data-dir before any manager
// captures app.getPath('userData') at module-import time.
import './user-data-override'
// SECOND, before any manager: a pre-release's first run on a stable data
// directory snapshots the state files before anything can rewrite them.
import { prereleaseSnapshotOutcome } from './prerelease-snapshot-boot'
import {
  app,
  BrowserWindow,
  shell,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage
} from 'electron'
import { flushRendererStorage } from './flush-storage'
import { TEST_NO_ACTIVATE } from './test-mode'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { applyPersistedIcon } from './ipc-handlers/app-handlers'
import { cleanupDroppedFiles } from './ipc-handlers/dropped-file-handlers'
import {
  registerWindowHandlers,
  broadcastIdentities,
  rehomeSessions
} from './ipc-handlers/window-handlers'
import { ptyManager, preloadLoginShellEnv } from './pty-manager'
import { initAutoUpdater, cleanupAutoUpdater } from './auto-updater'
import { agentUpdateManager } from './agent-updates'
import { buildAppMenu } from './app-menu'
import { initTelemetry, cleanupTelemetry } from './telemetry'
import { initNotificationManager } from './notification-manager'
import { sshManager } from './ssh-manager'
import { locationManager } from './location-manager'
import { openclawClient, buildOpenclawWsUrl } from './openclaw-client'
import { preferencesManager } from './preferences-manager'
import { workspaceManager } from './workspace-manager'
import { windowRegistry } from './window-registry'
import { windowState } from './window-state'
import { sidebarLayoutManager } from './sidebar-layout-manager'
import {
  sidebarLayouts,
  setSidebarTransport,
  isAttachedServer,
  sessionIdsInWindow
} from './sidebar-layouts'
import { serverClient, preloadServerClientModules } from './mcp/server-client'
import { sessionWorkspaceResolver } from './session-records-index'
import type { PersistedWindow } from '../shared/workspace-types'
import {
  initMissionControl,
  cleanupMissionControl,
  attachMissionControlWindow
} from './mission-control-manager'
import { cleanupClaveWatchers } from './ipc-handlers/clave-file-handlers'
import {
  startMcpServer,
  stopMcpServer,
  registerMcpWindowOpener,
  announceAgentToolsToServer
} from './mcp/mcp-server'
import { usageManager } from './usage-manager'
import { codexUsageManager } from './codex-usage'
import { accountLoginManager } from './account-login'
import { sweepSessionMcpConfigs } from './mcp/mcp-runtime'
import { registerPreviewScheme, installPreviewProtocol } from './preview-protocol'
import { hardenViewHost, installViewGuestPolicy } from './view-guests'
import {
  startServer,
  takeServerLaunch,
  markServerGone,
  ServerBootError,
  type ServerHandle,
  type ServerLaunch
} from './server-boot'
import { flagsForServerChild, startSeparateServer } from './server-child'
import { migrateAppDataToServer } from './server-migration'
import { safeStorageSecrets } from './ports/electron'
import { keychainSecrets } from './ports/secrets'
import { KEYCHAIN_SERVICE, keychainFileFromEnv } from './ports/standalone'
import { QUIT_CEILING_MS, QUIT_HAMMER_MS, runQuitCleanup } from './quit-cleanup'
import { startClaveServer, stopClaveServer } from './server/clave-server'
import { quitActivityRecord } from './activity/service'
import { markClaveServerBootSettled } from './server/endpoint'
import { setClaveServerEndpoint, setServerExternal } from './server/endpoint'
import { getSessionHost } from './sessions/host'
import { installE2eHooks } from './sessions/e2e-hooks'
import { shellSettingsSource, shellAntasphereAccount } from './settings/shell-source'
import { terminalPorts } from './ports/terminals'
import { workspaceFiles } from './workspace-files'
// ── Wave 5, lane C: the plugins, the shell's own service (plugins/shell-plugins.ts) ──
import { shellPlugins } from './plugins/shell-plugins'

// The server to attach to, if any, read ONCE off the environment and taken
// out of it here, before anything in this process spawns: the token belongs
// to what is meant to call the server, and no session, helper or nested Clave
// may inherit it (ADR 0003). The command line's `--server` flag picks the
// shell's own server otherwise (in-process, or a separate child of the
// app, wave 5), and a packaged app has its own default (server-boot.ts).
// A `--server` value that is not a mode ends the launch here, with the
// sentence on stderr and exit code 2: a typo must not pick a mode, and an
// error box the person cannot read past is no answer either (the round-1
// verifier watched the throw land in Electron's dialog, the process alive
// until dismissed).
const serverLaunch: ServerLaunch = (() => {
  try {
    return takeServerLaunch(process.env, {
      argv: process.argv,
      packaged: app.isPackaged,
      platform: process.platform
    })
  } catch (err) {
    process.stderr.write(`[server] ${(err as Error).message}\n`)
    return process.exit(2)
  }
})()
// ── Wave 6, lane B: a launch's restore waits on nothing it can start sooner (PRDCT-3527) ──
// Where this shell's sessions live, for the boot's records listing, and the
// login shell's environment read from here rather than from app ready: tmux
// and the agents are found on its PATH, and the read takes as long as the
// person's shell profile (two seconds on Valentin's machine).
setServerExternal(serverLaunch.mode !== 'in-process')
preloadLoginShellEnv()

// Scheme privileges must be declared before app ready.
registerPreviewScheme()

// `--test-no-activate` (see test-mode.ts): become an accessory app BEFORE ready,
// so the instance never activates even once. Off-flag this block does nothing.
if (TEST_NO_ACTIVATE && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
}

/**
 * The teardown ladder (PRDCT-1703). A window is the whole app once more, and
 * closing one must not disturb another:
 *
 *  - a NON-LAST window closing hands what it holds to the PRIMARY (the lowest
 *    live id, re-elected if the closing one was it): its tmux-backed sessions
 *    move there (detach + re-adopt, id preserved, scrollback intact) together
 *    with its groups; a plain-pty session dies exactly as it did on close
 *    before, its record re-stamped to the primary so the next boot offers it
 *    there. The window is forgotten by windows.json — a window the user closed
 *    does not come back. Sessions hosted by OTHER windows are never touched;
 *    ssh and OpenClaw stay up.
 *  - the LAST window closing is the app's shutdown as before; it stays in
 *    windows.json so the next launch (or the Dock's activate) brings it back.
 *  - windows closing one after another inside a QUIT hand nothing over: every
 *    one of them comes back at the next launch, with its own content.
 */
let quitting = false

/**
 * The server the shell runs on (ADR 0003). In-process by default; attached to
 * one started elsewhere under `CLAVE_SERVER_URL` + `CLAVE_SERVER_TOKEN`; or,
 * under `--server=separate` (wave 5), started by the shell as a child of its
 * own from the bundles it carries, under its own binary as Node
 * (server-child.ts), and attached to the same way. A failure is never
 * silent: an attach or a child start that fails is logged, written to
 * `clave-server.json` as `ok: false`, and shown as a notification, and the
 * app does NOT start an in-process server in its place (server-boot.ts says
 * why). The url and the token live in `clave-server.json` (owner-only) and in
 * the handle, and NOWHERE in this process's environment: an export there
 * would reach every helper main spawns off `process.env` (git, gh, the Codex
 * app-server, the plugin runner) and none of the sessions, which get their
 * environment from the cached login shell and from tmux's own list. What
 * needs the server is handed the pair deliberately, when it moves (wave 2).
 *
 * `serverBoot` is the boot's promise: a quit waits on it before stopping, so
 * a registration still in flight is deregistered rather than left as a
 * ghost on an attached server.
 */
let serverHandle: ServerHandle | null = null
let serverBoot: Promise<void> = Promise.resolve()

async function bootServer(): Promise<void> {
  // A test seam, under --test-no-activate only: the suite makes the server
  // come up late (`CLAVE_E2E_SERVER_BOOT_DELAY_MS`) to prove a window that
  // booted before it still hears the sidebar once it answers.
  const bootDelay = TEST_NO_ACTIVATE ? Number(process.env.CLAVE_E2E_SERVER_BOOT_DELAY_MS ?? 0) : 0
  if (bootDelay > 0) await new Promise((resolve) => setTimeout(resolve, bootDelay))
  try {
    serverHandle = await startServer({
      launch: serverLaunch,
      userData: app.getPath('userData'),
      identity: { kind: 'shell', name: `clave-shell ${app.getVersion()}`, pid: process.pid },
      // The in-process server: `@clave/server` over the session manager
      // (server/clave-server.ts), which publishes its address to the windows.
      startInProcess: async () => {
        const endpoint = await startClaveServer({
          ports: {
            // ── Lane A: sessions ──
            sessions: getSessionHost(),
            // ── Lane D: settings, the shell's managers (settings/shell-source.ts) ──
            settings: shellSettingsSource,
            // ── Lane B: terminals (node-pty in this process, src/main/ports/terminal.ts) ──
            terminals: terminalPorts().terminals,
            // ── Lane C: the sidebar, the shell's own instance (sidebar-layouts.ts) ──
            sidebar: sidebarLayouts(),
            // ── Wave 3, lane A: the workspace files, the shell's own instance (workspace-files.ts) ──
            workspaceFiles: workspaceFiles(),
            // ── Wave 5, lane C: the plugins, the shell's own service (plugins/shell-plugins.ts) ──
            plugins: shellPlugins()
          },
          // ── Lane C of wave 3: the end-to-end fixture route, test mode only ──
          testFixtures: TEST_NO_ACTIVATE
        })
        return { url: endpoint.url, token: endpoint.token, stop: stopClaveServer }
      },
      // The separate server (wave 5): the standalone entry as a child of this
      // process, from the bundles beside this one, on a data directory of
      // its own under the app's, told this shell's test flags and pid. The
      // first time, the app's own documents are carried into that directory
      // (server-migration.ts): the plain ones copied, the Claude tokens and
      // the Antasphere session opened with this process's safeStorage and
      // sealed again in the Keychain the server reads, in memory only.
      startSeparate: () => {
        // The client main reaches that server with, loaded while it starts
        // rather than once it has answered, when the first window has shown
        // (PRDCT-3527): half a second of synchronous requires, which held the
        // windows' first calls to the server behind it when paid after the
        // announcement, and the window's first paint when paid before.
        const preload = (): void => void preloadServerClientModules()
        const [first] = BrowserWindow.getAllWindows()
        const afterLoad = (win: BrowserWindow): void => {
          win.webContents.once('did-finish-load', () => setTimeout(preload, 0))
        }
        if (first && first.webContents.getURL() && !first.webContents.isLoading())
          setTimeout(preload, 0)
        else if (first) afterLoad(first)
        else app.once('browser-window-created', (_event, win) => afterLoad(win))
        const dataDir = join(app.getPath('userData'), 'server')
        const migration = migrateAppDataToServer({
          appDir: app.getPath('userData'),
          serverDir: dataDir,
          from: safeStorageSecrets(safeStorage),
          to: keychainSecrets({
            service: KEYCHAIN_SERVICE,
            keychainFile: keychainFileFromEnv(process.env)
          }),
          log: (line) => console.log(`[server] migration: ${line}`)
        })
        if (migration.outcome === 'migrated')
          console.log(
            `[server] migrated the app's data into ${dataDir}: ${migration.copied.length} copied, ${migration.kept.length} kept, ${migration.unopened.length} secret(s) not opened`
          )
        return startSeparateServer({
          execPath: process.execPath,
          bundleDir: __dirname,
          dataDir,
          parent: process.pid,
          // The plugins the app ships and its version, for the plugin host
          // on the server (lane C of wave 5): where plugin-ipc.ts finds them.
          pluginsBundled: join(
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            'plugins'
          ),
          appVersion: app.getVersion(),
          flags: flagsForServerChild(process.argv),
          log: (line) => console.error(`[server] ${line}`),
          onExit: (code) => {
            // Nothing runs in its place and the windows keep its address:
            // their calls say the server is gone, which is the truth; the
            // discovery file says it too, so no reader finds a live-looking
            // server that is not there.
            console.error(`[server] the separate server is gone (${code}); the app runs without it`)
            // Guarded: a write that fails (a full disk) must not stop the
            // notification below from saying what happened.
            try {
              markServerGone(
                app.getPath('userData'),
                `the separate server exited (${code}) while the app was running`
              )
            } catch (error) {
              console.error(`[server] could not mark the discovery file: ${String(error)}`)
            }
            if (!TEST_NO_ACTIVATE && Notification.isSupported())
              new Notification({
                title: "Clave's server stopped",
                body: `It exited (${code}). Restart Clave to get it back.`,
                silent: false
              }).show()
          }
        })
      }
    })
    console.log(
      `[server] ${serverHandle.mode} at ${serverHandle.url}` +
        (serverHandle.serverPid ? ` (pid ${serverHandle.serverPid})` : '')
    )
    // The sidebar's transport follows the boot: through the server's client
    // when the server runs in this process (the same instance main holds),
    // over IPC when the server is another process, which hosts no windows.
    const external = serverHandle.mode !== 'in-process'
    setSidebarTransport(external ? 'shell' : 'server')
    // A server in another process, attached or the shell's own child, is
    // published to the windows too (wave 2): the sessions domain lives on
    // the server, so a window asks that server. The windows read the mode
    // as `attached` either way: what it decides for them (the terminal
    // pane's road, the sidebar's) is the same whoever started the process.
    // The in-process start publishes its own address in server/clave-server.ts.
    if (external) {
      setClaveServerEndpoint({ url: serverHandle.url, token: serverHandle.token, mode: 'attached' })
      // Tell the server where this shell's agent tools answer, so a Claude
      // session it starts reaches them (wave 4, lane C). It waits for the MCP
      // server inside its own call, so the order of the two boots is safe.
      void announceAgentToolsToServer()
    }
  } catch (err) {
    const message = err instanceof ServerBootError ? err.message : String(err)
    console.error(`[server] not available: ${message}`)
    setSidebarTransport('shell')
    if (
      err instanceof ServerBootError &&
      err.mode !== 'in-process' &&
      !TEST_NO_ACTIVATE &&
      Notification.isSupported()
    ) {
      new Notification({
        title:
          err.mode === 'separate'
            ? 'Clave could not start its server'
            : 'Clave could not reach its server',
        body: `${message}. The app runs without it.`,
        silent: false
      }).show()
    }
  }
}

async function onWindowClosed(windowId: number, windowKey: string): Promise<void> {
  // Only CLAVE windows count (the registry's), never a stray BrowserWindow a
  // dialog or a picker might own — or the final close would skip the app's
  // shutdown.
  const remaining = windowRegistry.listWindows().filter((w) => w.id !== windowId)
  if (remaining.length === 0) {
    ptyManager.killAll()
    sshManager.disconnectAll()
    openclawClient.disconnectAll()
    windowRegistry.unregisterWindow(windowId)
    return
  }
  if (quitting) {
    windowRegistry.unregisterWindow(windowId)
    return
  }
  const hosted = windowRegistry.getSessionsForWindow(windowId)
  // Attached, the sessions are the server's and main keeps no process
  // binding for them: the closing window's sessions come from the SERVER's
  // own list for this window (its hidden sessions — a toolbar server, a
  // view's serving process — are not in the layout), with the layout as a
  // fallback when the server cannot be reached.
  const attached = isAttachedServer()
  let attachedIds: string[] = []
  if (attached) {
    const fromServer = await serverClient
      .api()
      .then((api) => api.sessions.list(windowKey))
      .then((sessions) => sessions.map((session) => session.id))
      .catch(() => [] as string[])
    attachedIds = [...new Set([...fromServer, ...sessionIdsInWindow(windowKey)])]
  }
  windowRegistry.unregisterWindow(windowId)
  windowState.remove(windowKey)
  const primary = windowRegistry.getPrimaryWindow()
  if (!primary) return
  const primaryKey = windowRegistry.getKeyForWindow(primary.id)
  // The closing window's groups go to the primary through the sidebar
  // domain (its layout absorbed, its file removed), and its live sessions
  // follow them in the same hand-over.
  const layout = sidebarLayouts().windowClosed(windowKey, primaryKey)
  if (attached) {
    // Release the closing window's sessions on the server, each re-stamped
    // to the primary (the plain ones the way an in-process close re-stamps
    // and drops them), then hand the primary the layout to take them into.
    if (primaryKey && attachedIds.length > 0) {
      const outcome = await serverClient
        .api()
        .then((api) => api.sessions.release(attachedIds, primaryKey))
        .catch(() => ({ released: [] as string[], refused: [] }))
      if (!primary.isDestroyed())
        primary.webContents.send('session:rehome', {
          sessionIds: outcome.released,
          layout,
          focus: false
        })
    }
    broadcastIdentities()
    return
  }
  // Plain-pty sessions die with their renderer (as on close before); their
  // records follow the primary so the next boot offers them there.
  const tmuxBacked: string[] = []
  for (const id of hosted) {
    if (ptyManager.getSession(id)?.tmuxName) tmuxBacked.push(id)
    else {
      if (primaryKey) ptyManager.setSessionWindowKey(id, primaryKey)
      ptyManager.kill(id, false)
    }
  }
  if (primaryKey) rehomeSessions(tmuxBacked, primaryKey, { layout, focus: false })
  broadcastIdentities()
}

/** Persist a window's frame after it settles, so it comes back on the same
 *  screen at the same size. */
function trackBounds(win: BrowserWindow, key: string): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (win.isDestroyed() || !windowState.has(key)) return
      const { x, y, width, height } = win.getNormalBounds()
      windowState.upsert(key, { bounds: { x, y, width, height } })
    }, 500)
  }
  win.on('resize', save)
  win.on('move', save)
}

function createWindow(entry: PersistedWindow): BrowserWindow {
  const savedIcon = preferencesManager.get('appIcon')
  const icon = nativeImage.createFromPath(join(__dirname, `../../resources/icon-${savedIcon}.png`))
  const workspaceId =
    entry.workspaceId && workspaceManager.isRegistered(entry.workspaceId)
      ? entry.workspaceId
      : workspaceManager.resolveInitialWorkspaceId()

  const win = new BrowserWindow({
    width: entry.bounds?.width ?? 1400,
    height: entry.bounds?.height ?? 900,
    ...(entry.bounds ? { x: entry.bounds.x, y: entry.bounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0d0c' : '#ffffff',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // The attached pages (group and session views) are <webview> guests —
      // hardened and navigation-policed in view-guests.ts, never here.
      webviewTag: true,
      // A test window is never put on screen (see below); without this
      // Chromium would treat the hidden page as background and stop its
      // timers and animation frames — the driver needs them running.
      //
      // `additionalArguments` is how the flag reaches the PRELOAD. A preload's
      // own `process.argv` is the renderer process's command line, which
      // carries Chromium's switches and none of the app's, so reading
      // `--test-no-activate` there finds nothing. This is the supported way to
      // put a value on it, and it is the seam the renderer's E2E-only hooks
      // are gated on — so in a shipped app, where this flag is never passed,
      // those hooks do not exist.
      ...(TEST_NO_ACTIVATE
        ? { backgroundThrottling: false, additionalArguments: ['--test-no-activate'] }
        : {})
    }
  })

  // Registered before load so the renderer's very first `window:identity`
  // finds it. The registry, not the state file, is what the window shows.
  windowRegistry.registerWindow(win, entry.key, workspaceId)
  windowState.upsert(entry.key, { workspaceId })
  trackBounds(win, entry.key)

  // In dev mode, set dock icon from PNG. In packaged mode, let macOS
  // render from the .icon bundle (which supports Tahoe glass effect).
  // applyPersistedIcon() handles copying the right .icon bundle on startup.
  // Skipped under --test-no-activate: there is no Dock tile to set under the
  // accessory policy, and setIcon throws on a hidden dock.
  if (process.platform === 'darwin' && !app.isPackaged && !TEST_NO_ACTIVATE) {
    app.dock?.setIcon(icon)
  }

  win.on('ready-to-show', () => {
    // Under --test-no-activate the window is NEVER put on screen: even
    // showInactive() places a new window at the front of the desktop, over
    // whatever the human is working on. The driver (Playwright over the
    // debugger protocol) does not need the window shown; the renderer keeps
    // running thanks to backgroundThrottling: false above.
    if (!TEST_NO_ACTIVATE) win.show()
  })

  attachMissionControlWindow(win)

  // The traffic lights are gone in fullscreen and the chrome keeping clear of
  // them should close the gap. Sent to this window only — fullscreen is a
  // window's state, not the app's.
  const sendFullScreen = (value: boolean) => (): void => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen-changed', value)
  }
  win.on('enter-full-screen', sendFullScreen(true))
  win.on('leave-full-screen', sendFullScreen(false))

  const windowId = win.id
  win.on('closed', () => void onWindowClosed(windowId, entry.key))

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('clave://')) {
      event.preventDefault()
      return
    }
    // In dev, allow navigating to the dev server URL
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) {
      return
    }
    // Block all other navigation — links should be handled by the renderer
    event.preventDefault()
  })

  hardenViewHost(win)

  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('clave://')) {
      return { action: 'deny' }
    }
    const allowed = ['https:', 'http:']
    if (allowed.some((s) => details.url.startsWith(s))) {
      shell.openExternal(details.url).catch(() => {})
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** A new window, the app once more, on `workspaceId` (null = the
 *  no-workspace state). Persisted at once so it comes back at the next boot. */
export function openWindow(workspaceId: string | null): { windowId: number } {
  const key = windowState.mintKey()
  const win = createWindow({ key, workspaceId })
  if (workspaceId) workspaceManager.setLastActive(workspaceId)
  broadcastIdentities()
  return { windowId: win.id }
}

/**
 * Bring back every persisted window. The first boot of the multi-window
 * build (no windows.json yet) mints the first window's key and migrates the
 * older sidebar-layout files into it — the one place that migration runs.
 */
function openPersistedWindows(): void {
  const persisted = windowState.list()
  if (persisted.length === 0) {
    const key = windowState.mintKey()
    const workspaceIds = workspaceManager.getWorkspaces().map((w) => w.id)
    try {
      sidebarLayoutManager.migrateIntoWindow(
        key,
        workspaceIds.length > 0
          ? {
              workspaceIds,
              fallbackWorkspaceId: workspaceManager.resolveInitialWorkspaceId() ?? workspaceIds[0],
              resolveWorkspaceForCwd: (cwd) => workspaceManager.resolveWorkspaceForCwd(cwd),
              resolveWorkspaceForSession: sessionWorkspaceResolver()
            }
          : null
      )
    } catch (err) {
      console.error('[sidebar-layout] migration into the first window failed:', err)
    }
    createWindow({ key, workspaceId: workspaceManager.resolveInitialWorkspaceId() })
    return
  }
  for (const entry of persisted) createWindow(entry)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.clave.app')

  // The Dock tile is created at ready; hide it here so the test instance shows
  // none. Paired with the accessory policy set above.
  if (TEST_NO_ACTIVATE && process.platform === 'darwin') {
    app.dock?.hide()
  }

  // Pre-cache login shell env asynchronously so PTY spawns don't block the main thread
  preloadLoginShellEnv()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers({ onChanged: () => buildAppMenu({ openWindow }) })
  registerWindowHandlers({ openWindow })
  registerMcpWindowOpener(openWindow)
  installPreviewProtocol()
  installViewGuestPolicy()
  // MCP failure must not break the app — spawns just omit the --mcp-config flag.
  void startMcpServer().catch((err) => console.error('[mcp] failed to start', err))
  // The endpoint reaches the renderer over IPC and nowhere else (ADR 0003):
  // the preload asks `ipc-handlers/server-handlers.ts`, registered above.
  // The end-to-end seam into the sessions, under --test-no-activate only
  // (sessions/e2e-hooks.ts): installed at boot, before the server, so an
  // app attached to a standalone server has it too.
  installE2eHooks({ sessionHost: getSessionHost() })
  // The agent tools wait for the boot to decide (server/endpoint.ts): a
  // tool call before the decision waits, one after a failed boot fails at once.
  serverBoot = bootServer().finally(() => markClaveServerBootSettled())
  sweepSessionMcpConfigs()
  cleanupDroppedFiles()
  initNotificationManager()
  applyPersistedIcon()
  openPersistedWindows()
  buildAppMenu({ openWindow })
  initAutoUpdater({
    prereleaseUpdates: {
      get: () => preferencesManager.get('prereleaseUpdates') === true,
      set: (value) => preferencesManager.set('prereleaseUpdates', value)
    },
    snapshot: prereleaseSnapshotOutcome()
  })
  agentUpdateManager.start()
  initTelemetry()
  initMissionControl()

  // Auto-connect locations with autoConnect enabled
  const locations = locationManager.getLocations()
  for (const loc of locations) {
    if (loc.type === 'remote' && loc.autoConnect) {
      const config = locationManager.getCredentials(loc.id)
      if (config) {
        sshManager
          .connect(loc.id, config)
          .then(() => {
            locationManager.setLocationStatus(loc.id, 'connected')
            // Connect OpenClaw if detected
            if (loc.openclawPort && loc.host) {
              const token = locationManager.getOpenclawToken(loc.id)
              openclawClient.connect(loc.id, buildOpenclawWsUrl(loc), token).catch(() => {})
            }
          })
          .catch(() => {
            locationManager.setLocationStatus(loc.id, 'error')
          })
      }
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openPersistedWindows()
    }
  })
})

let quitReady = false
let quitCleanup: Promise<void> | undefined
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitCleanup) return
  quitting = true
  // The unsent composer drafts live in localStorage: commit them to disk
  // before anything else of the quit runs.
  flushRendererStorage()
  cleanupClaveWatchers()
  cleanupAutoUpdater()
  agentUpdateManager.stop()
  cleanupTelemetry()
  cleanupMissionControl()
  // The activity record's quit row, before the shutdown forgets the sessions:
  // written now, nothing that follows reads as a close (activity/service.ts).
  quitActivityRecord()
  usageManager.stopPolling()
  codexUsageManager.stopPolling()
  accountLoginManager.cancelAll()
  // The Antasphere login, while this process is its server: nothing stays
  // listening, nothing fires later (attached, the server elsewhere owns it).
  shellAntasphereAccount?.shutdown()
  stopMcpServer()
  // Keep the event loop alive until owned event children finish their escalation.
  // The server goes with them: the boot awaited first (a registration still
  // in flight must land before it is undone), then deregistered, and stopped
  // when it is ours. Both waits are bounded (quit-cleanup.ts, PRDCT-3375,
  // PRDCT-3290): past the ceiling the log names the wait still pending and
  // the quit goes on; a quit that then still does not end is exited by the
  // hammer. A quit with nothing wrong takes well under a second.
  quitCleanup = runQuitCleanup(
    [
      // `quit: true`: the title door shuts too (a window's close runs the
      // same shutdown and is not a quit; pty-manager.ts says why).
      { name: "the sessions' shutdown", promise: ptyManager.killAll({ quit: true }) },
      { name: "the server's stop", promise: serverBoot.then(() => serverHandle?.stop()) }
    ],
    {
      ceilingMs: QUIT_CEILING_MS,
      hammerMs: QUIT_HAMMER_MS,
      quit: () => {
        quitReady = true
        app.quit()
      },
      exit: (code) => app.exit(code),
      log: (line) => console.error(line),
      info: (line) => console.log(line)
    }
  ).then(() => undefined)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
