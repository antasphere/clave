import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SessionHost } from '@clave/server'
import { PendingRequests } from '../../../packages/server/src/requests/service'
import { createAgentTokenStore } from '../sessions/agent-tokens'
import { executeSecretAction } from '../secret-actions'
import { startStandaloneMcp } from './standalone-mcp'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
const payload = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> => {
  const content = result.content as Array<{ type: string; text?: string }>
  expect(content[0].type).toBe('text')
  return JSON.parse(content[0].text!)
}
async function fixture(): Promise<{
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
