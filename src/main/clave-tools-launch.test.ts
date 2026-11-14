import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { tempDataDir } from './ports/testing'
import {
  CLAVE_TAB_MCP_TOKEN_ENV,
  opencodeClaveServer,
  readClaveMcpEndpoint,
  withOpencodeClaveTools
} from './clave-tools-launch'

/**
 * How a Pi or an OpenCode tab is told about Clave's own tools (PRDCT-4507),
 * from the tab's own MCP config file: the reading of that file, OpenCode's
 * inline configuration, and Clave's Pi extension against a made-up `pi`.
 */

const TOKEN = 'made-up-tab-token-4507'
const URL = 'http://127.0.0.1:47999/mcp'
const dirs: string[] = []

function file(content: string): string {
  const dir = tempDataDir('clave-tools-launch-')
  dirs.push(dir)
  const out = path.join(dir, 'tab.json')
  fs.writeFileSync(out, content, { mode: 0o600 })
  return out
}
const issued = (url = URL, auth = `Bearer ${TOKEN}`): string =>
  file(
    JSON.stringify({
      mcpServers: { clave: { type: 'http', url, headers: { Authorization: auth } } }
    })
  )

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("the tab's MCP config file", () => {
  it('gives its address and token', () => {
    expect(readClaveMcpEndpoint(issued())).toEqual({ url: URL, token: TOKEN })
  })
  it('gives nothing, and never throws, for no file, a missing one, a malformed one, another shape', () => {
    expect(readClaveMcpEndpoint(null)).toBeNull()
    expect(readClaveMcpEndpoint(path.join(tempDataDir(), 'gone.json'))).toBeNull()
    expect(readClaveMcpEndpoint(file('{bad'))).toBeNull()
    expect(readClaveMcpEndpoint(file('{"mcpServers":{}}'))).toBeNull()
    expect(readClaveMcpEndpoint(issued(URL, 'Basic x'))).toBeNull()
  })
  it('refuses a plain-http address off this machine', () => {
    expect(readClaveMcpEndpoint(issued('http://example.com/mcp'))).toBeNull()
    expect(readClaveMcpEndpoint(issued('https://example.com/mcp'))).toEqual({
      url: 'https://example.com/mcp',
      token: TOKEN
    })
  })
})

describe("OpenCode's inline configuration", () => {
  const endpoint = { url: URL, token: TOKEN }
  const clave = opencodeClaveServer(URL)

  it('names the token by reference, never by value', () => {
    expect(clave).toEqual({
      type: 'remote',
      url: URL,
      headers: { Authorization: 'Bearer {env:CLAVE_TAB_MCP_TOKEN}' },
      oauth: false
    })
    // OpenCode's own default, code mode: no `codemode` key at all.
    expect(clave).not.toHaveProperty('codemode')
    expect(JSON.stringify(clave)).not.toContain(TOKEN)
  })

  it('with neither a connection nor a model: a configuration of its own', () => {
    const env = withOpencodeClaveTools(undefined, endpoint)!
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ mcp: { servers: { clave } } })
    expect(env[CLAVE_TAB_MCP_TOKEN_ENV]).toBe(TOKEN)
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(TOKEN)
  })

  it("on a connection: its keys and configuration unchanged, the person's other servers kept", () => {
    const own = {
      providers: { 'clave-x': { settings: { apiKey: '{env:CLAVE_CONNECTION_KEY}' } } },
      enabled_providers: ['clave-x'],
      model: 'clave-x/m',
      mcp: { servers: { other: { type: 'remote', url: 'https://example.com/mcp' } }, timeout: {} }
    }
    const before = {
      CLAVE_CONNECTION_KEY: 'made-up-key',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(own)
    }
    const env = withOpencodeClaveTools(before, endpoint)!
    expect(env.CLAVE_CONNECTION_KEY).toBe('made-up-key')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      ...own,
      mcp: { ...own.mcp, servers: { ...own.mcp.servers, clave } }
    })
    // The input is not changed in place.
    expect(before.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(own))
  })

  it('with a model alone: the model kept', () => {
    const env = withOpencodeClaveTools({ OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' }, endpoint)!
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'a/b',
      mcp: { servers: { clave } }
    })
  })

  it('without an endpoint: the environment as it was', () => {
    expect(withOpencodeClaveTools(undefined, null)).toBeUndefined()
    expect(withOpencodeClaveTools({ A: 'b' }, null)).toEqual({ A: 'b' })
  })
})

/** Clave's Pi extension, loaded as Pi loads it, against a made-up `pi`. */
interface ExtensionModule {
  default: (pi: unknown) => void
  claveMcpServer: (file: string) => Record<string, unknown> | null
  registerClaveTools: (pi: unknown, file: string | undefined) => boolean
}
const extension = (): Promise<ExtensionModule> =>
  import(
    pathToFileURL(path.resolve(__dirname, '..', '..', 'resources', 'pi-clave-state.js')).href
  ) as Promise<ExtensionModule>

