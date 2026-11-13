/**
 * The triage's sources in the running app (issue #227): the wiring of
 * `TriageSources` onto main's own registries, files and clients. Every one
 * is a READ:
 *
 *  - the window registry and the workspace manager (main's memory);
 *  - the discovery files `clave-server.json` (the shell's, and the separate
 *    server's under `<userData>/server`), parsed here and their tokens
 *    dropped by the assembler;
 *  - the server, through the typed client: `sessions.list` and
 *    `clients.list` only. Never `sessions.listAdoptable`, whose listing
 *    prunes record files (`pty-backend.ts` `listAdoptableSessions`), and
 *    nothing that reads a screen, a history or a provider;
 *  - the server's open `/health/*` routes, with no token;
 *  - each window's renderer `list`, the same read `clave_list` makes;
 *  - the session record files, read here rather than through that listing;
 *  - `tmux -L clave list-sessions`, names only;
 *  - `app.getAppMetrics()` and the agent updater's cached state, which runs
 *    no CLI and asks no provider.
 */
import { app, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TriageApp, TriageOrigin, TriageProcess, TriageWindow } from '../../shared/triage'
import { windowRegistry } from '../window-registry'
import { workspaceManager } from '../workspace-manager'
import { getClaveServerEndpoint } from '../server/endpoint'
import { getMcpRuntime } from '../mcp/mcp-runtime'
import { serverClient } from '../mcp/server-client'
import { callRendererAll } from '../mcp/mcp-bridge'
import { agentUpdateManager } from '../agent-updates'
import { loginShellEnvAsync } from '../pty-manager'
import type { RawServerDiscovery, RawShellDiscovery, TriageSources } from './collect'
import { isPidAlive, modeFlags, readBoundedBody, readBoundedJson, readRecordFiles } from './files'

const APP_NAME = 'Clave'
const DISCOVERY_FILE = 'clave-server.json'
const SERVER_DATA_FOLDER = 'server'
const TMUX_SOCKET = 'clave'

const asObject = <T>(v: unknown): T | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : null

async function findTmux(): Promise<string | null> {
  const env = await loginShellEnvAsync().catch(() => ({}) as Record<string, string>)
  const dirs = [
    ...(env.PATH || process.env.PATH || '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin'
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'tmux')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

export async function listClaveTmuxSessions(timeoutMs: number): Promise<string[]> {
  if (process.platform === 'win32') return []
  const tmux = await findTmux()
  if (!tmux) throw new Error('tmux was not found on the login PATH')
  return new Promise((resolve, reject) => {
    execFile(
      tmux,
      ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // No server on the socket is no session, not a failure.
          if (/no server running|error connecting|No such file/i.test(String(stderr)))
            return resolve([])
          return reject(
            new Error(`tmux list-sessions failed (${String(stderr).trim() || error.message})`)
          )
        }
        resolve(
          String(stdout)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    )
  })
}

function appFacts(): TriageApp {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    uptimeSec: process.uptime(),
    flags: modeFlags(process.argv),
    paths: {
      userData: app.getPath('userData'),
      logs: app.getPath('logs'),
      crashDumps: app.getPath('crashDumps')
    }
  }
}

function processes(): TriageProcess[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    cpuPercent: m.cpu?.percentCPUUsage ?? 0,
    memoryKb: m.memory?.workingSetSize ?? 0
  }))
}

function windows(): TriageWindow[] {
  const focused = BrowserWindow.getFocusedWindow()?.id ?? null
  return windowRegistry.listWindows().map((w) => {
    const identity = windowRegistry.identityOf(w.id)
    return {
      id: w.id,
      key: identity?.windowKey ?? windowRegistry.getKeyForWindow(w.id),
      workspaceId: identity?.workspaceId ?? null,
      isPrimary: identity?.isPrimary ?? false,
      focused: focused === w.id,
      boundSessionIds: windowRegistry.getSessionsForWindow(w.id)
    }
  })
}

/** Files holding credentials, under the app's data and the server's. */
function neverRead(userData: string, serverData: string): string[] {
  const perDataDir = [
    DISCOVERY_FILE,
    'mcp-server.json',
    'mcp-configs',
    'claude-accounts-credentials.json',
    'codex-homes',
    'antasphere-account-client.json',
    'antasphere-account-session.json'
  ]
  return [
    ...perDataDir.map((f) => path.join(userData, f)),
    ...['Cookies', 'Local Storage', 'Session Storage', 'Trust Tokens'].map((f) =>
      path.join(userData, f)
    ),
    ...perDataDir.map((f) => path.join(serverData, f)),
    path.join(os.homedir(), '.codex', 'auth.json')
  ]
}

export function electronSources(origin: TriageOrigin): TriageSources {
  const userData = app.getPath('userData')
  const serverData = path.join(userData, SERVER_DATA_FOLDER)
  return {
    now: () => new Date(),
    origin,
    home: os.homedir(),
    app: appFacts,
    appVersion: app.getVersion(),
    paths: { userData, serverData, mainLog: path.join(app.getPath('logs'), 'main.log') },
    shellDiscovery: async () =>
      asObject<RawShellDiscovery>(readBoundedJson(path.join(userData, DISCOVERY_FILE))),
    serverDiscovery: async () =>
      asObject<RawServerDiscovery>(readBoundedJson(path.join(serverData, DISCOVERY_FILE))),
    endpoint: () => {
      const endpoint = getClaveServerEndpoint()
      return endpoint ? { url: endpoint.url, mode: endpoint.mode } : null
    },
    mcpRuntime: getMcpRuntime,
    isAlive: isPidAlive,
    processes: async () => processes(),
    health: async (serverOrigin, route) => {
      const response = await fetch(`${serverOrigin}${route}`, {
        signal: AbortSignal.timeout(2500)
      })
      return { status: response.status, body: await readBoundedBody(response) }
    },
    clients: async () => (await serverClient.api()).clients.list(),
    sessions: async () => (await serverClient.api()).sessions.list(),
    workspaces: () =>
      workspaceManager.getWorkspaces().map((w) => ({ id: w.id, name: w.name, rootDir: w.rootDir })),
    windows,
    windowListings: (timeoutMs) => callRendererAll('list', { workspace: 'all' }, timeoutMs),
    records: async (dir, max) => readRecordFiles(dir, max),
    tmuxSessions: () => listClaveTmuxSessions(2500),
    agents: () => agentUpdateManager.getState(),
    neverRead: neverRead(userData, serverData)
  }
}
