import { CHAT_PROFILE_IDS } from '../../shared/open-session-modes'
import { codexConnection } from '../../shared/connection'
import { asPoolRow } from '../routines/facts'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { InMemoryAll } from '@structure-ai/eventsourcing'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SessionHost } from '@clave/server'
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import { SidebarLayouts, memorySidebarStorage, noWindowsHost } from '@clave/server/sidebar-layouts'
import { PendingRequests } from '../../../packages/server/src/requests/service'
import { createAgentTokenStore } from '../sessions/agent-tokens'
import { executeSecretAction } from '../secret-actions'
import { builtInProfileFamily, startStandaloneMcp } from './standalone-mcp'
import { agentSessionFixtureCatalog } from './standalone-mcp.fixtures'
import { sanitizeForPaste } from '../../shared/paste-sanitize'
import { buildProvenanceHeader } from '../../shared/exchange-provenance'
import { sessionHandlers } from '../../../packages/server/src/sessions/handlers'
import { sidebarHandlers } from '../../../packages/server/src/sidebar/handlers'
import { SidebarLayoutsPort } from '../../../packages/server/src/sidebar/port'
import { ServerEvents } from '../../../packages/server/src/events'
import type { SessionHostService } from '@clave/server'
import { ArtefactsPort, type ArtefactsService } from '@clave/server'
import { ArtefactRefusal } from '../artefacts/service'
import type { HistoryConversation } from '@clave/contract/history'
import type { ServerConversations } from '../session-history/server-conversations'
// ── PRDCT-4485: the launch facts of the daemon's agent tools ──
import type { LaunchProfilePreferences } from '../../shared/agent-launch'
import type { AgentUpdateStatus } from '../../shared/agent-updates'
import type { InteractionMode } from '../../shared/harness'
import type { PoolUsageWindow } from '../../shared/account-pool'
import { usageSummaryOf } from '../../shared/usage-summary'
import type { ServedPoolAccount } from './served-core'
import { standaloneLaunchFacts } from './standalone-launch-facts'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
const payload = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> => {
  const content = result.content as Array<{ type: string; text?: string }>
  expect(content[0].type).toBe('text')
  return JSON.parse(content[0].text!)
}
async function fixture(options: { artefacts?: ArtefactsService } = {}): Promise<{
  requests: PendingRequests
  client: Client
  other: Client
  directory: string
  url: string
}> {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'mcp-'))
  closes.push(() => rm(directory, { force: true, recursive: true }))
  const tokens = createAgentTokenStore(join(directory, 'mcp-configs'))
  const requests = new PendingRequests()
  const mcp = await startStandaloneMcp({
    sessions: {
      ...SessionHost.none,
      get: (id) => ({
        id,
        cwd: directory,
        windowKey: 'server',
        provider: 'codex',
        adapterId: 'codex-chat',
        transport: 'events',
        state: 'working',
        createdAt: 1,
        title: 'MCP caller'
      }),
      list: () => []
    },
    requests,
    agentTools: tokens,
    ...(options.artefacts && { artefacts: options.artefacts }),
    executeSecret: async (action, value) => {
      const result = await executeSecretAction(action, value, { shell: '/bin/sh', env: {} })
      if (!result.ok) throw new Error('Action failed.')
    }
  })
  closes.push(() => mcp.close())
  tokens.announce(mcp.url)
  const clients: Client[] = []
  for (const id of ['caller', 'other']) {
    const file = tokens.mcpConfig.write(id)!
    const config = JSON.parse(await readFile(file, 'utf8'))
    const auth = config.mcpServers.clave.headers.Authorization
    const client = new Client({ name: 'isolated-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: auth } }
      })
    )
    closes.push(() => client.close())
    clients.push(client)
  }
  return { requests, client: clients[0], other: clients[1], directory, url: mcp.url }
}

describe('server-owned MCP without an Electron callback', () => {
  it('creates explicit approval and clarification work without a desktop and polls caller-scoped results', async () => {
    const { requests, client, other, url } = await fixture()
    const approval = payload(
      await client.callTool({
        name: 'clave_request_approval',
        arguments: { description: 'Run migration?' }
      })
    )
    expect(approval).toMatchObject({ status: 'pending', requestId: expect.any(String) })
    const question = payload(
      await client.callTool({
        name: 'clave_request_clarification',
        arguments: {
          description: 'Select a branch',
          questions: [{ question: 'Branch?', options: [{ label: 'dev' }] }]
        }
      })
    )
    expect(requests.snapshot().pending).toHaveLength(2)
    const foreign = await other.callTool({
      name: 'clave_request_result',
      arguments: { requestId: question.requestId }
    })
    expect(foreign.isError).toBe(true)
    await requests.resolve({
      requestId: approval.requestId as string,
      response: { type: 'permission', optionId: 'approve' }
    })
    await requests.resolve({
      requestId: question.requestId as string,
      response: { type: 'clarification', answers: { 'Branch?': 'dev' } }
    })
    expect(
      payload(
        await client.callTool({
          name: 'clave_request_result',
          arguments: { requestId: question.requestId }
        })
      )
    ).toMatchObject({ status: 'completed', response: { answers: { 'Branch?': 'dev' } } })
    expect(
      (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' }))
        .status
    ).toBe(401)
  }, 15_000)

  it('keeps secret work after MCP disconnection and executes only the first valid client answer', async () => {
    const { requests, client, other, directory } = await fixture()
    const file = join(directory, '.env')
    const result = payload(
      await client.callTool({
        name: 'clave_request_secret',
        arguments: {
          description: 'Store the integration token',
          action: { type: 'env-file', file, key: 'API_KEY' }
        }
      })
    )
    const requestId = result.requestId as string
    await client.close()
    expect(requests.snapshot().pending).toHaveLength(1)
    const secret = 'secret-that-must-not-be-replayed'
    const responses = await Promise.all(
      [secret, 'loser-secret'].map((value) =>
        requests.resolve({
          requestId,
          response: { type: 'secret', value }
        })
      )
    )
    expect(responses.map((r) => r.accepted)).toEqual([true, false])
    expect(await readFile(file, 'utf8')).toBe(`API_KEY=${secret}\n`)
    expect(requests.result(requestId, 'caller')).toEqual({ requestId, status: 'completed' })
    expect(JSON.stringify(requests.result(requestId, 'caller'))).not.toContain(secret)
    expect(
      (await other.callTool({ name: 'clave_secret_result', arguments: { requestId } })).isError
    ).toBe(true)
  }, 15_000)

  it('validates secret actions and never returns subprocess output', async () => {
    const { requests, client, directory } = await fixture()
    expect(
      (
        await client.callTool({
          name: 'clave_request_secret',
          arguments: {
            description: 'Invalid action',
            action: { type: 'run', cwd: directory, command: 'echo inline', envVar: 'SECRET' }
          }
        })
      ).isError
    ).toBe(true)
    expect(requests.snapshot().pending).toHaveLength(0)
    const result = payload(
      await client.callTool({
        name: 'clave_request_secret',
        arguments: {
          description: 'Run a reviewed command',
          action: {
            type: 'run',
            cwd: directory,
            command: 'printf "%s" "$SECRET"',
            envVar: 'SECRET'
          }
        }
      })
    )
    const requestId = result.requestId as string
    await requests.resolve({ requestId, response: { type: 'secret', value: 'output-sentinel' } })
    const polled = payload(
      await client.callTool({ name: 'clave_secret_result', arguments: { requestId } })
    )
    expect(polled).toEqual({ requestId, status: 'completed' })
    expect(JSON.stringify(polled)).not.toContain('output-sentinel')
  }, 15_000)
})

/** What a test sets of the server's launcher (PRDCT-4485). */
interface LaunchState {
  interactionMode: InteractionMode
  switchMode: 'propose' | 'automatic'
  /** The detection's rejection, when set. */
  detectFails: string | null
}
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const HOUR = 3_600_000
const win = (over: Partial<PoolUsageWindow> & { kind: string }): PoolUsageWindow => ({
  scope: null,
  usedPercentage: 0,
  severity: null,
  resetsAt: null,
  ...over
})
/** Two Claude subscriptions, the first one's Fable week spent; one Codex key. */
const CLAUDE_CONNECTIONS: ServedPoolAccount[] = [
  {
    id: 'default',
    label: 'Romain',
    usable: true,
    usage: usageSummaryOf({
      windows: [
        win({ kind: 'session', usedPercentage: 20, resetsAt: NOW + 2 * HOUR }),
        win({ kind: 'weekly_all', usedPercentage: 40, resetsAt: NOW + 50 * HOUR }),
        win({
          kind: 'weekly_scoped',
          scope: 'Fable',
          usedPercentage: 100,
          severity: 'critical',
          resetsAt: NOW + 72 * HOUR
        })
      ]
    })!
  },
  {
    id: 'work',
    label: 'Work',
    usable: true,
    usage: usageSummaryOf({
      windows: [
        win({ kind: 'weekly_all', usedPercentage: 10, resetsAt: NOW + 96 * HOUR }),
        win({
          kind: 'weekly_scoped',
          scope: 'Fable',
          usedPercentage: 30,
          resetsAt: NOW + 96 * HOUR
        })
      ]
    })!
  }
]
/** A Codex API key as the facts give it: lane P's Connection (a key that
 *  reports no usage) with the pool rule's view spread over it. */
const CODEX_CONNECTIONS: ServedPoolAccount[] = [
  asPoolRow(codexConnection({ id: 'key', label: 'API key', kind: 'apiKey', hasCredential: true }))
]
/** The server's profiles: its Codex chats on the person's own "yolo" (as
 *  the fixture's `chatDefault` says), and a Pi profile pinning a model. */
const LAUNCH_PREFS: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [
    { id: 'yolo', name: 'Yolo', family: 'codex', command: ['codex'], additionalArgs: ['--yolo'] },
    {
      id: 'chat:codex:yolo',
      name: 'Yolo (chat)',
      family: 'codex',
      command: ['codex'],
      additionalArgs: ['--yolo'],
      sourceProfileId: 'yolo'
    },
    {
      id: 'pi-kimi',
      name: 'Pi on Kimi',
      family: 'pi',
      command: ['pi'],
      additionalArgs: [],
      pi: { model: 'kimi-k2' }
    }
  ],
  globalDefaults: { codex: 'yolo' },
  workspaceOverrides: {}
}
const STATUSES = [
  { id: 'claude', installed: true, currentVersion: '3.1.0', lastCheckedAt: NOW - HOUR },
  { id: 'codex', installed: true, currentVersion: '0.80.0', lastCheckedAt: NOW - HOUR },
  { id: 'antigravity', installed: false, currentVersion: null, lastCheckedAt: NOW - HOUR },
  { id: 'pi', installed: true, currentVersion: '0.9.2', lastCheckedAt: NOW - HOUR },
  { id: 'opencode', installed: true, currentVersion: '2.0.1', lastCheckedAt: NOW - HOUR }
] as AgentUpdateStatus[]
function launchFake(state: LaunchState): ReturnType<typeof standaloneLaunchFacts> {
  return standaloneLaunchFacts({
    facts: {
      preferences: () => LAUNCH_PREFS,
      accounts: (pool) => (pool === 'codex' ? CODEX_CONNECTIONS : CLAUDE_CONNECTIONS),
      selectedAccountId: () => 'default'
    },
    detection: {
      detect: async () => {
        if (state.detectFails) throw new Error(state.detectFails)
        return STATUSES
      }
    },
    identity: () => ({ id: 'srv-1', name: 'build-box' }),
    preferences: (key) =>
      key === 'interactionMode'
        ? state.interactionMode
        : key === 'accountSwitchMode'
          ? state.switchMode
          : undefined,
    codexModels: async () => [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }],
    homeDir: '/home/me',
    defaultProfile: (family) => (family === 'codex' ? { id: 'yolo' } : { id: `builtin-${family}` }),
    now: () => NOW
  })
}

