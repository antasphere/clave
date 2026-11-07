/**
 * Lane B of the server wave: this Mac as a Clave server, and the tailnet's
 * other machines. The install runs `scripts/install-server.sh` with this
 * Mac's tailnet address (loopback without Tailscale) and, once it is done,
 * saves the new server as a connection with the token read from its identity
 * file, so the windows see it without the person copying anything.
 *
 * The token never reaches a window: it goes from the identity file to the
 * saved connection (sealed there) or, on "Copy token", to the clipboard, and
 * no answer, progress event or log line carries it. Under test mode the
 * clipboard is left alone and the token lands on the test hooks, and the
 * script, its config directory, the tailnet status and the scan's port come
 * from the `--test-*` flags of `test-mode.ts`. No handler takes an argument
 * from the renderer.
 */
import { BrowserWindow, app, clipboard, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  installFailure,
  installScriptPath,
  readIdentityToken,
  readInstalledServer,
  runInstallScript,
  serviceState
} from '../server-setup/install'
import { probeLive, scanTailnet } from '../server-setup/scan'
import { normalizeServerUrl } from '../server-connections/registry'
import { getLoginShellEnv } from '../sessions/adapters/pty-backend'
import { installE2eHooks } from '../sessions/e2e-hooks'
import {
  defaultTailscaleBinary,
  parseTailscaleStatus,
  readTailscaleStatus,
  type TailscaleStatus
} from '../tailscale'
import {
  TEST_INSTALL_CONFIG,
  TEST_INSTALL_SCRIPT,
  TEST_NO_ACTIVATE,
  TEST_SCAN_PORT,
  TEST_TAILSCALE_STATUS
} from '../test-mode'
import { fleetConnectionsChanged, serverConnectionRegistry } from './server-handlers'
import type {
  ServerInstallPhase,
  ServerInstallResult,
  ServerInstallStatus,
  TailnetScan
} from '../../shared/server-setup-types'

/** The service name the app installs under, the script's default. */
const SERVER_NAME = 'clave-server'
/** The port the script listens on by default. */
const SERVER_PORT = 43127

const configDir = (): string =>
  TEST_INSTALL_CONFIG ?? (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'))

const plistPath = (): string =>
  join(homedir(), 'Library', 'LaunchAgents', `com.antasphere.${SERVER_NAME}.plist`)

/** The tailnet status, from the test file under test mode; null without a CLI. */
async function tailnetStatus(): Promise<TailscaleStatus | null> {
  if (TEST_TAILSCALE_STATUS)
    return parseTailscaleStatus(JSON.parse(readFileSync(TEST_TAILSCALE_STATUS, 'utf8')))
  const binary = defaultTailscaleBinary()
  return binary ? readTailscaleStatus({ binary }) : null
}

/** This Mac's tailnet IPv4 while Tailscale is up, null otherwise or on any error. */
async function selfTailnetIp(): Promise<string | null> {
  try {
    const status = await tailnetStatus()
    return status?.backendState === 'Running' ? status.self.ip : null
  } catch {
    return null
  }
}

/** The saved connection pointing at `url`, compared as the registry stores it. */
function connectionFor(url: string): string | null {
  let normalized: string
  try {
    normalized = normalizeServerUrl(url)
  } catch {
    return null
  }
  return (
    serverConnectionRegistry()
      .list()
      .find((connection) => connection.url === normalized)?.id ?? null
  )
}

/** This Mac's name for its connection: the host name's first label, since
 *  the network may have given it a DNS suffix of its own. */
function thisMacName(): string {
  return hostname().split('.')[0].trim() || 'This Mac'
}

function publishPhase(phase: ServerInstallPhase): void {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send('server-setup:install-progress', { phase })
}

async function install(): Promise<ServerInstallResult> {
  publishPhase('starting')
  // The address is chosen on the first install only: a later run updates
  // the release and keeps the saved address, so a Tailscale that happens to
  // be down at that moment never moves a tailnet server to loopback (the
  // script's own guard, which a host given again would override).
  const first = readInstalledServer({ configDir: configDir(), name: SERVER_NAME }) === null
  const host = first ? ((await selfTailnetIp()) ?? '127.0.0.1') : null
  const script =
    TEST_INSTALL_SCRIPT ??
    installScriptPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
  const run = await runInstallScript({
    script,
    args: host ? ['--host', host] : [],
    // The script needs node, git and npm: the login shell's PATH, not the app's.
    env: {
      ...getLoginShellEnv(),
      ...(TEST_INSTALL_CONFIG && { XDG_CONFIG_HOME: TEST_INSTALL_CONFIG })
    },
    logDir: join(app.getPath('userData'), 'server-install'),
    onPhase: publishPhase
  })
  if (run.code !== 0) {
    publishPhase('failed')
    return installFailure(run.status, run.code, run.logPath)
  }
  const installed = readInstalledServer({ configDir: configDir(), name: SERVER_NAME })
  if (!installed) {
    publishPhase('failed')
    return { ok: false, code: 'unknown', exitCode: run.code, logPath: run.logPath }
  }
  try {
    const token = readIdentityToken(installed.dataDir)
    const existing = connectionFor(installed.url)
    const saved = await serverConnectionRegistry().save({
      ...(existing && { id: existing }),
      name: thisMacName(),
      url: installed.url,
      token
    })
    fleetConnectionsChanged()
    const state = await serviceState({
      url: installed.url,
      plistPath: plistPath(),
      probe: probeLive
    })
    publishPhase('done')
    return { ok: true, serverId: saved.id, url: saved.url, state }
  } catch {
    // The reason may sit next to the token (a malformed identity file), so
    // only a fixed sentence goes to the output; the window gets the code.
    console.error('[server-setup] The server was installed but could not be saved as a connection.')
    publishPhase('failed')
    return { ok: false, code: 'unknown', exitCode: run.code, logPath: run.logPath }
  }
}

let running: Promise<ServerInstallResult> | null = null

export function registerServerSetupHandlers(): void {
  ipcMain.handle('server-setup:scan', async (): Promise<TailnetScan> => {
    let status: TailscaleStatus | null
    try {
      status = await tailnetStatus()
    } catch {
      return { available: false, reason: 'failed' }
    }
    if (!status) return { available: false, reason: 'no-tailscale' }
    return scanTailnet({ status, port: TEST_SCAN_PORT ?? SERVER_PORT, probe: probeLive })
  })

  ipcMain.handle('server-setup:install-status', async (): Promise<ServerInstallStatus> => {
    const installed = readInstalledServer({ configDir: configDir(), name: SERVER_NAME })
    const url = installed?.url ?? null
    const [state, tailscaleIp] = await Promise.all([
      serviceState({ url, plistPath: plistPath(), probe: probeLive }),
      selfTailnetIp()
    ])
    return {
      installed: installed !== null,
      url,
      state,
      tailscaleIp,
      serverId: url ? connectionFor(url) : null
    }
  })

  ipcMain.handle('server-setup:install', (): Promise<ServerInstallResult> => {
    running ??= install().finally(() => {
      running = null
    })
    return running
  })

  ipcMain.handle('server-setup:copy-token', (): void => {
    const installed = readInstalledServer({ configDir: configDir(), name: SERVER_NAME })
    if (!installed) throw new Error('No server is installed on this Mac.')
    const token = readIdentityToken(installed.dataDir)
    if (TEST_NO_ACTIVATE) installE2eHooks({ serverSetup: { copiedToken: token } })
    else clipboard.writeText(token)
  })
}
