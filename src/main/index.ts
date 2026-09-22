// MUST stay the first import: applies --user-data-dir before any manager
// captures app.getPath('userData') at module-import time.
import './user-data-override'
// SECOND, before any manager: a pre-release's first run on a stable data
// directory snapshots the state files before anything can rewrite them.
import { prereleaseSnapshotOutcome } from './prerelease-snapshot-boot'
import { app, BrowserWindow, shell, nativeImage, nativeTheme } from 'electron'
import { TEST_NO_ACTIVATE } from './test-mode'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { applyPersistedIcon } from './ipc-handlers/app-handlers'
import { cleanupDroppedFiles } from './ipc-handlers/dropped-file-handlers'
import {
  registerWindowHandlers,
  broadcastIdentities,
  moveSessionsToWindow,
  takeClosingLayout
} from './ipc-handlers/window-handlers'
import { ptyManager, preloadLoginShellEnv } from './pty-manager'
import { initAutoUpdater, cleanupAutoUpdater } from './auto-updater'
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
import { sweepSessionMcpConfigs } from './mcp/mcp-runtime'
import { registerPreviewScheme, installPreviewProtocol } from './preview-protocol'
import { hardenViewHost, installViewGuestPolicy } from './view-guests'

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
  const layout = takeClosingLayout(windowKey)
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
  moveSessionsToWindow(tmuxBacked, primary.id, layout, false)
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

app.on('before-quit', () => {
  quitting = true
  cleanupClaveWatchers()
  cleanupAutoUpdater()
  cleanupTelemetry()
  cleanupMissionControl()
  usageManager.stopPolling()
  stopMcpServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