interface StartedCall {
  cwd: string
  windowKey?: string | undefined
  options?: Record<string, unknown> | undefined
}
/** A host that runs sessions the way the daemon's server-owned host does: a
 *  start lands in the server sidebar, a chat tab is ready at once and a
 *  terminal waits for its first size. */
async function sessionFixture(
  hooks: {
    duringStart?: (sidebar: SidebarLayouts) => void
    renameFails?: (id: string) => boolean
    /** The records this host keeps (PRDCT-4150: the caller's workspace is
     *  read from its record). Absent, the host keeps none and refuses the
     *  listing, as `SessionHost.none` does. */
    records?: SessionRecord[]
    /** Options laid over the fixture's own `startStandaloneMcp` call. */
    options?: Partial<Parameters<typeof startStandaloneMcp>[0]>
    /** Host methods laid over the fixture's own (PRDCT-4192: `type` and
     *  `restart` spies for the messaging tools). */
    host?: Partial<SessionHostService>
    /** What the server's launcher says, laid over the fixture's (PRDCT-4485). */
    launch?: Partial<LaunchState>
  } = {}
): Promise<{
  launchState: LaunchState
  client: Client
  /** A client holding the token of another tab of this server, as that
   *  tab's agent would call the tools. */
  connectAs: (id: string) => Promise<Client>
  started: StartedCall[]
  stopped: string[]
  resized: Array<[string, number, number]>
  sessions: Map<string, Session>
  sidebar: SidebarLayouts
  host: SessionHostService
  directory: string
}> {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'mcp-sessions-'))
  closes.push(() => rm(directory, { force: true, recursive: true }))
  const tokens = createAgentTokenStore(join(directory, 'mcp-configs'))
  const sidebar = new SidebarLayouts(memorySidebarStorage(), noWindowsHost, {
    layoutKey: SERVER_LAYOUT_KEY
  })
  const sessions = new Map<string, Session>()
  const caller: Session = {
    id: 'caller',
    cwd: directory,
    windowKey: SERVER_LAYOUT_KEY,
    provider: 'claude',
    adapterId: 'claude-chat',
    transport: 'events',
    state: 'working',
    createdAt: 1,
    title: 'Lane lead'
  }
  sessions.set(caller.id, caller)
  const launchState: LaunchState = {
    interactionMode: 'chat',
    switchMode: 'automatic',
    detectFails: null,
    ...hooks.launch
  }
  const started: StartedCall[] = []
  const stopped: string[] = []
  const resized: Array<[string, number, number]> = []
  let next = 0
  const host: SessionHostService = {
    ...SessionHost.none,
    ...(hooks.records
      ? {
          listAdoptableRecords: (ids?: ReadonlyArray<string>) =>
            hooks.records!.filter((r) => !ids || ids.includes(r.id))
        }
      : {}),
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    start: async (input) => {
      started.push(input as StartedCall)
      const options = input.options ?? {}
      const id = `started-${++next}`
      const chat = typeof options.launchProfileId === 'string'
      sessions.set(id, {
        id,
        cwd: input.cwd,
        windowKey: SERVER_LAYOUT_KEY,
        provider: options.codexMode ? 'codex' : options.claudeMode ? 'claude' : 'terminal',
        adapterId: chat ? String(options.launchProfileId) : 'pty',
        transport: chat ? 'events' : 'pty',
        state: 'idle',
        createdAt: 2,
        title: 'new tab'
      })
      sidebar.placeSession(SERVER_LAYOUT_KEY, id, null)
      hooks.duringStart?.(sidebar)
      return {
        id,
        cwd: input.cwd,
        folderName: 'repo',
        alive: true,
        claudeSessionId: null,
        piSessionId: null
      }
    },
    stop: async (id) => {
      stopped.push(id)
      sessions.delete(id)
    },
    rename: (id, name) => {
      if (hooks.renameFails?.(id)) throw new Error('rename refused by the host')
      const session = sessions.get(id)
      if (!session) throw new Error('Unknown session.')
      const renamed = { ...session, title: name }
      sessions.set(id, renamed)
      return renamed
    },
    resize: (id, cols, rows) => {
      resized.push([id, cols, rows])
    },
    ...hooks.host
  }
  const mcp = await startStandaloneMcp({
    sessions: host,
    sidebar,
    requests: new PendingRequests(),
    agentTools: tokens,
    executeSecret: async () => {},
    // This server's Codex chats run on the person's own profile; the chat
    // form of a custom profile is a profile of this server too.
    profileFamily: (id) =>
      builtInProfileFamily(id) ?? (id === 'chat:codex:yolo' || id === 'yolo' ? 'codex' : undefined),
    chatDefault: (family) => (family === 'codex' ? 'chat:codex:yolo' : undefined),
    launch: launchFake(launchState),
    ...hooks.options
  })
  closes.push(() => mcp.close())
  tokens.announce(mcp.url)
  const connectAs = async (id: string): Promise<Client> => {
    const file = tokens.mcpConfig.write(id)!
    const config = JSON.parse(await readFile(file, 'utf8'))
    const client = new Client({ name: 'session-tools-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: config.mcpServers.clave.headers.Authorization } }
      })
    )
    closes.push(() => client.close())
    return client
  }
  const client = await connectAs('caller')
  return {
    client,
    connectAs,
    started,
    stopped,
    resized,
    sessions,
    sidebar,
    host,
    directory,
    launchState
  }
}
const errorText = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  expect(result.isError).toBe(true)
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
}

