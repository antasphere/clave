/**
 * Fakes for the triage's unit tests: a separate-mode app with two windows,
 * a terminal and a chat session, their records, and secrets planted where a
 * leak would come from (the discovery tokens, the MCP token, a generated
 * title, provider conversation ids). Tests override what they need.
 */
import type { TriageSources } from './collect'

export const HOME = '/Users/tester'
export const USER_DATA = `${HOME}/Library/Application Support/Clave`
export const SHELL_TOKEN = 'shell-token-5f0c1d9e8b7a6f5e4d3c'
export const SERVER_TOKEN = 'server-token-0a1b2c3d4e5f6a7b8c9d'
export const MCP_TOKEN = 'mcp-token-9f8e7d6c5b4a39281706'
export const GENERATED_TITLE = 'Fix the payroll export for ACME before Friday'
export const CLAUDE_CONVERSATION = 'c1a2u3d4-e5f6-4789-8abc-def012345678'
export const CODEX_THREAD = 'thread_0123456789abcdef'

export const TERMINAL_ID = '11111111-1111-4111-8111-111111111111'
export const CHAT_ID = '22222222-2222-4222-8222-222222222222'

export function fakeSources(overrides: Partial<TriageSources> = {}): TriageSources {
  return {
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    origin: { instanceId: 'instance-1', shellPid: 725, windowId: 1, windowKey: 'win-a' },
    home: HOME,
    app: () => ({
      name: 'Clave',
      version: '2.4.0',
      packaged: true,
      electron: '38.0.0',
      chrome: '140.0.0',
      node: '22.0.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.6.0',
      uptimeSec: 120,
      flags: ['--server=separate'],
      paths: {
        userData: USER_DATA,
        logs: `${HOME}/Library/Logs/Clave`,
        crashDumps: `${USER_DATA}/Crashpad`
      }
    }),
    appVersion: '2.4.0',
    paths: {
      userData: USER_DATA,
      serverData: `${USER_DATA}/server`,
      mainLog: `${HOME}/Library/Logs/Clave/main.log`
    },
    shellDiscovery: async () => ({
      url: 'http://127.0.0.1:49457',
      token: SHELL_TOKEN,
      mode: 'separate',
      ok: true,
      pid: 725,
      clientId: 'client-1',
      serverPid: 1412
    }),
    serverDiscovery: async () => ({
      url: 'http://127.0.0.1:49457',
      token: SERVER_TOKEN,
      pid: 1412,
      terminalProcessPid: 1483,
      terminalProcessGeneration: 1,
      terminalProcessGivenUp: null
    }),
    endpoint: () => ({ url: 'http://127.0.0.1:49457', mode: 'attached' }),
    mcpRuntime: () => ({ url: 'http://127.0.0.1:51000/mcp', token: MCP_TOKEN }),
    isAlive: () => true,
    processes: async () => [{ pid: 725, type: 'Browser', cpuPercent: 1.5, memoryKb: 204800 }],
    health: async (_origin, path) => ({
      status: 200,
      body: path === '/health/ready' ? '{"terminals":true}' : 'ok'
    }),
    clients: async () => [
      { id: 'client-1', kind: 'shell', name: 'clave-shell 2.4.0', pid: 725, registeredAt: 1 }
    ],
    sessions: async () => [
      {
        id: TERMINAL_ID,
        provider: 'terminal',
        transport: 'pty',
        cwd: `${HOME}/code/app`,
        windowKey: 'win-a',
        state: 'idle',
        createdAt: 10,
        adapterId: 'pty',
        title: 'Release checklist'
      },
      {
        id: CHAT_ID,
        provider: 'claude',
        transport: 'events',
        cwd: `${HOME}/code/api`,
        windowKey: 'win-b',
        state: 'working',
        createdAt: 20,
        adapterId: 'claude-chat',
        title: GENERATED_TITLE
      }
    ],
    workspaces: () => [
      { id: 'ws-1', name: 'App', rootDir: `${HOME}/code/app` },
      { id: 'ws-2', name: 'Hidden API', rootDir: `${HOME}/code/api` }
    ],
    windows: () => [
      {
        id: 1,
        key: 'win-a',
        workspaceId: 'ws-1',
        isPrimary: true,
        focused: true,
        boundSessionIds: [TERMINAL_ID]
      },
      {
        id: 2,
        key: 'win-b',
        workspaceId: 'ws-2',
        isPrimary: false,
        focused: false,
        boundSessionIds: [CHAT_ID]
      }
    ],
    windowListings: async () => [
      {
        windowId: 1,
        ok: true,
        result: {
          sessions: [
            {
              id: TERMINAL_ID,
              name: 'Release checklist',
              mode: 'terminal',
              alive: true,
              agentState: null,
              groupId: 'g-1',
              workspaceId: 'ws-1',
              account: null
            }
          ],
          groups: [
            {
              id: 'g-1',
              name: 'Release',
              sessionIds: [TERMINAL_ID],
              workspaceId: 'ws-1',
              terminals: [],
              view: null
            }
          ]
        }
      },
      {
        windowId: 2,
        ok: true,
        result: {
          sessions: [
            {
              id: CHAT_ID,
              name: GENERATED_TITLE,
              mode: 'claude',
              alive: true,
              agentState: 'working',
              groupId: null,
              workspaceId: 'ws-2',
              account: { id: 'default', label: 'tester@example.com', exhausted: false }
            }
          ],
          groups: []
        }
      }
    ],
    records: async () => ({
      total: 2,
      files: [
        {
          key: `clave-${TERMINAL_ID}`,
          content: {
            id: TERMINAL_ID,
            tmuxName: `clave-${TERMINAL_ID}`,
            cwd: `${HOME}/code/app`,
            folderName: 'app',
            displayName: 'Release checklist',
            userRenamed: true,
            claudeMode: false,
            antigravityMode: false,
            codexMode: false,
            piMode: false,
            claudeAgentsMode: false,
            dangerousMode: false,
            windowKey: 'win-a',
            workspaceId: 'ws-1',
            view: {
              url: 'http://localhost:3000',
              command: 'API_KEY=sk-live-abcdefghijkl npm run dev'
            }
          }
        },
        {
          key: CHAT_ID,
          content: {
            id: CHAT_ID,
            transport: 'events',
            adapterId: 'claude-chat',
            claudeSessionId: CLAUDE_CONVERSATION,
            codexThreadId: CODEX_THREAD,
            cwd: `${HOME}/code/api`,
            folderName: 'api',
            displayName: GENERATED_TITLE,
            claudeMode: true,
            antigravityMode: false,
            codexMode: false,
            piMode: false,
            claudeAgentsMode: false,
            dangerousMode: false,
            windowKey: 'win-b',
            workspaceId: 'ws-2'
          }
        }
      ]
    }),
    tmuxSessions: async () => [`clave-${TERMINAL_ID}`],
    agents: () => ({
      supported: true,
      autoUpdate: true,
      busy: false,
      agents: [
        {
          id: 'claude',
          installed: true,
          currentVersion: '2.1.300',
          latestVersion: '2.1.300',
          lastCheckedAt: 5,
          path: `${HOME}/.local/bin/claude`,
          error: 'TOKEN=abc123456789'
        }
      ]
    }),
    neverRead: [`${USER_DATA}/clave-server.json`, `${USER_DATA}/mcp-configs`],
    ...overrides
  }
}
