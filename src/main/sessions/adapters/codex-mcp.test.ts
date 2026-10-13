import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentTokenStore, type AgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { CodexAdapter } from './codex-adapter'
import type { CodexCallbacks, CodexConnection } from './codex-app-server'
import type { SpawnSpec } from '../adapter'

let root: string
let tokens: AgentTokenStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clave-codex-mcp-'))
  tokens = createAgentTokenStore(root, () => 'fixture-window')
  tokens.announce('http://127.0.0.1:12345/mcp')
  installTerminalPorts({ mcpConfig: tokens.mcpConfig })
})
afterEach(() => {
  resetTerminalPorts()
  rmSync(root, { recursive: true, force: true })
})
const spec = (id: string, resume?: string): SpawnSpec => ({
  id,
  provider: 'codex',
  transport: 'events',
  adapterId: 'codex-chat',
  cwd: root,
  windowKey: 'fixture-window',
  state: 'idle',
  title: 'Fixture',
  createdAt: 1,
  options: { ...(resume ? { resume } : {}) }
})
const profile = {
  id: 'fixture',
  name: 'Fixture',
  family: 'codex' as const,
  command: ['fixture-only'],
  additionalArgs: []
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

it('binds fresh and resumed tabs to distinct authenticated callers and revokes only their own credentials', async () => {
  const launches: { env?: Record<string, string>; requests: [string, unknown][] }[] = []
  const connect = vi.fn((_cwd: string, callbacks: CodexCallbacks, _profile, env) => {
    const launch = { env, requests: [] as [string, unknown][] }
    launches.push(launch)
    return {
      request: async (method, params) => {
        launch.requests.push([method, params])
        return method.startsWith('thread/') ? { thread: { id: `thread-${launches.length}` } } : {}
      },
      notify: () => {},
      respond: () => {},
      reject: () => {},
      close: async () => callbacks.exit(0)
    } satisfies CodexConnection
  })
  const adapter = new CodexAdapter(connect)
  adapter.configure('first', profile, { CODEX_HOME: '/fixture-account', USER_CHOICE: 'preserved' })
  adapter.configure('resumed', profile, { CODEX_HOME: '/other-account' })
  const a = await adapter.spawn(spec('first'))
  const b = await adapter.spawn(spec('resumed', 'saved-thread'))
  await Promise.all([adapter.models(a), adapter.models(b)])
  for (const [index, id] of ['first', 'resumed'].entries()) {
    const { env, requests } = launches[index]
    expect(env?.CLAVE_SESSION_ID).toBe(id)
    const thread = requests.find(
      ([method]) => method === (index ? 'thread/resume' : 'thread/start')
    )!
    const params = thread[1] as { config: Record<string, unknown>; threadId?: string }
    const claveEntries = Object.entries(params.config).filter(([key]) =>
      key.startsWith('mcp_servers.')
    )
    expect(claveEntries).toHaveLength(1)
    expect(claveEntries[0][0]).toMatch(/^mcp_servers\.clave_[a-f0-9]{12}$/)
    expect(params.config).not.toHaveProperty('mcp_servers.clave')
    expect(params.config['shell_environment_policy.set.CLAVE_SESSION_ID']).toBe(id)
    expect(claveEntries[0][1]).toEqual({
      url: 'http://127.0.0.1:12345/mcp',
      bearer_token_env_var: 'CLAVE_CODEX_MCP_TOKEN',
      enabled: true,
      required: true
    })
    const token = env?.CLAVE_CODEX_MCP_TOKEN
    expect(typeof token).toBe('string')
    expect(tokens.resolve(token!)).toEqual({ sessionId: id, windowKey: 'fixture-window' })
    expect(JSON.stringify(requests)).not.toContain(token!)
    expect(JSON.stringify(spec(id))).not.toContain(token!)
    if (index) expect(params.threadId).toBe('saved-thread')
  }
  expect(launches[0].env?.USER_CHOICE).toBe('preserved')
  expect(launches[0].env?.CLAVE_CODEX_MCP_TOKEN).not.toBe(launches[1].env?.CLAVE_CODEX_MCP_TOKEN)
  const firstToken = launches[0].env!.CLAVE_CODEX_MCP_TOKEN
  const secondToken = launches[1].env!.CLAVE_CODEX_MCP_TOKEN
  await adapter.kill(a)
  expect(tokens.resolve(firstToken)).toBeUndefined()
  expect(tokens.resolve(secondToken)?.sessionId).toBe('resumed')
  expect(() => readFileSync(join(root, 'first.json'))).toThrow()
  await adapter.kill(b)
  expect(tokens.resolve(secondToken)).toBeUndefined()
})

it('reports unavailable MCP startup visibly and never launches an unbound process', async () => {
  installTerminalPorts({ mcpConfig: { write: () => null, remove: vi.fn() } })
  const connect = vi.fn(() => {
    throw new Error('Must not launch')
  })
  const adapter = new CodexAdapter(connect)
  const handle = await adapter.spawn(spec('missing'))
  const events: unknown[] = []
  adapter.on(handle, 'stream', (event) => events.push(event))
  adapter.ready(handle)
  await tick()
  expect(events).toContainEqual({
    kind: 'event',
    event: {
      type: 'error',
      message: 'Clave MCP is unavailable for this Codex session',
      fatal: true
    }
  })
  expect(connect).not.toHaveBeenCalled()
})

it('revokes the tab credential when a required MCP server fails to initialize', async () => {
  let token: string | undefined
  const adapter = new CodexAdapter((_cwd, callbacks, _profile, env) => {
    token = env?.CLAVE_CODEX_MCP_TOKEN
    return {
      request: async (method) => {
        if (method === 'thread/start') throw new Error('Required Clave MCP failed')
        return {}
      },
      notify: () => {},
      respond: () => {},
      reject: () => {},
      close: async () => callbacks.exit(1)
    }
  })
  const handle = await adapter.spawn(spec('failure'))
  await expect(adapter.models(handle)).rejects.toThrow('Required Clave MCP failed')
  expect(token).toBeDefined()
  expect(tokens.resolve(token!)).toBeUndefined()
  expect(() => readFileSync(join(root, 'failure.json'))).toThrow()
})

it('waits for the shell MCP announcement before starting a restored tab', async () => {
  tokens = createAgentTokenStore(root)
  installTerminalPorts({ mcpConfig: tokens.mcpConfig })
  const connect = vi.fn((_cwd: string, callbacks: CodexCallbacks) => ({
    request: async (method: string) =>
      method === 'thread/resume' ? { thread: { id: 'saved' } } : {},
    notify: () => {},
    respond: () => {},
    reject: () => {},
    close: async () => callbacks.exit(0)
  }))
  const adapter = new CodexAdapter(connect)
  const handle = await adapter.spawn(spec('early', 'saved'))
  const startup = adapter.models(handle)
  await tick()
  expect(connect).not.toHaveBeenCalled()
  tokens.announce('http://127.0.0.1:12345/mcp')
  await startup
  expect(connect).toHaveBeenCalledTimes(1)
  await adapter.kill(handle)
})

it('does not mint credentials for a tab closed during the shell MCP announcement', async () => {
  tokens = createAgentTokenStore(root)
  installTerminalPorts({ mcpConfig: tokens.mcpConfig })
  const connect = vi.fn(() => {
    throw new Error('Must not launch')
  })
  const adapter = new CodexAdapter(connect)
  const handle = await adapter.spawn(spec('cancelled'))
  adapter.ready(handle)
  await tick()
  await adapter.kill(handle)
  tokens.announce('http://127.0.0.1:12345/mcp')
  await tick()
  expect(connect).not.toHaveBeenCalled()
  expect(() => readFileSync(join(root, 'cancelled.json'))).toThrow()
})

it('preserves an authoritative launch environment including intentional home and API omissions', async () => {
  vi.stubEnv('CODEX_HOME', '/fixture-host-home-that-was-omitted')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-host-api-key-that-was-omitted')
  vi.stubEnv('CLAVE_SERVER_TOKEN', 'fixture-host-server-token-that-was-omitted')
  let launchEnv: Record<string, string> | undefined
  const adapter = new CodexAdapter((_cwd, callbacks, _profile, env) => {
    launchEnv = env
    return {
      request: async (method) =>
        method === 'thread/start' ? { thread: { id: 'fixture-thread' } } : {},
      notify: () => {},
      respond: () => {},
      reject: () => {},
      close: async () => callbacks.exit(0)
    }
  })
  const configured = { PATH: '/fixture/bin', USER_CHOICE: 'preserved' }
  adapter.configure('authoritative-env', profile, configured)
  const handle = await adapter.spawn(spec('authoritative-env'))
  try {
    await adapter.models(handle)
    // Assert only names/booleans so a regression never dumps host credentials.
    expect('CODEX_HOME' in launchEnv!).toBe(false)
    expect('OPENAI_API_KEY' in launchEnv!).toBe(false)
    expect('CLAVE_SERVER_TOKEN' in launchEnv!).toBe(false)
    expect(Object.keys(launchEnv!).sort()).toEqual(
      ['PATH', 'USER_CHOICE', 'CLAVE_SESSION_ID', 'CLAVE_CODEX_MCP_TOKEN'].sort()
    )
    expect(launchEnv?.PATH).toBe(configured.PATH)
    expect(launchEnv?.USER_CHOICE).toBe(configured.USER_CHOICE)
    expect(configured).not.toHaveProperty('CLAVE_CODEX_MCP_TOKEN')
  } finally {
    await adapter.kill(handle)
    vi.unstubAllEnvs()
  }
})