describe('standalone MCP session tools', () => {
  it('opens a Codex chat tab with its model, name and prompt, linked to its caller', async () => {
    const { client, started, sessions, directory } = await sessionFixture()
    const opened = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: {
          cwd: directory,
          mode: 'codex',
          model: 'gpt-6.1-sol',
          name: 'Lane A verify | Codex',
          prompt: 'Read the brief and reply READY.'
        }
      })
    )
    expect(opened).toEqual({ sessionId: 'started-1', groupId: null, workspaceId: null })
    expect(started).toHaveLength(1)
    expect(started[0].cwd).toBe(directory)
    expect(started[0].options).toMatchObject({
      codexMode: true,
      claudeMode: false,
      dangerousMode: false,
      model: 'gpt-6.1-sol',
      // The chat the launcher would open on this server: its Codex default's
      // chat form, not the built-in one (the wave of 3 November 2026 got the
      // built-in and asked before every command).
      launchProfileId: 'chat:codex:yolo',
      initialPrompt: 'Read the brief and reply READY.'
    })
    expect(sessions.get('started-1')?.title).toBe('Lane A verify | Codex')
    const listed = payload(await client.callTool({ name: 'clave_list', arguments: {} }))
    const entry = (listed.sessions as Array<Record<string, unknown>>).find(
      (s) => s.id === 'started-1'
    )
    expect(entry).toMatchObject({ id: 'started-1', parentId: 'caller' })
    const self = (listed.sessions as Array<Record<string, unknown>>).find((s) => s.id === 'caller')
    expect(self?.parentId).toBeUndefined()
  }, 15_000)

  it.each([undefined, false, true])(
    'accepts attachToParent %s and keeps the messaging parent independently',
    async (attachToParent) => {
      const { client, started, directory } = await sessionFixture()
      const opened = payload(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'codex', attachToParent }
        })
      )
      if (attachToParent === true) expect(started[0].options?.spawnedBy).toBe('caller')
      else expect(started[0].options).not.toHaveProperty('spawnedBy')
      // The opener rides on the record whether the tab nests or not
      // (PRDCT-4192): it is what "parent" and the reach rule read once this
      // server restarted and the in-memory map is gone.
      expect(started[0].options?.openedBy).toBe('caller')
      expect(opened).toHaveProperty('workspaceId', null)
      const listed = payload(await client.callTool({ name: 'clave_list', arguments: {} }))
        .sessions as Array<Record<string, unknown>>
      expect(listed.find((s) => s.id === opened.sessionId)?.parentId).toBe('caller')
    },
    15_000
  )

  /**
   * PRDCT-4236: `resume` on this server, which keeps no History of its own.
   * A tab that runs the conversation is answered as it is; a stopped tab that
   * holds it is resumed in place; a conversation nobody holds starts a new
   * tab on the id in the directory the caller names, and needs that
   * directory; a terminal cannot continue a conversation.
   */
  it('resume: a live holder answered, a stopped holder resumed in place, else a start on the id', async () => {
    const restarted: Array<[string, unknown, boolean | undefined, boolean | undefined]> = []
    const { client, started, directory } = await sessionFixture({
      records: [
        {
          id: 'caller',
          cwd: '/srv/repo',
          folderName: 'repo',
          claudeMode: true,
          antigravityMode: false,
          codexMode: false,
          piMode: false,
          claudeAgentsMode: false,
          dangerousMode: false,
          claudeSessionId: 'conv-live',
          running: true,
          workspaceId: 'ws-studio'
        },
        {
          id: 'old',
          cwd: '/srv/repo',
          folderName: 'repo',
          claudeMode: true,
          antigravityMode: false,
          codexMode: false,
          piMode: false,
          claudeAgentsMode: false,
          dangerousMode: false,
          claudeSessionId: 'conv-old',
          running: false
        }
      ],
      host: {
        restart: async (id, account, resendRejected, onlyIfStopped) => {
          restarted.push([id, account, resendRejected, onlyIfStopped])
          return { id, alive: true, resumed: true } as never
        }
      }
    })
    const live = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-live' } })
    )
    expect(live).toMatchObject({
      sessionId: 'caller',
      alreadyOpen: true,
      resumed: false,
      workspaceId: 'ws-studio',
      conversation: 'conv-live'
    })
    expect(live).not.toHaveProperty('warnings')
    // What the call asks of the launch is said not applied to a live tab.
    const asked = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { resume: 'conv-live', account: 'Work', permissionMode: 'plan', effort: 'high' }
      })
    )
    expect(asked).toMatchObject({ sessionId: 'caller', alreadyOpen: true, resumed: false })
    expect(asked.warnings).toEqual([
      'account, permissionMode, effort not applied: the conversation is already open in tab caller'
    ])
    const effortOnly = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { resume: 'conv-live', effort: 'low' }
      })
    )
    expect(effortOnly.warnings).toEqual([
      'effort not applied: the conversation is already open in tab caller'
    ])
    expect(restarted).toEqual([])
    expect(started).toHaveLength(0)
    const stopped = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-old' } })
    )
    expect(stopped).toMatchObject({ sessionId: 'old', alreadyOpen: true, resumed: true })
    expect(restarted).toEqual([['old', {}, false, true]])
    expect(started).toHaveLength(0)
    const fresh = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { resume: 'conv-new', cwd: directory, name: 'Odoo again' }
      })
    )
    expect(fresh.sessionId).toBe('started-1')
    expect(started).toHaveLength(1)
    expect(started[0].options).toMatchObject({ claudeMode: true, resumeSessionId: 'conv-new' })
    expect(
      errorText(
        await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-new' } })
      )
    ).toContain(
      "cwd is required unless resume names a conversation this server's History remembers or a tab of this server still holds."
    )
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { resume: 'conv-new', cwd: directory, mode: 'terminal' }
        })
      )
    ).toContain('pass an agent mode, not terminal')
    expect(started).toHaveLength(1)
  }, 15_000)

  /** The caller's record, as the daemon keeps it, with or without a workspace. */
  const callerRecord = (workspaceId?: string): SessionRecord => ({
    id: 'caller',
    cwd: '/srv/repo',
    folderName: 'repo',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    ...(workspaceId !== undefined ? { workspaceId } : {})
  })

  it("stamps the new tab with its caller's workspace, read from the caller's record (PRDCT-4150)", async () => {
    const { client, started, directory } = await sessionFixture({
      records: [callerRecord('ws-studio')]
    })
    const opened = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex', name: 'Verifier' }
      })
    )
    expect(started).toHaveLength(1)
    expect(started[0].options?.workspaceId).toBe('ws-studio')
    // The answer says where the tab landed (PRDCT-4193).
    expect(opened.workspaceId).toBe('ws-studio')
    // The agent inherits, it never picks: the desktop's argument stays refused.
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, workspace: 'ws-other' }
        })
      )
    ).toContain('workspace')
    expect(started).toHaveLength(1)
  }, 15_000)

  it.each([
    ['a caller whose record carries no workspace', [callerRecord()]],
    ['a host that keeps no records', undefined]
  ])(
    'leaves the new tab unstamped for %s',
    async (_case, records) => {
      const { client, started, directory } = await sessionFixture({
        ...(records ? { records } : {})
      })
      payload(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'codex' }
        })
      )
      expect(started).toHaveLength(1)
      expect(started[0].options).not.toHaveProperty('workspaceId')
    },
    15_000
  )

  it('rejects a non-boolean attachment before starting a session', async () => {
    const { client, started, directory } = await sessionFixture()
    errorText(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, attachToParent: 'true' }
      })
    )
    expect(started).toHaveLength(0)
  }, 15_000)

  it('opens a terminal tab with its command and gives it a first size so the process starts', async () => {
    const { client, started, resized, directory } = await sessionFixture()
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'terminal', command: 'ls' }
      })
    )
    expect(started[0].options).toMatchObject({
      claudeMode: false,
      codexMode: false,
      initialCommand: 'ls',
      autoExecute: true
    })
    expect(started[0].options?.launchProfileId).toBeUndefined()
    expect(resized).toEqual([['started-1', 120, 30]])
  }, 15_000)

  it('opens the built-in chat when the server names no chat default for the family', async () => {
    // A caller with no launch facts: the server's `chatDefault` decides.
    const { client, started, directory } = await sessionFixture({
      options: { chatDefault: () => undefined, launch: undefined }
    })
    await client.callTool({
      name: 'clave_open_session',
      arguments: { cwd: directory, mode: 'codex', name: 'Plain chat' }
    })
    expect(started[0].options).toMatchObject({ codexMode: true, launchProfileId: 'codex-chat' })
    await client.callTool({
      name: 'clave_open_session',
      arguments: { cwd: directory, mode: 'codex', chat: true, profile: 'codex-chat' }
    })
    expect(started[1].options).toMatchObject({ launchProfileId: 'codex-chat' })
  })
  it('opens a Claude terminal instead of the chat view with chat: false', async () => {
    const { client, started, resized, directory } = await sessionFixture()
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, chat: false, dangerous: true }
      })
    )
    expect(started[0].options).toMatchObject({ claudeMode: true, dangerousMode: true })
    expect(started[0].options?.launchProfileId).toBeUndefined()
    expect(resized).toEqual([['started-1', 120, 30]])
  }, 15_000)

  it('rejects a relative or missing directory, an unknown mode and desktop-only arguments without starting anything', async () => {
    // A caller of old, with no launch facts: `account` stays refused as before (PRDCT-4485).
    const { client, started, directory } = await sessionFixture({ options: { launch: undefined } })
    expect(
      errorText(
        await client.callTool({ name: 'clave_open_session', arguments: { cwd: 'relative/dir' } })
      )
    ).toContain('absolute')
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: join(directory, 'missing') }
        })
      )
    ).toContain('no such directory')
    errorText(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'emacs' }
      })
    )
    for (const extra of [{ account: 'Work' }, { window: 2 }, { workspace: 'Main' }]) {
      expect(
        errorText(
          await client.callTool({
            name: 'clave_open_session',
            arguments: { cwd: directory, ...extra }
          })
        )
      ).toContain('standalone server')
    }
    expect(started).toHaveLength(0)
  }, 15_000)

  it('closes and renames sessions, resolving "mine" to the caller and refusing an unknown id', async () => {
    const { client, stopped, sessions, directory } = await sessionFixture()
    const { sessionId } = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { cwd: directory } })
    )
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: sessionId, name: 'Verifier' }
      })
    )
    expect(sessions.get(sessionId as string)?.title).toBe('Verifier')
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: 'mine', name: 'Lane lead | Claude' }
      })
    )
    expect(sessions.get('caller')?.title).toBe('Lane lead | Claude')
    errorText(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: 'nope', name: 'x' }
      })
    )
    payload(await client.callTool({ name: 'clave_close_session', arguments: { sessionId } }))
    expect(stopped).toEqual([sessionId])
    expect(
      errorText(
        await client.callTool({ name: 'clave_close_session', arguments: { sessionId: 'nope' } })
      )
    ).toContain('Unknown session')
    expect(stopped).toEqual([sessionId])
  }, 15_000)

  it('creates a group, opens a tab in it, moves another into it and refuses an unknown group', async () => {
    const { client, started, sidebar, directory } = await sessionFixture()
    const { groupId } = payload(
      await client.callTool({ name: 'clave_create_group', arguments: { name: 'Lane lll-1026' } })
    )
    expect(groupId).toEqual(expect.any(String))
    const inGroup = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex', groupId }
      })
    )
    expect(inGroup.groupId).toBe(groupId)
    const loose = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { cwd: directory } })
    )
    payload(
      await client.callTool({
        name: 'clave_move_session',
        arguments: { sessionId: loose.sessionId, groupId }
      })
    )
    const group = sidebar.get(SERVER_LAYOUT_KEY).groups.find((g) => g.id === groupId)
    expect(group?.name).toBe('Lane lll-1026')
    expect([...(group?.sessionIds ?? [])].sort()).toEqual(
      [inGroup.sessionId, loose.sessionId].sort()
    )
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'group', id: groupId, name: 'Lane C' }
      })
    )
    expect(sidebar.get(SERVER_LAYOUT_KEY).groups.find((g) => g.id === groupId)?.name).toBe('Lane C')
    const before = started.length
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, groupId: 'no-such-group' }
        })
      )
    ).toContain('Unknown group')
    expect(started).toHaveLength(before)
    errorText(
      await client.callTool({
        name: 'clave_move_session',
        arguments: { sessionId: loose.sessionId, groupId: 'no-such-group' }
      })
    )
  }, 15_000)
})

