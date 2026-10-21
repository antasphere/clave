import { describe, expect, it } from 'vitest'
import {
  hostPanelFor,
  hostPanelOf,
  mcpActions,
  mcpServers,
  reloadSummary,
  statusLabel,
  type McpServer
} from '../../../../plugins/chat-view/src/control-panels'

/* The /mcp and /plugin panels read the CLI's control answers and decide what
   to offer from them; the commands that open them never reach the agent. */

const server = (over: Partial<McpServer>): McpServer => ({
  name: 'linear',
  status: 'connected',
  scope: 'user',
  transport: 'http',
  tools: 3,
  error: null,
  ...over
})

describe('the host panels a command opens', () => {
  it('opens the panels for the bare commands, /plugins included', () => {
    expect(hostPanelFor('/resume')).toBe('resume')
    expect(hostPanelFor('  /mcp  ')).toBe('mcp')
    expect(hostPanelFor('/plugin')).toBe('plugin')
    expect(hostPanelFor('/plugins\n')).toBe('plugin')
  })
  it('leaves a command with arguments, another command and plain text to the agent', () => {
    expect(hostPanelFor('/mcp enable linear')).toBeNull()
    expect(hostPanelFor('/model')).toBeNull()
    expect(hostPanelFor('mcp')).toBeNull()
    expect(hostPanelFor('tell me about /mcp')).toBeNull()
  })
  it('never takes an inherited property for a panel', () => {
    expect(hostPanelOf('constructor')).toBeNull()
    expect(hostPanelFor('/toString')).toBeNull()
    expect(hostPanelFor('/__proto__')).toBeNull()
  })
})

describe('the servers of an mcp_status answer', () => {
  it('reads the CLI shape: transport from the config, tools counted', () => {
    const answer = {
      mcpServers: [
        {
          name: 'plugin:engineering:playwright',
          status: 'connected',
          scope: 'dynamic',
          source: 'plugin',
          config: { type: 'stdio', command: 'npx' },
          tools: [{ name: 'a' }, { name: 'b' }]
        },
        { name: 'vercel', status: 'needs-auth', config: { type: 'http', url: 'https://x' } }
      ]
    }
    expect(mcpServers(answer)).toEqual([
      {
        name: 'plugin:engineering:playwright',
        status: 'connected',
        scope: 'dynamic',
        transport: 'stdio',
        tools: 2,
        error: null
      },
      {
        name: 'vercel',
        status: 'needs-auth',
        scope: null,
        transport: 'http',
        tools: null,
        error: null
      }
    ])
  })
  it('drops a server with no name and keeps an unknown state as the CLI wrote it', () => {
    const answer = { mcpServers: [{ status: 'connected' }, { name: 'x', status: 'rebooting' }, 7] }
    expect(mcpServers(answer).map((s) => [s.name, s.status, statusLabel(s.status)])).toEqual([
      ['x', 'rebooting', 'rebooting']
    ])
  })
  it('reads an answer with no list as no server', () => {
    expect(mcpServers({})).toEqual([])
    expect(mcpServers({ mcpServers: 'nope' })).toEqual([])
  })
})

describe('what the /mcp panel offers on a server', () => {
  it('offers the sign-in, not a reconnect, to a server waiting on one', () => {
    expect(mcpActions(server({ status: 'needs-auth' }))).toEqual({
      enabled: true,
      authenticate: true,
      reconnect: false,
      clearAuth: false
    })
  })
  it('offers only the switch on a disabled server', () => {
    expect(mcpActions(server({ status: 'disabled' }))).toEqual({
      enabled: false,
      authenticate: false,
      reconnect: false,
      clearAuth: false
    })
  })
  it('offers sign-out on a connected remote server only', () => {
    expect(mcpActions(server({})).clearAuth).toBe(true)
    expect(mcpActions(server({ transport: 'sse' })).clearAuth).toBe(true)
    expect(mcpActions(server({ transport: 'stdio' })).clearAuth).toBe(false)
    expect(mcpActions(server({ status: 'failed' })).clearAuth).toBe(false)
    expect(mcpActions(server({ status: 'failed' })).reconnect).toBe(true)
  })
})

describe('what a plugin reload tells the reader', () => {
  it('counts what the session now carries', () => {
    expect(
      reloadSummary({ plugins: [1, 2], commands: [1, 2, 3], mcpServers: [1], error_count: 0 })
    ).toEqual({ text: 'Reloaded: 2 plugins, 3 commands, 1 MCP server.', failed: false })
  })
  it('says the reload failed in part, with the first error', () => {
    expect(
      reloadSummary({ plugins: [], error_count: 2, errors: [{ message: 'bad manifest' }, 'x'] })
    ).toEqual({
      text: 'Reloaded: 0 plugins, 0 commands, 0 MCP servers, 2 errors: bad manifest.',
      failed: true
    })
  })
  it('says a held reload changed nothing', () => {
    expect(reloadSummary({ held: true }).failed).toBe(true)
  })
})
