import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { PiRpcAdapter } from './pi-rpc-adapter'
import { AcpAdapter } from './acp-adapter'
import type { SessionHandle, SpawnSpec } from '../adapter'

/**
 * A Pi chat and an OpenCode chat are handed Clave's own tools (PRDCT-4507):
 * each adapter asks the one issuer for the tab's file at its spawn, hands it
 * over its harness's way, and lets go of it when the process ends. The
 * stand-in harnesses then call a made-up tool server with what they were
 * given, which answers as the tab its token names.
 */

const PI = resolve(__dirname, '../../../../tests/e2e/fixtures/pi-rpc-agent.mjs')
const ACP = resolve(__dirname, '../../../../tests/e2e/fixtures/acp-agent.mjs')
const RESOURCES = resolve(__dirname, '../../../../resources')

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-clave-tools-'))
  dirs.push(dir)
  return dir
}

/** A made-up MCP server: one token per tab, `clave_list` answers the caller. */
let server: Server
let url: string
const tokens = new Map<string, string>()
const seenAuth: string[] = []
beforeEach(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      seenAuth.push(auth)
      const caller = tokens.get(auth.replace(/^Bearer /, ''))
      if (!caller) return res.writeHead(401).end()
      const frame = body ? JSON.parse(body) : {}
      if (frame.id === undefined) return res.writeHead(202).end()
      const result =
        frame.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'x', version: '0' }
            }
          : frame.method === 'tools/list'
            ? { tools: [{ name: 'clave_list', inputSchema: { type: 'object' } }] }
            : { structuredContent: { callerSessionId: caller }, content: [] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
      return undefined
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`
})

let configDir: string
let mcpConfig: { write: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
beforeEach(() => {
  configDir = tmp()
  mcpConfig = {
    write: vi.fn((id: string) => {
      const token = `made-up-${id}-${randomUUID()}`
      tokens.set(token, id)
      const file = join(configDir, `${id}.json`)
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            clave: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
          }
        }),
        { mode: 0o600 }
      )
      return file
    }),
    remove: vi.fn()
  }
  installTerminalPorts({ mcpConfig, resourcesDir: RESOURCES })
})

const live: { kill: () => Promise<void> }[] = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.kill().catch(() => {})
  resetTerminalPorts()
  await new Promise<void>((done) => server.close(() => done()))
  tokens.clear()
  seenAuth.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const records = (log: string): Record<string, unknown>[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

const spec = (id: string, adapterId: string, cwd: string): SpawnSpec => ({
  id,
  provider: adapterId === 'pi-chat' ? 'pi' : 'opencode',
  transport: 'events',
  cwd,
  windowKey: 'w',
  state: 'idle',
  createdAt: 0,
  adapterId,
  title: 'x',
  options: {}
})

function launchOf(
  adapter: object,
  handle: SessionHandle
): { command: string[]; env: NodeJS.ProcessEnv; connectionVariables?: string[] } {
  return (adapter as { handles: Map<string, { launch: never }> }).handles.get(handle.id)!.launch
}

describe("a Pi chat is handed Clave's tools (PRDCT-4507)", () => {
  async function openPi(claveTools: boolean): Promise<{
    adapter: PiRpcAdapter
    handle: SessionHandle
    log: string
    id: string
  }> {
    const state = tmp()
    const log = join(state, 'tools.jsonl')
    const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi', claveTools })
    const id = `pi-tools-${randomUUID()}`
    adapter.configure(id, {
      command: [
        process.execPath,
        PI,
        '--mode',
        'rpc',
        '--session-id',
        randomUUID(),
        '--session-dir',
        state
      ],
      env: { ...process.env, CLAVE_TOOLS_STAND_IN_LOG: log }
    })
    const handle = await adapter.spawn(spec(id, 'pi-chat', state))
    live.push({ kill: () => adapter.kill(handle) })
    adapter.ready(handle)
    return { adapter, handle, log, id }
  }

  it("loads Clave's extension, names the file's PATH, and is answered as itself", async () => {
    const { adapter, handle, log, id } = await openPi(true)
    expect(mcpConfig.write).toHaveBeenCalledExactlyOnceWith(id)
    const launch = launchOf(adapter, handle)
    expect(launch.command.slice(-2)).toEqual(['--extension', join(RESOURCES, 'pi-clave-state.js')])
    expect(launch.env.CLAVE_MCP_CONFIG_FILE).toBe(join(configDir, `${id}.json`))
    await expect.poll(() => records(log).length, { timeout: 8000 }).toBe(1)
    expect(records(log)[0]).toMatchObject({
      harness: 'pi',
      form: 'rpc',
      ok: true,
      exposure: 'deferred',
      declaredTools: ['clave_list'],
      callerSessionId: id,
      tools: ['clave_list'],
      tokenOnArgv: false,
      tokenInEnv: []
    })
  })

  it('lets go of the credential when the chat ends', async () => {
    const { adapter, handle, id } = await openPi(true)
    expect(mcpConfig.remove).not.toHaveBeenCalled()
    await adapter.kill(handle)
    await expect.poll(() => mcpConfig.remove.mock.calls.length).toBe(1)
    expect(mcpConfig.remove).toHaveBeenCalledWith(id)
  })

  it('a chat with no tool server up starts without tools', async () => {
    mcpConfig.write.mockReturnValue(null)
    const { adapter, handle, log } = await openPi(true)
    const launch = launchOf(adapter, handle)
    expect(launch.command).not.toContain('--extension')
    expect(launch.env.CLAVE_MCP_CONFIG_FILE).toBeUndefined()
    await expect.poll(() => records(log).length, { timeout: 8000 }).toBe(1)
    expect(records(log)[0]).toMatchObject({ ok: false })
  })
})

describe("an OpenCode chat is handed Clave's tools (PRDCT-4507)", () => {
  async function openAcp(
    env: Record<string, string> = {},
    connectionVariables?: string[]
  ): Promise<{
    adapter: AcpAdapter
    handle: SessionHandle
    log: string
    id: string
  }> {
    const state = tmp()
    const log = join(state, 'tools.jsonl')
    const adapter = new AcpAdapter({
      id: 'opencode-chat',
      provider: 'opencode',
      label: 'OpenCode',
      claveTools: 'opencode'
    })
    const id = `acp-tools-${randomUUID()}`
    adapter.configure(id, {
      command: [process.execPath, ACP, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state, CLAVE_TOOLS_STAND_IN_LOG: log, ...env },
      ...(connectionVariables ? { connectionVariables } : {})
    })
    const handle = await adapter.spawn(spec(id, 'opencode-chat', state))
    live.push({ kill: () => adapter.kill(handle) })
    adapter.ready(handle)
    return { adapter, handle, log, id }
  }

  it('names the server in its inline configuration, the token by reference, and is answered as itself', async () => {
    const { adapter, handle, log, id } = await openAcp()
    expect(mcpConfig.write).toHaveBeenCalledExactlyOnceWith(id)
    const launch = launchOf(adapter, handle)
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)
    expect(config.mcp.servers.clave).toEqual({
      type: 'remote',
      url,
      headers: { Authorization: 'Bearer {env:CLAVE_TAB_MCP_TOKEN}' },
      oauth: false
    })
    expect([...launch.connectionVariables!].sort()).toEqual([
      'CLAVE_TAB_MCP_TOKEN',
      'OPENCODE_CONFIG_CONTENT'
    ])
    await expect.poll(() => records(log).length, { timeout: 8000 }).toBe(1)
    expect(records(log)[0]).toMatchObject({
      harness: 'opencode',
      source: 'inline',
      codemode: null,
      ok: true,
      callerSessionId: id,
      tokenOnArgv: false,
      configHoldsToken: false,
      tokenInEnv: ['CLAVE_TAB_MCP_TOKEN']
    })
  })

  it("on a connection: its configuration and variables kept, Clave's beside", async () => {
    const own = {
      providers: { p: { settings: { apiKey: '{env:P_KEY}' } } },
      enabled_providers: ['p'],
      model: 'p/m'
    }
    const { adapter, handle } = await openAcp(
      { P_KEY: 'made-up-p', OPENCODE_CONFIG_CONTENT: JSON.stringify(own) },
      ['OPENCODE_CONFIG_CONTENT', 'P_KEY']
    )
    const launch = launchOf(adapter, handle)
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)
    expect(config).toMatchObject(own)
    expect(Object.keys(config.mcp.servers)).toEqual(['clave'])
    expect(launch.env.P_KEY).toBe('made-up-p')
    expect([...launch.connectionVariables!].sort()).toEqual(
      ['CLAVE_TAB_MCP_TOKEN', 'OPENCODE_CONFIG_CONTENT', 'P_KEY'].sort()
    )
  })

  it('lets go of the credential when the chat ends', async () => {
    const { adapter, handle, id } = await openAcp()
    await adapter.kill(handle)
    await expect.poll(() => mcpConfig.remove.mock.calls.length).toBe(1)
    expect(mcpConfig.remove).toHaveBeenCalledWith(id)
  })

  it('an adapter not told to hand them, and no tool server up, change nothing', async () => {
    mcpConfig.write.mockReturnValue(null)
    const { adapter, handle } = await openAcp()
    expect(launchOf(adapter, handle).env.CLAVE_TAB_MCP_TOKEN).toBeUndefined()
    const plain = new AcpAdapter({ id: 'acp', provider: 'opencode', label: 'X' })
    const state = tmp()
    plain.configure('plain', {
      command: [process.execPath, ACP, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state }
    })
    const h = await plain.spawn(spec('plain', 'acp', state))
    live.push({ kill: () => plain.kill(h) })
    expect(mcpConfig.write).toHaveBeenCalledTimes(1)
    expect(launchOf(plain, h).env.OPENCODE_CONFIG_CONTENT).toBe(process.env.OPENCODE_CONFIG_CONTENT)
  })
})