describe('standalone MCP session tools: boundaries', () => {
  it('closes the calling tab with "mine"', async () => {
    const { client, stopped } = await sessionFixture()
    payload(
      await client.callTool({ name: 'clave_close_session', arguments: { sessionId: 'mine' } })
    )
    expect(stopped).toEqual(['caller'])
  }, 15_000)

  it('passes dangerous: true to a Codex agent and keeps it off by default', async () => {
    const { client, started, directory } = await sessionFixture()
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex', dangerous: true }
      })
    )
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex' }
      })
    )
    expect(started.map((s) => s.options?.dangerousMode)).toEqual([true, false])
    expect(started.map((s) => s.options?.codexMode)).toEqual([true, true])
  }, 15_000)

  it('refuses a profile from another family, an unknown profile and a profile on a terminal before starting', async () => {
    const { client, started, directory } = await sessionFixture()
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'claude', profile: 'codex-chat' }
        })
      )
      // Resolved as a routine is (PRDCT-4485): the family's profiles, named.
    ).toContain('launch profile "codex-chat" is not a claude profile here ("Claude")')
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'codex', profile: 'claude-chat' }
        })
      )
    ).toContain('launch profile "claude-chat" is not a codex profile here')
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'terminal', profile: 'codex-chat', command: 'ls' }
        })
      )
    ).toContain('agent modes only')
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'claude', profile: 'no-such-profile' }
        })
      )
    ).toContain('launch profile "no-such-profile" is not a claude profile here')
    expect(started).toHaveLength(0)
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'claude', profile: 'claude-chat' }
      })
    )
    expect(started[0].options).toMatchObject({ claudeMode: true, launchProfileId: 'claude-chat' })
    for (const [mode, profile] of [
      ['claude', 'builtin-claude'],
      ['codex', 'builtin-codex'],
      ['pi', 'builtin-pi']
    ]) {
      payload(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode, profile, chat: false }
        })
      )
      expect(started.at(-1)?.options?.launchProfileId).toBe(profile)
    }
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, mode: 'claude', profile: 'builtin-codex', chat: false }
        })
      )
    ).toContain('launch profile "builtin-codex" is not a claude profile here ("Claude")')
  }, 15_000)

  it('reports a group deleted while the tab starts instead of claiming the placement', async () => {
    let groupId = ''
    const { client, sidebar, directory } = await sessionFixture({
      duringStart: (layouts) => {
        if (groupId) layouts.deleteGroup(SERVER_LAYOUT_KEY, groupId, 'dissolve')
      }
    })
    groupId = payload(
      await client.callTool({ name: 'clave_create_group', arguments: { name: 'Vanishing' } })
    ).groupId as string
    const opened = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { cwd: directory, groupId } })
    )
    expect(opened).toMatchObject({ sessionId: 'started-1', groupId: null })
    expect(opened.warnings).toEqual([
      `Group "${groupId}" no longer exists; the tab is at the top level.`
    ])
    const layout = sidebar.get(SERVER_LAYOUT_KEY)
    expect(layout.groups).toEqual([])
    expect(layout.displayOrder).toContain('started-1')
  }, 15_000)

  it('names the started tab when a step after the start fails', async () => {
    const { client, sessions, directory } = await sessionFixture({
      renameFails: (id) => id.startsWith('started-')
    })
    const opened = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex', name: 'Verifier' }
      })
    )
    expect(opened.sessionId).toBe('started-1')
    expect(opened.warnings).toEqual([
      'The tab started but was not renamed: rename refused by the host'
    ])
    expect(sessions.has('started-1')).toBe(true)
  }, 15_000)
})

/** A tab of the server-owned host, idle unless said otherwise. */
const tab = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  cwd: '/srv/repo',
  windowKey: SERVER_LAYOUT_KEY,
  provider: 'codex',
  adapterId: 'codex-chat',
  transport: 'events',
  state: 'idle',
  createdAt: 3,
  title: id,
  ...over
})
/** A record as the daemon keeps it, a Codex chat unless said otherwise. */
const record = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  cwd: '/srv/repo',
  folderName: 'repo',
  claudeMode: false,
  antigravityMode: false,
  codexMode: true,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  ...over
})
/** `type` and `restart` spies over the fixture's sessions, in call order. */
function messagingHost(): {
  calls: string[]
  typed: Array<[string, string]>
  restarted: Array<[string, unknown, boolean, boolean | undefined]>
  bind: (sessions: Map<string, Session>) => Partial<SessionHostService>
} {
  const calls: string[] = []
  const typed: Array<[string, string]> = []
  const restarted: Array<[string, unknown, boolean, boolean | undefined]> = []
  return {
    calls,
    typed,
    restarted,
    bind: (sessions) => ({
      type: async (id, text) => {
        calls.push(`type:${id}`)
        typed.push([id, text])
        return { submitted: true, draftHandling: 'none' }
      },
      restart: async (id, account, resendRejected, onlyIfStopped) => {
        calls.push(`restart:${id}`)
        restarted.push([id, account, resendRejected, onlyIfStopped])
        const session = sessions.get(id)
        if (session) sessions.set(id, { ...session, state: 'idle' })
        return {
          id,
          cwd: '/srv/repo',
          folderName: 'repo',
          alive: true,
          claudeSessionId: null,
          piSessionId: null,
          resumed: true
        }
      }
    })
  }
}
/** The fixture with the messaging spies bound to its own sessions map. */
async function messagingFixture(
  hooks: Parameters<typeof sessionFixture>[0] = {}
): Promise<Awaited<ReturnType<typeof sessionFixture>> & ReturnType<typeof messagingHost>> {
  const spies = messagingHost()
  const bound: { sessions?: Map<string, Session> } = {}
  const lazy: Partial<SessionHostService> = {
    type: (id, text) => spies.bind(bound.sessions!).type!(id, text),
    restart: (id, account, resend, onlyIfStopped) =>
      spies.bind(bound.sessions!).restart!(id, account, resend, onlyIfStopped)
  }
  const fx = await sessionFixture({ ...hooks, host: { ...hooks.host, ...lazy } })
  bound.sessions = fx.sessions
  return { ...fx, ...spies }
}