function madeUpPi(options: { mcp?: boolean; register?: () => void } = {}): {
  pi: Record<string, unknown>
  handlers: Map<string, ((...args: unknown[]) => unknown)[]>
  registered: [string, Record<string, unknown>][]
} {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registered: [string, Record<string, unknown>][] = []
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getCommands: () => (options.mcp === false ? [] : [{ name: 'mcp' }]),
    registerMcpServer: (name: string, config: Record<string, unknown>) => {
      options.register?.()
      registered.push([name, config])
    }
  }
  return { pi, handlers, registered }
}
const startSession = (handlers: Map<string, ((...args: unknown[]) => unknown)[]>): void => {
  for (const handler of handlers.get('session_start') ?? []) handler({ reason: 'startup' }, {})
}

describe("Clave's Pi extension", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("registers Clave's server at the session start, from a good file: seven tools declared, the rest found by search", async () => {
    const mod = await extension()
    vi.stubEnv('CLAVE_MCP_CONFIG_FILE', issued())
    const { pi, handlers, registered } = madeUpPi()
    mod.default(pi)
    expect(registered).toEqual([])
    startSession(handlers)
    expect(registered).toEqual([
      [
        'clave',
        expect.objectContaining({
          type: 'http',
          url: URL,
          headers: { Authorization: `Bearer ${TOKEN}` },
          exposure: 'deferred',
          toolExposure: {
            clave_list: 'direct',
            clave_launch_options: 'direct',
            clave_open_session: 'direct',
            clave_send_to_session: 'direct',
            clave_read_session: 'direct',
            clave_request_input: 'direct',
            clave_input_result: 'direct'
          }
        })
      ]
    ])
    expect(registered[0][1].description).toMatch(/tool_search/)
  })

  it('declares seven tools the servers really serve, under these names (PRDCT-4507)', async () => {
    const { CLAVE_DIRECT_TOOLS } = (await extension()) as unknown as {
      CLAVE_DIRECT_TOOLS: string[]
    }
    expect(CLAVE_DIRECT_TOOLS).toEqual([
      'clave_list',
      'clave_launch_options',
      'clave_open_session',
      'clave_send_to_session',
      'clave_read_session',
      'clave_request_input',
      'clave_input_result'
    ])
    // A rename on either server, the Mac's or a Clave server's, would leave
    // the name declared to nothing.
    for (const file of ['mcp-server.ts', 'standalone-mcp.ts']) {
      const source = fs.readFileSync(path.join(__dirname, 'mcp', file), 'utf8')
      for (const name of CLAVE_DIRECT_TOOLS) expect(source, file).toContain(`'${name}'`)
    }
  })

  it('is silent on a missing or a malformed file, and with no variable at all', async () => {
    const mod = await extension()
    for (const value of [path.join(tempDataDir(), 'gone.json'), file('{bad'), file('[]')]) {
      vi.stubEnv('CLAVE_MCP_CONFIG_FILE', value)
      const { pi, handlers, registered } = madeUpPi()
      expect(() => {
        mod.default(pi)
        startSession(handlers)
      }).not.toThrow()
      expect(registered).toEqual([])
    }
    vi.stubEnv('CLAVE_MCP_CONFIG_FILE', '')
    const { pi, handlers } = madeUpPi()
    mod.default(pi)
    expect(handlers.get('session_start')).toBeUndefined()
  })

  it('registers nothing when nothing in Pi connects MCP servers (--no-mcp)', async () => {
    const mod = await extension()
    const { pi, registered } = madeUpPi({ mcp: false })
    expect(mod.registerClaveTools(pi, issued())).toBe(false)
    expect(registered).toEqual([])
  })

  it('never throws when Pi refuses the registration, nor on a Pi without the method', async () => {
    const mod = await extension()
    const { pi } = madeUpPi({
      register: () => {
        throw new Error('name held by another extension')
      }
    })
    expect(mod.registerClaveTools(pi, issued())).toBe(false)
    expect(mod.registerClaveTools({ on: () => {} }, issued())).toBe(false)
    expect(
      mod.registerClaveTools(
        {
          getCommands: () => {
            throw new Error('runtime not initialized')
          },
          registerMcpServer: () => {}
        },
        issued()
      )
    ).toBe(false)
  })

  it("keeps the terminal's state reporting, and the chat (no state file) reports none", async () => {
    const mod = await extension()
    const state = path.join(tempDataDir(), 'state')
    vi.stubEnv('CLAVE_AGENT_STATE_FILE', state)
    vi.stubEnv('CLAVE_MCP_CONFIG_FILE', issued())
    const terminal = madeUpPi()
    mod.default(terminal.pi)
    startSession(terminal.handlers)
    expect(fs.readFileSync(state, 'utf8')).toBe('idle')
    expect(terminal.registered).toHaveLength(1)
    vi.stubEnv('CLAVE_AGENT_STATE_FILE', '')
    const chat = madeUpPi()
    mod.default(chat.pi)
    expect(chat.handlers.get('agent_end')).toBeUndefined()
    startSession(chat.handlers)
    expect(chat.registered).toHaveLength(1)
  })
})
