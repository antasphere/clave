// MUST stay the first import: applies --user-data-dir before any manager
// captures app.getPath('userData') at module-import time.
import './user-data-override'
// SECOND, before any manager: a pre-release's first run on a stable data
// directory snapshots the state files before anything can rewrite them.
import { prereleaseSnapshotOutcome } from './prerelease-snapshot-boot'
import { app, BrowserWindow, shell, nativeImage, nativeTheme, Notification } from 'electron'
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
import { sidebarLayouts, setSidebarTransport } from './sidebar-layouts'
import { sessionWorkspaceResolver } from './session-records-index'
import type { PersistedWindow } from '../shared/workspace-types'
import {
  initMissionControl,
  cleanupMissionControl,
  attachMissionControlWindow
} from './mission-control-manager'
import { cleanupClaveWatchers } from './ipc-handlers/clave-file-handlers'
import { startMcpServer, stopMcpServer, registerMcpWindowOpener } from './mcp/mcp-server'
import { usageManager } from './usage-manager'
import { codexUsageManager } from './codex-usage'
import { accountLoginManager } from './account-login'
import { sweepSessionMcpConfigs } from './mcp/mcp-runtime'
import { registerPreviewScheme, installPreviewProtocol } from './preview-protocol'
import { hardenViewHost, installViewGuestPolicy } from './view-guests'
import { startServer, takeServerLaunch, ServerBootError, type ServerHandle } from './server-boot'
import { QUIT_CEILING_MS, QUIT_HAMMER_MS, armQuitHammer, awaitQuitWaits } from './quit-cleanup'
import { startClaveServer, stopClaveServer } from './server/clave-server'
import { markClaveServerBootSettled } from './server/endpoint'
import { setClaveServerEndpoint } from './server/endpoint'
import { getSessionHost } from './sessions/host'
import { installE2eHooks } from './sessions/e2e-hooks'
import { shellSettingsSource, shellAntasphereAccount } from './settings/shell-source'
import { terminalPorts } from './ports/terminals'
import { workspaceFiles } from './workspace-files'

// The server to attach to, if any, read ONCE off the environment and taken
// out of it here, before anything in this process spawns: the token belongs
// to what is meant to call the server, and no session, helper or nested Clave
// may inherit it (ADR 0003).
const serverLaunch = takeServerLaunch(process.env)

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
 * one started elsewhere under `CLAVE_SERVER_URL` + `CLAVE_SERVER_TOKEN`. In
 * this wave nothing the window shows comes from it yet, so a failure is not
 * fatal — but it is never silent: an attach that fails is logged, written to
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
            workspaceFiles: workspaceFiles()
          },
          // ── Lane C of wave 3: the end-to-end fixture route, test mode only ──
          testFixtures: TEST_NO_ACTIVATE
        })
        return { url: endpoint.url, token: endpoint.token, stop: stopClaveServer }
      }
    })
    console.log(`[server] ${serverHandle.mode} at ${serverHandle.url}`)
    // The sidebar's transport follows the boot: through the server's client
    // when the server runs in this process (the same instance main holds),
    // over IPC when the app is attached to a server that cannot host windows.
    setSidebarTransport(serverHandle.mode === 'in-process' ? 'server' : 'shell')
    // An attached server is published to the windows too (wave 2): the
    // sessions domain lives on the server now, so a window on an attached
    // app asks that server, which says what it cannot do (a standalone
    // server runs no sessions until its terminal process, wave 3). The
    // in-process start publishes its own address in server/clave-server.ts.
    if (serverHandle.mode === 'attached')
      setClaveServerEndpoint({ url: serverHandle.url, token: serverHandle.token, mode: 'attached' })
  } catch (err) {
    const message = err instanceof ServerBootError ? err.message : String(err)
    console.error(`[server] not available: ${message}`)
    setSidebarTransport('shell')
    if (
      err instanceof ServerBootError &&
      err.mode === 'attached' &&
      !TEST_NO_ACTIVATE &&
      Notification.isSupported()
    ) {
      new Notification({
        title: 'Clave could not reach its server',
        body: `${message}. The app runs without it.`,
        silent: false
      }).show()
    }
  }
}

function onWindowClosed(windowId: number, windowKey: string): void {
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
  windowRegistry.unregisterWindow(windowId)
  windowState.remove(windowKey)
  const primary = windowRegistry.getPrimaryWindow()
  if (!primary) return
  const primaryKey = windowRegistry.getKeyForWindow(primary.id)
  // The closing window's groups go to the primary through the sidebar
  // domain (its layout absorbed, its file removed), and its live sessions
  // follow them in the same hand-over.
  const layout = sidebarLayouts().windowClosed(windowKey, primaryKey)
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
  win.on('closed', () => onWindowClosed(windowId, entry.key))

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
  cleanupClaveWatchers()
  cleanupAutoUpdater()
  agentUpdateManager.stop()
  cleanupTelemetry()
  cleanupMissionControl()
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
  quitCleanup = awaitQuitWaits(
    [
      { name: "the sessions' shutdown", promise: ptyManager.killAll() },
      { name: "the server's stop", promise: serverBoot.then(() => serverHandle?.stop()) }
    ],
    { ceilingMs: QUIT_CEILING_MS, log: (line) => console.error(line) }
  )
    .then((outcome) => {
      if (outcome.pending.length === 0) console.log(`[quit] cleanup done in ${outcome.ms} ms`)
    })
    .finally(() => {
      quitReady = true
      armQuitHammer({
        ms: QUIT_HAMMER_MS,
        exit: (code) => app.exit(code),
        log: (line) => console.error(line)
      })
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