// PRDCT-4192: the daemon's agent tools resolve and reach a tab by the same
// rule as the desktop's (`session-targets.ts`). Before it, "mine" typed the
// caller's own checkpoint into its input as its next instruction, "parent"
// was not understood and nothing kept a lane from typing into a terminal.
describe('standalone MCP messaging: the shared target rule (PRDCT-4192)', () => {
  it('takes a send to "mine" or to its own id as a checkpoint, typed nowhere and not logged', async () => {
    const { client, typed } = await messagingFixture()
    for (const ref of ['mine', 'caller']) {
      expect(
        payload(
          await client.callTool({
            name: 'clave_send_to_session',
            arguments: { sessionId: ref, message: 'Checkpoint: slice 1 green.' }
          })
        )
      ).toMatchObject({
        checkpoint: true,
        // This server keeps no exchange record, and says so.
        logged: false,
        delivered: false,
        sessionId: 'caller',
        name: 'Lane lead'
      })
    }
    expect(typed).toEqual([])
  }, 15_000)

  it('delivers to "parent" from the in-memory map, under the provenance header', async () => {
    const { client, connectAs, typed, directory } = await messagingFixture()
    const { sessionId } = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex' }
      })
    )
    const child = await connectAs(sessionId as string)
    const answer = payload(
      await child.callTool({
        name: 'clave_send_to_session',
        arguments: { sessionId: 'parent', message: 'LANE DONE' }
      })
    )
    expect(answer).toMatchObject({ delivered: true, sessionId: 'caller', name: 'Lane lead' })
    expect(typed).toEqual([
      [
        'caller',
        `${sanitizeForPaste(buildProvenanceHeader({ id: sessionId as string, name: 'new tab' }))}\nLANE DONE`
      ]
    ])
  }, 15_000)

  it("reads the opener from the record once the listener's map is empty (a restart of this server)", async () => {
    // A fresh listener: nothing was opened through it, so only the record
    // can say who opened `child`.
    const { client, connectAs, sessions, typed } = await messagingFixture({
      records: [record('child', { openedBy: 'caller' })]
    })
    sessions.set('child', tab('child'))
    const listed = payload(await client.callTool({ name: 'clave_list', arguments: {} }))
      .sessions as Array<Record<string, unknown>>
    expect(listed.find((s) => s.id === 'child')?.parentId).toBe('caller')
    const child = await connectAs('child')
    expect(
      payload(
        await child.callTool({
          name: 'clave_send_to_session',
          arguments: { sessionId: 'parent', message: 'back' }
        })
      )
    ).toMatchObject({ delivered: true, sessionId: 'caller' })
    expect(typed.map(([id]) => id)).toEqual(['caller'])
  }, 15_000)

  it('refuses a plain terminal it opened, typing nothing, and messages a tab it is not related to', async () => {
    const { client, sessions, typed, directory } = await messagingFixture()
    const terminal = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'terminal' }
      })
    )
    expect(
      errorText(
        await client.callTool({
          name: 'clave_send_to_session',
          arguments: { sessionId: terminal.sessionId, message: 'rm -rf /' }
        })
      )
    ).toContain('Refusing to send to a plain terminal')
    expect(typed).toEqual([])
    // PRDCT-4236: any tab of this server can be messaged, related or not.
    sessions.set('stranger', tab('stranger'))
    expect(
      payload(
        await client.callTool({
          name: 'clave_send_to_session',
          arguments: { sessionId: 'stranger', message: 'hello' }
        })
      )
    ).toMatchObject({ delivered: true, sessionId: 'stranger' })
    expect(typed.map(([id]) => id)).toEqual(['stranger'])
    expect(typed[0]?.[1]).toMatch(/\nhello$/)
  }, 15_000)

  it('resumes a stopped tab it opened with clave_resume_session and refuses a running one', async () => {
    const { client, sessions, restarted, directory } = await messagingFixture({
      records: [record('child', { openedBy: 'caller' })]
    })
    sessions.set('child', tab('child', { state: 'ended' }))
    expect(
      payload(
        await client.callTool({ name: 'clave_resume_session', arguments: { sessionId: 'child' } })
      )
    ).toEqual({
      resumed: true,
      sessionId: 'child',
      name: 'repo',
      mode: 'codex',
      alive: true,
      conversation: true
    })
    // The same tab, same account, no rejected message to send again.
    // A Resume, not a move: the host is told to refuse a running session.
    expect(restarted).toEqual([['child', {}, false, true]])
    const running = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex' }
      })
    )
    expect(
      errorText(
        await client.callTool({
          name: 'clave_resume_session',
          arguments: { sessionId: running.sessionId }
        })
      )
    ).toContain('Session "new tab" is running; there is nothing to resume.')
    expect(restarted).toHaveLength(1)
  }, 15_000)

  it('refuses a send to an ended tab with the way back, and with resume: true restarts it then types', async () => {
    const { client, sessions, calls, restarted } = await messagingFixture({
      records: [record('child', { openedBy: 'caller', displayName: 'Lane B' })]
    })
    sessions.set('child', tab('child', { state: 'ended' }))
    expect(
      errorText(
        await client.callTool({
          name: 'clave_send_to_session',
          arguments: { sessionId: 'child', message: 'continue' }
        })
      )
    ).toContain(
      'Session "Lane B" has ended; resume it with clave_resume_session, or pass resume: true to resume it and deliver.'
    )
    // Never a silent restart.
    expect(calls).toEqual([])
    expect(
      payload(
        await client.callTool({
          name: 'clave_send_to_session',
          arguments: { sessionId: 'Lane B', message: 'continue', resume: true }
        })
      )
    ).toMatchObject({ delivered: true, sessionId: 'child', name: 'Lane B' })
    expect(calls).toEqual(['restart:child', 'type:child'])
    // A Resume, not a move: the host is told to refuse a running session.
    expect(restarted).toEqual([['child', {}, false, true]])
  }, 15_000)
})

describe('agent-sessions/delegation-group fixture', () => {
  it('loads the scenario through the commands, then an agent organises and delegates into it', async () => {
    const { client, sidebar, host, sessions, started, stopped, directory } = await sessionFixture()
    const groupName = `Delegation ${randomUUID().slice(0, 8)}`
    const fixtures = await Effect.runPromise(
      agentSessionFixtureCatalog.prepare('agent-sessions/delegation-group', {
        cwd: directory,
        groupName
      })
    )
    const layer = buses.pipe(
      Layer.provide(HandlerRegistry.layer(...sidebarHandlers, ...sessionHandlers)),
      Layer.provide(SidebarLayoutsPort.layer(sidebar)),
      Layer.provide(SessionHost.layer(host)),
      Layer.provide(ServerEvents.layer('fixture-server').pipe(Layer.provide(InMemoryAll)))
    )
    const report = await Effect.runPromise(
      (
        run({ fixtures, enabled: true, ready: () => Effect.void }) as Effect.Effect<
          RunReport<Readonly<Record<string, unknown>>>,
          FixtureError,
          CommandBus
        >
      ).pipe(Effect.provide(layer))
    )
    expect(report.completed).toEqual(['agent-sessions/group', 'agent-sessions/tab'])
    const groupId = (report.values.group as { group: { id: string } }).group.id
    const tabId = (report.values.tab as { id: string }).id
    expect(sidebar.get(SERVER_LAYOUT_KEY).groups.map((g) => g.name)).toEqual([groupName])

    payload(
      await client.callTool({
        name: 'clave_move_session',
        arguments: { sessionId: tabId, groupId }
      })
    )
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: tabId, name: 'Dev server' }
      })
    )
    const delegated = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: {
          cwd: directory,
          mode: 'codex',
          name: 'Verifier',
          groupId,
          attachToParent: true
        }
      })
    )
    const lane = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: {
          cwd: directory,
          mode: 'codex',
          name: 'Lane lead',
          groupId,
          attachToParent: false
        }
      })
    )
    expect(started.find((s) => s.options?.spawnedBy === 'caller')).toBeDefined()
    expect(started.at(-1)?.options).not.toHaveProperty('spawnedBy')
    expect(delegated.groupId).toBe(groupId)
    const listed = payload(await client.callTool({ name: 'clave_list', arguments: {} }))
      .sessions as Array<Record<string, unknown>>
    expect(listed.find((s) => s.id === delegated.sessionId)).toMatchObject({
      parentId: 'caller',
      title: 'Verifier'
    })
    expect(listed.find((s) => s.id === lane.sessionId)).toMatchObject({
      parentId: 'caller',
      title: 'Lane lead'
    })
    expect(listed.find((s) => s.id === tabId)).toMatchObject({ title: 'Dev server' })
    expect(listed.find((s) => s.id === tabId)?.parentId).toBeUndefined()
    expect(
      [
        ...(sidebar.get(SERVER_LAYOUT_KEY).groups.find((g) => g.id === groupId)?.sessionIds ?? [])
      ].sort()
    ).toEqual([tabId, delegated.sessionId, lane.sessionId].sort())

    // The receipt outlives the test's scratch data, as the other fixtures' do.
    const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
    const data = await mkdtemp(join(scratch, 'fixture-sessions-'))
    const receipt = {
      scenario: 'agent-sessions/delegation-group',
      runId: report.runId,
      completed: report.completed,
      groupId,
      tabId,
      delegatedId: delegated.sessionId,
      separateLaneId: lane.sessionId,
      target: 'isolated standalone MCP over the server commands',
      data
    }
    await writeFile(join(data, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    // Cleanup is explicit and scoped to this run's tabs.
    for (const id of [delegated.sessionId, lane.sessionId, tabId])
      payload(await client.callTool({ name: 'clave_close_session', arguments: { sessionId: id } }))
    expect(stopped).toEqual([delegated.sessionId, lane.sessionId, tabId])
    expect(sessions.has(tabId)).toBe(false)
  }, 15_000)
})

