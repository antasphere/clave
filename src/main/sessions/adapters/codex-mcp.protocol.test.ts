import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter'
import { spawnCodexAppServer, type CodexConnection } from './codex-app-server'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'

/** Opt-in integration regression against an installed Codex app-server.
 * Every home, credential and endpoint is isolated. No model/list, turn/start,
 * stored account or provider API is used. Normal CI needs no installed CLI.
 * Run with CLAVE_TEST_CODEX_BIN=/absolute/path/to/codex npx vitest run <file>. */
it.skipIf(!process.env.CLAVE_TEST_CODEX_BIN)(
  'keeps authenticated chat tools usable beside legacy Clave transport, headers and filters',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'clave-codex-protocol-'))
    const tokens = createAgentTokenStore(join(root, 'mcp-configs'), () => 'fixture-window')
    const transports = new Set<StreamableHTTPServerTransport>()
    const server = createServer(async (request, response) => {
      const owner = tokens.resolve(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
      if (!owner) {
        response.writeHead(401).end()
        return
      }
      const mcp = new McpServer({ name: 'fixture-clave', version: '1' })
      mcp.registerTool(
        'clave_list',
        { description: 'Read this authenticated fixture caller', inputSchema: {} },
        async () => ({
          content: [{ type: 'text', text: JSON.stringify({ callerSessionId: owner.sessionId }) }]
        })
      )
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      transports.add(transport)
      response.on('close', () => {
        transports.delete(transport)
        void transport.close()
      })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(request, response)
      } catch {
        if (!response.headersSent) response.writeHead(500).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture MCP has no TCP address')
    tokens.announce(`http://127.0.0.1:${address.port}/mcp`)
    installTerminalPorts({ mcpConfig: tokens.mcpConfig })
    const connections: CodexConnection[] = []
    const injected: { config: Record<string, unknown>; env?: Record<string, string> }[] = []
    const adapter = new CodexAdapter((cwd, callbacks, profile, env) => {
      const connection = spawnCodexAppServer(cwd, callbacks, profile, env)
      connections.push(connection)
      return {
        ...connection,
        request: (method, params) => {
          if (method === 'thread/start' || method === 'thread/resume')
            injected.push({ config: (params as { config: Record<string, unknown> }).config, env })
          return connection.request(method, params)
        },
        notify: (method, params) => connection.notify(method, params),
        respond: (id, result) => connection.respond(id, result),
        reject: (id, message) => connection.reject(id, message),
        close: () => connection.close()
      }
    })
    const ids: string[] = []
    try {
      const configs = [
        '[mcp_servers.clave]\ncommand="/usr/bin/false"\nenabled=false\n',
        '[mcp_servers.clave]\nurl="http://127.0.0.1:1/mcp"\nenabled=false\nenabled_tools=["other_tool"]\nhttp_headers={Authorization="Bearer fixture-obsolete-auth"}\n'
      ]
      for (const [index, legacy] of configs.entries()) {
        const home = join(root, `account-${index}`)
        const { mkdirSync } = await import('node:fs')
        mkdirSync(home, { recursive: true })
        const configPath = join(home, 'config.toml')
        const config =
          legacy + '\n[mcp_servers.unrelated]\ncommand="/usr/bin/true"\nenabled=false\n'
        writeFileSync(configPath, config, { mode: 0o600 })
        const env = { ...process.env, CODEX_HOME: home } as Record<string, string>
        for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key]
        const id = `fixture-caller-${index}`
        ids.push(id)
        adapter.configure(
          id,
          {
            id: 'fixture',
            name: 'Fixture',
            family: 'codex',
            command: [process.env.CLAVE_TEST_CODEX_BIN!],
            additionalArgs: []
          },
          env
        )
        const handle = await adapter.spawn({
          id,
          adapterId: adapter.id,
          provider: 'codex',
          transport: 'events',
          cwd: home,
          windowKey: 'fixture-window',
          title: 'Fixture',
          state: 'idle',
          createdAt: 1
        })
        const thread = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Installed Codex did not initialize the fixture thread')),
            15_000
          )
          adapter.on(handle, 'stream', (stream) => {
            if (stream.kind !== 'event') return
            if (stream.event.type === 'session_meta' && stream.event.providerSessionId) {
              clearTimeout(timeout)
              resolve(stream.event.providerSessionId)
            } else if (stream.event.type === 'error') {
              clearTimeout(timeout)
              reject(new Error(stream.event.message))
            }
          })
        })
        adapter.ready(handle)
        const threadId = await thread
        const binding = Object.keys(injected[index].config).find((key) =>
          key.startsWith('mcp_servers.clave_')
        )!
        const result = await connections[index].request('mcpServer/tool/call', {
          threadId,
          server: binding.slice('mcp_servers.'.length),
          tool: 'clave_list',
          arguments: {}
        })
        expect(JSON.stringify(result)).toContain(id)
        expect(JSON.stringify(result)).not.toContain(injected[index].env!.CLAVE_CODEX_MCP_TOKEN)
        expect(readFileSync(configPath, 'utf8')).toBe(config)
        await adapter.kill(handle)
        expect(tokens.resolve(injected[index].env!.CLAVE_CODEX_MCP_TOKEN)).toBeUndefined()
      }
    } finally {
      for (const id of ids) await adapter.kill({ id })
      for (const connection of connections) await connection.close()
      for (const transport of transports) await transport.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      resetTerminalPorts()
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000
)