describe('standalone MCP: a read of any tab, and a stopped terminal asked to resume (round 1, C1 and C4)', () => {
  it('reads a tab the caller is not related to (PRDCT-4236)', async () => {
    const read: string[] = []
    const { client, sessions } = await messagingFixture({
      host: {
        history: (id) => {
          read.push(id)
          return { items: [], before: null }
        }
      }
    })
    sessions.set('stranger', tab('stranger'))
    const answer = await client.callTool({
      name: 'clave_read_session',
      arguments: { sessionId: 'stranger' }
    })
    expect(answer.isError).not.toBe(true)
    expect(payload(answer)).toMatchObject({ sessionId: 'stranger', history: [] })
    expect(read).toEqual(['stranger'])
  }, 15_000)

  it('refuses a stopped plain terminal it opened even with resume: true, and restarts nothing', async () => {
    const { client, sessions, restarted, typed } = await messagingFixture({
      records: [
        record('term', {
          openedBy: 'caller',
          codexMode: false,
          claudeMode: false
        })
      ]
    })
    sessions.set('term', tab('term', { state: 'ended', provider: 'terminal', transport: 'pty' }))
    const answer = await client.callTool({
      name: 'clave_send_to_session',
      arguments: { sessionId: 'term', message: 'echo hi', resume: true }
    })
    expect(answer.isError).toBe(true)
    expect(errorText(answer)).toContain('Refusing to send to a plain terminal')
    expect(restarted).toEqual([])
    expect(typed).toEqual([])
  }, 15_000)
})

/**
 * PRDCT-4321: this server's own History. A resume of a conversation it
 * remembers, its tab deleted, finds its folder, its model and its bypass
 * there; the caller's own values win; a conversation whose transcript is gone
 * is not remembered. `clave_history` lists what the server's tabs ran.
 */
describe('standalone MCP and the server’s own History (PRDCT-4321)', () => {
  const remembered = (
    over: Partial<HistoryConversation> & { conversationId: string }
  ): HistoryConversation => ({
    sessionId: 'deleted-tab',
    name: 'Odoo research',
    title: 'Odoo accounting',
    cwd: '/srv/odoo',
    model: 'opus',
    groupId: null,
    groupName: null,
    workspaceId: null,
    firstSeenAt: '2026-11-01T10:00:00.000Z',
    lastHumanAt: '2026-11-09T10:00:00.000Z',
    lastPrompt: null,
    transcript: 'present',
    held: 'closed',
    ...over
  })
  const history = (conversations: HistoryConversation[]): ServerConversations => ({
    observe: () => {},
    closing: () => {},
    list: () => ({ conversations }),
    search: async () => ({ hits: [], filesSearched: 0, truncated: false })
  })
  /** A folder of this server's disk the remembered conversation ran in. */
  const folder = async (): Promise<string> => {
    const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
    await mkdir(scratch, { recursive: true })
    const dir = await mkdtemp(join(scratch, 'mcp-history-'))
    closes.push(() => rm(dir, { force: true, recursive: true }))
    return dir
  }

  it('resumes a remembered conversation in its own folder, on its model, in bypass', async () => {
    const cwd = await folder()
    const { client, started } = await sessionFixture({
      options: {
        conversations: history([
          remembered({ conversationId: 'conv-old', cwd, launch: { dangerous: true } })
        ])
      }
    })
    payload(
      await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-old' } })
    )
    expect(started).toHaveLength(1)
    expect(started[0].cwd).toBe(cwd)
    expect(started[0].options).toMatchObject({
      claudeMode: true,
      model: 'opus',
      dangerousMode: true,
      resumeSessionId: 'conv-old'
    })
  }, 15_000)

  it('reopens a remembered conversation on the profile it ran on (its chat view)', async () => {
    const cwd = await folder()
    const { client, started } = await sessionFixture({
      options: {
        conversations: history([
          remembered({ conversationId: 'conv-old', cwd, launchProfileId: CHAT_PROFILE_IDS.claude })
        ])
      }
    })
    payload(
      await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-old' } })
    )
    expect(started[0].options).toMatchObject({
      launchProfileId: CHAT_PROFILE_IDS.claude,
      resumeSessionId: 'conv-old'
    })
  }, 15_000)

  it('lets the call’s own cwd, model and dangerous: false win over the History', async () => {
    const cwd = await folder()
    const { client, started, directory } = await sessionFixture({
      options: {
        conversations: history([
          remembered({ conversationId: 'conv-old', cwd, launch: { dangerous: true } })
        ])
      }
    })
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { resume: 'conv-old', cwd: directory, model: 'sonnet', dangerous: false }
      })
    )
    expect(started).toHaveLength(1)
    expect(started[0].cwd).toBe(directory)
    expect(started[0].options).toMatchObject({
      model: 'sonnet',
      dangerousMode: false,
      resumeSessionId: 'conv-old'
    })
  }, 15_000)

  it('does not remember a conversation whose transcript is gone: cwd is required', async () => {
    const cwd = await folder()
    const { client, started } = await sessionFixture({
      options: {
        conversations: history([
          remembered({ conversationId: 'conv-old', cwd, transcript: 'gone' })
        ])
      }
    })
    expect(
      errorText(
        await client.callTool({ name: 'clave_open_session', arguments: { resume: 'conv-old' } })
      )
    ).toContain(
      "cwd is required unless resume names a conversation this server's History remembers or a tab of this server still holds."
    )
    expect(started).toHaveLength(0)
  }, 15_000)

  it('registers clave_history only when the server keeps a History', async () => {
    const without = await sessionFixture()
    expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain(
      'clave_history'
    )
    const withHistory = await sessionFixture({ options: { conversations: history([]) } })
    expect((await withHistory.client.listTools()).tools.map((t) => t.name)).toContain(
      'clave_history'
    )
  }, 15_000)

  it('clave_history: newest first, filtered by query and open, bounded by limit, with the total', async () => {
    const { client } = await sessionFixture({
      options: {
        conversations: history([
          remembered({
            conversationId: 'c-old',
            title: 'Invoices import',
            lastHumanAt: '2026-11-01T10:00:00.000Z'
          }),
          remembered({
            conversationId: 'c-new',
            title: null,
            name: 'Payroll tab',
            cwd: '/srv/payroll',
            held: 'running',
            sessionId: 'tab-live',
            lastHumanAt: '2026-11-09T10:00:00.000Z',
            launch: { dangerous: true }
          }),
          remembered({
            conversationId: 'c-mid',
            title: 'Bank sync',
            cwd: '/srv/bank',
            held: 'stopped',
            sessionId: 'tab-stopped',
            transcript: 'gone',
            lastHumanAt: '2026-11-05T10:00:00.000Z'
          })
        ])
      }
    })
    const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      payload(await client.callTool({ name: 'clave_history', arguments: args }))
    const ids = (answer: Record<string, unknown>): string[] =>
      (answer.conversations as Array<{ conversationId: string }>).map((c) => c.conversationId)

    const all = await call({})
    expect(ids(all)).toEqual(['c-new', 'c-mid', 'c-old'])
    expect(all).toMatchObject({ shown: 3, total: 3 })
    const rows = all.conversations as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({
      conversationId: 'c-new',
      title: 'Payroll tab',
      name: 'Payroll tab',
      cwd: '/srv/payroll',
      held: 'running',
      sessionId: 'tab-live',
      transcriptExists: true,
      resumable: true,
      launch: { dangerous: true }
    })
    expect(rows[1]).toMatchObject({ transcriptExists: false, resumable: false })
    expect(rows[2]).toMatchObject({ held: 'closed', sessionId: null })

    // The query reads the title, the tab's name and the directory.
    expect(ids(await call({ query: 'INVOICES' }))).toEqual(['c-old'])
    expect(ids(await call({ query: 'payroll tab' }))).toEqual(['c-new'])
    expect(ids(await call({ query: '/srv/bank' }))).toEqual(['c-mid'])
    // Open: a tab of the server holds it, running or stopped.
    expect(ids(await call({ open: true }))).toEqual(['c-new', 'c-mid'])
    const limited = await call({ limit: 1 })
    expect(ids(limited)).toEqual(['c-new'])
    expect(limited).toMatchObject({ shown: 1, total: 3 })
    expect(await call({ open: true, limit: 1 })).toMatchObject({ shown: 1, total: 2 })
  }, 15_000)
})

describe('clave_open_artefact on the server (PRDCT-4472)', () => {
  const artefactsFor = (opened: unknown[]): ArtefactsService => ({
    ...ArtefactsPort.none,
    open: async (sessionId, path) => {
      opened.push([sessionId, path])
      if (path.endsWith('.txt'))
        throw new ArtefactRefusal(
          'An artefact is a folder holding an HTML page, or one .html file.'
        )
      return {
        sessionId,
        target: path,
        page: `${path}/index.html`,
        title: 'deck',
        openedAt: '2026-11-12T10:00:00.000Z'
      }
    }
  })

  it('is listed when the server shows artefacts, and absent when it shows none', async () => {
    const shown = await fixture({ artefacts: artefactsFor([]) })
    const names = (await shown.client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('clave_open_artefact')
    const none = await fixture()
    expect((await none.client.listTools()).tools.map((t) => t.name)).not.toContain(
      'clave_open_artefact'
    )
  })

  it("opens the artefact for the CALLER's session and answers its title and page", async () => {
    const opened: unknown[] = []
    const { client } = await fixture({ artefacts: artefactsFor(opened) })
    const answer = payload(
      await client.callTool({ name: 'clave_open_artefact', arguments: { path: '/work/deck' } })
    )
    expect(answer).toEqual({ opened: true, title: 'deck', page: '/work/deck/index.html' })
    expect(opened).toEqual([['caller', '/work/deck']])
  })

  it('answers a refusal as an error carrying its sentence', async () => {
    const { client } = await fixture({ artefacts: artefactsFor([]) })
    const result = await client.callTool({
      name: 'clave_open_artefact',
      arguments: { path: '/work/notes.txt' }
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
      'An artefact is a folder holding an HTML page, or one .html file.'
    )
  })
})

/**
 * PRDCT-4485: the daemon's agent tools offer and resolve what its launcher
 * does. Silent when wrong: a tab started on a spent connection, a profile
 * named and quietly dropped, a switch that never happened.
 */
describe('standalone MCP: the launcher’s choices (PRDCT-4485)', () => {
  const FABLE = 'claude-fable-5-1[1m]'
  /** The caller, a Claude chat on the Fable-spent subscription. */
  const caller: SessionRecord = {
    id: 'caller',
    cwd: '/srv/repo',
    folderName: 'repo',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    claudeProfileId: 'default',
    model: FABLE,
    launchProfileId: 'claude-chat'
  }
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>
  ): Promise<Awaited<ReturnType<Client['callTool']>>> => client.callTool({ name, arguments: args })

  it('clave_launch_options answers what this machine can launch, from the shared function', async () => {
    const { client } = await sessionFixture({
      options: {
        launch: (() => {
          const state: LaunchState = {
            interactionMode: 'chat',
            switchMode: 'automatic',
            detectFails: null
          }
          const base = launchFake(state)
          // An open passing no model lands on the remembered chat model,
          // Fable; the launcher's row passes Opus.
          return {
            ...base,
            launchModel: (family) => (family === 'claude' ? FABLE : undefined),
            harnessSettings: () => ({ claude: { preferredModel: 'claude-opus-5-5' } })
          }
        })()
      }
    })
    const options = payload(await call(client, 'clave_launch_options', {}))
    expect(options.machine).toEqual({ id: 'srv-1', name: 'build-box' })
    expect(options.interactionMode).toBe('chat')
    const harnesses = options.harnesses as Array<Record<string, unknown>>
    expect(harnesses.map((h) => h.id)).toEqual(['claude', 'codex', 'pi', 'opencode'])
    expect(options.notInstalled).toEqual(['Antigravity'])
    expect(options).not.toHaveProperty('warnings')
    const [claude, codex, pi, opencode] = harnesses
    expect(claude).toMatchObject({
      installed: true,
      version: '3.1.0',
      defaultModel: FABLE,
      launcherModel: 'claude-opus-5-5'
    })
    const connections = claude.connections as Array<Record<string, unknown>>
    expect(connections.filter((c) => c.suggested).map((c) => c.id)).toEqual(['work'])
    expect(connections.map((c) => [c.id, c.exhausted])).toEqual([
      ['default', true],
      ['work', false]
    ])
    expect(typeof connections[0].headroom).toBe('string')
    expect(connections[0].headroom).toContain('Fable')
    const windows = connections[0].windows as Array<Record<string, unknown>>
    expect(windows[0]).toMatchObject({
      kind: 'session',
      leftPercent: 80,
      resetIn: expect.any(String)
    })
    expect(codex.connections).toEqual([
      expect.objectContaining({
        id: 'key',
        pool: 'codex',
        kind: 'key',
        reportsUsage: false,
        fallback: true,
        suggested: true,
        exhausted: false,
        headroom: null,
        windows: []
      })
    ])
    expect(codex.models).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'GPT-6.1 Sol', served: true, reason: null }
    ])
    expect((codex.profiles as Array<Record<string, unknown>>).find((p) => p.id === 'yolo')).toEqual(
      { id: 'yolo', name: 'Yolo', form: 'terminal', default: true }
    )
    expect(
      (codex.profiles as Array<Record<string, unknown>>).find((p) => p.id === 'chat:codex:yolo')
    ).toMatchObject({ form: 'chat', default: false })
    expect((pi.models as Array<Record<string, unknown>>).map((m) => m.id)).toEqual([
      null,
      'kimi-k2'
    ])
    expect(pi.connectionNote).toBe(
      'Clave holds no connection for Pi: it runs on the login inside the harness.'
    )
    expect(opencode).toMatchObject({ installed: true, version: '2.0.1', models: [] })
  }, 15_000)

  it('clave_launch_options lists every harness, presence unknown, when the detection fails, and says why', async () => {
    const { client } = await sessionFixture({
      launch: { detectFails: 'the login shell is unreadable' }
    })
    const options = payload(await call(client, 'clave_launch_options', {}))
    expect(options.warnings).toEqual(['the login shell is unreadable'])
    expect(options.notInstalled).toEqual([])
    const harnesses = options.harnesses as Array<Record<string, unknown>>
    expect(harnesses.map((h) => [h.id, h.installed])).toEqual([
      ['claude', null],
      ['codex', null],
      ['antigravity', null],
      ['pi', null],
      ['opencode', null]
    ])
  }, 15_000)

  it('opens on the connection named by id, exact name, any case, or "any" for the model, and refuses an unknown one with the list', async () => {
    const { client, started, directory } = await sessionFixture()
    const open = (args: Record<string, unknown>): ReturnType<typeof call> =>
      call(client, 'clave_open_session', { cwd: directory, ...args })
    payload(await open({ account: 'work' }))
    expect(started[0].options).toMatchObject({
      claudeMode: true,
      claudeProfileId: 'work',
      claudeProfileLabel: 'Work'
    })
    payload(await open({ account: 'Romain' }))
    expect(started[1].options).toMatchObject({ claudeProfileId: 'default' })
    payload(await open({ account: 'WORK' }))
    expect(started[2].options).toMatchObject({ claudeProfileId: 'work' })
    // The selected one is spent on Fable: "any" for a Fable tab takes the other.
    payload(await open({ account: 'any', model: FABLE }))
    expect(started[3].options).toMatchObject({ claudeProfileId: 'work', model: FABLE })
    payload(await open({ account: 'any', model: 'claude-opus-5-5' }))
    expect(started[4].options).toMatchObject({ claudeProfileId: 'default' })
    expect(errorText(await open({ account: 'Nobody' }))).toContain(
      'Unknown Claude account "Nobody". Available: "Romain" (default), "Work" (work)'
    )
    expect(errorText(await open({ mode: 'pi', account: 'any' }))).toContain(
      'The account argument applies to harnesses with a connection pool (Claude Code, Codex); Pi runs on the login inside the harness.'
    )
    expect(started).toHaveLength(5)
  }, 15_000)

  it('opens on a profile named by name, and a built-in chat id on the harness’s configured chat default', async () => {
    const { client, started, directory } = await sessionFixture()
    const open = (args: Record<string, unknown>): ReturnType<typeof call> =>
      call(client, 'clave_open_session', { cwd: directory, ...args })
    payload(await open({ mode: 'pi', profile: 'pi on kimi' }))
    expect(started[0].options).toMatchObject({ piMode: true, launchProfileId: 'pi-kimi' })
    payload(await open({ mode: 'codex', profile: 'Yolo', chat: false }))
    expect(started[1].options).toMatchObject({ codexMode: true, launchProfileId: 'yolo' })
    payload(await open({ mode: 'codex', profile: 'codex-chat' }))
    expect(started[2].options?.launchProfileId).toBe('chat:codex:yolo')
  }, 15_000)

  it('carries the permission mode, the effort and Pi’s provider and thinking to the spawn; autoRun false prefills', async () => {
    const { client, started, directory } = await sessionFixture()
    const open = (args: Record<string, unknown>): ReturnType<typeof call> =>
      call(client, 'clave_open_session', { cwd: directory, ...args })
    payload(await open({ mode: 'claude', permissionMode: 'plan', effort: 'high' }))
    expect(started[0].options).toMatchObject({ permissionMode: 'plan', effort: 'high' })
    payload(await open({ mode: 'codex', effort: 'xhigh' }))
    expect(started[1].options).toMatchObject({ codexMode: true, effort: 'xhigh' })
    payload(await open({ mode: 'pi', provider: 'moonshot', thinking: 'high' }))
    expect(started[2].options).toMatchObject({
      piMode: true,
      piProvider: 'moonshot',
      piThinking: 'high'
    })
    payload(await open({ mode: 'terminal', command: 'make test', autoRun: false }))
    expect(started[3].options).toMatchObject({ initialCommand: 'make test', autoExecute: false })
    for (const extra of [{ window: 2 }, { workspace: 'Main' }])
      expect(errorText(await open(extra))).toContain('not available on a standalone server')
    expect(started).toHaveLength(4)
  }, 15_000)

  it('follows the server’s interaction mode when chat is omitted: terminal opens the terminal form', async () => {
    const { client, started, directory } = await sessionFixture({
      launch: { interactionMode: 'terminal' }
    })
    payload(await call(client, 'clave_open_session', { cwd: directory, mode: 'claude' }))
    expect(started[0].options).toMatchObject({ claudeMode: true })
    expect(started[0].options?.launchProfileId).toBeUndefined()
  }, 15_000)

  it('resumes a stopped holder in place on the connection the call names', async () => {
    const restarted: unknown[][] = []
    const { client } = await sessionFixture({
      records: [{ ...caller, id: 'old', claudeSessionId: 'conv-old', running: false }],
      host: {
        restart: async (...args) => {
          restarted.push(args)
          return { id: String(args[0]), alive: true, resumed: true } as never
        }
      }
    })
    payload(await call(client, 'clave_open_session', { resume: 'conv-old', account: 'Work' }))
    expect(restarted).toEqual([
      ['old', { claudeProfileId: 'work', claudeProfileLabel: 'Work' }, false, true]
    ])
  }, 15_000)

  it('clave_list says what each tab runs on: harness, model, profile and connection', async () => {
    const { client, directory } = await sessionFixture({
      records: [
        caller,
        {
          ...caller,
          id: 'started-1',
          claudeMode: false,
          codexMode: true,
          claudeProfileId: undefined,
          codexAccountId: 'key',
          model: 'gpt-6.1-sol',
          launchProfileId: 'chat:codex:yolo'
        }
      ]
    })
    payload(await call(client, 'clave_open_session', { cwd: directory, mode: 'codex' }))
    const rows = payload(await call(client, 'clave_list', {})).sessions as Array<
      Record<string, unknown>
    >
    expect(rows.find((r) => r.id === 'caller')).toMatchObject({
      mode: 'claude',
      model: FABLE,
      launchProfileId: 'claude-chat',
      account: { id: 'default', label: 'Romain', exhausted: true }
    })
    expect(rows.find((r) => r.id === 'started-1')).toMatchObject({
      parentId: 'caller',
      mode: 'codex',
      model: 'gpt-6.1-sol',
      launchProfileId: 'chat:codex:yolo',
      account: { id: 'key', label: 'API key', exhausted: false }
    })
  }, 15_000)

  async function switchFixture(
    switchMode: 'propose' | 'automatic' = 'automatic'
  ): Promise<{ client: Client; restarted: unknown[][]; directory: string }> {
    const restarted: unknown[][] = []
    const { client, directory } = await sessionFixture({
      records: [caller],
      launch: { switchMode },
      host: {
        restart: async (...args) => {
          restarted.push(args)
          return { id: String(args[0]), alive: true, resumed: true } as never
        }
      }
    })
    return { client, restarted, directory }
  }

  it('clave_switch_account moves a tab at once when the switch mode is automatic', async () => {
    const { client, restarted } = await switchFixture()
    expect(
      payload(await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'Work' }))
    ).toEqual({
      sessionId: 'caller',
      account: { id: 'work', label: 'Work' },
      resumed: true,
      switched: true,
      proposed: false
    })
    expect(restarted).toEqual([
      ['caller', { claudeProfileId: 'work', claudeProfileLabel: 'Work' }, false]
    ])
  }, 15_000)

  it('clave_switch_account: "any" leaves a connection spent for the tab’s model; the current one is no switch', async () => {
    const { client, restarted } = await switchFixture()
    expect(
      payload(await call(client, 'clave_switch_account', { sessionId: 'caller', account: 'any' }))
    ).toMatchObject({ account: { id: 'work' }, switched: true })
    expect(
      payload(await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'default' }))
    ).toEqual({
      // The Mac's answer for a tab already on the connection named.
      sessionId: 'caller',
      account: { id: 'default', label: 'Romain' },
      resumed: true,
      switched: true,
      proposed: false
    })
    expect(restarted).toHaveLength(1)
  }, 15_000)

  it('clave_switch_account: "any" from a connection with headroom moves the tab to another one', async () => {
    const restarted: unknown[][] = []
    // On Opus the caller's own connection still has headroom (only its
    // Fable week is spent): "any" still leaves it.
    const { client } = await sessionFixture({
      records: [{ ...caller, model: 'claude-opus-5-5' }],
      launch: { switchMode: 'automatic' },
      host: {
        restart: async (...args) => {
          restarted.push(args)
          return { id: String(args[0]), alive: true, resumed: false } as never
        }
      }
    })
    expect(
      payload(await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'any' }))
    ).toEqual({
      sessionId: 'caller',
      account: { id: 'work', label: 'Work' },
      resumed: false,
      switched: true,
      proposed: false
    })
    expect(restarted).toEqual([
      ['caller', { claudeProfileId: 'work', claudeProfileLabel: 'Work' }, false]
    ])
  }, 15_000)

  it('clave_switch_account says resumed: false when the restart gives no word of it', async () => {
    const { client } = await sessionFixture({
      records: [caller],
      launch: { switchMode: 'automatic' },
      host: { restart: async () => undefined as never }
    })
    expect(
      payload(await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'Work' }))
    ).toEqual({
      sessionId: 'caller',
      account: { id: 'work', label: 'Work' },
      resumed: false,
      switched: true,
      proposed: false
    })
  }, 15_000)

  it('clave_switch_account refuses under propose, an unknown connection and a tab with no pool', async () => {
    const { client, restarted, directory } = await switchFixture('propose')
    expect(
      errorText(await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'Work' }))
    ).toBe(
      'This server\'s switch mode is "propose", and a server has no window to propose to: move the tab from the Mac window, or set accountSwitchMode to "automatic" in the server\'s preferences.json, read when the server starts (a setting for it from the Mac\'s server pages is PRDCT-3318).'
    )
    expect(
      errorText(
        await call(client, 'clave_switch_account', { sessionId: 'mine', account: 'Nobody' })
      )
    ).toContain('Unknown Claude account "Nobody". Available: "Romain" (default), "Work" (work)')
    const { sessionId } = payload(
      await call(client, 'clave_open_session', { cwd: directory, mode: 'terminal' })
    )
    expect(
      errorText(await call(client, 'clave_switch_account', { sessionId, account: 'any' }))
    ).toBe(
      'Only a tab on a harness with a connection pool (Claude Code, Codex) runs on a connection'
    )
    expect(restarted).toHaveLength(0)
  }, 15_000)

  it('keeps its instructions under the host’s cut, naming clave_launch_options', async () => {
    const { client } = await sessionFixture()
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('clave_launch_options')
    expect(instructions.length).toBeLessThan(2000)
  }, 15_000)

  it('registers the launcher’s tools only when the server states its launch facts', async () => {
    const without = await sessionFixture({ options: { launch: undefined } })
    const names = (await without.client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('clave_launch_options')
    expect(names).not.toContain('clave_switch_account')
    const withLaunch = await sessionFixture()
    const all = (await withLaunch.client.listTools()).tools.map((t) => t.name)
    expect(all).toEqual(expect.arrayContaining(['clave_launch_options', 'clave_switch_account']))
  }, 15_000)
})
