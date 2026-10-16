import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, it } from 'vitest'
import { SessionHost } from '../sessions/port'
import { PendingRequests } from './service'
import { RequestsPort } from './port'
import { requestHandlers } from './handlers'
import { requestFixtureCatalog } from './requests.fixtures'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startStandaloneMcp } from '../../../../src/main/mcp/standalone-mcp'

it('loads shared-requests/answered-approval from a real MCP request and verifies settlement over HTTP', async () => {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const data = await mkdtemp(join(scratch, 'fixture-'))
  const requests = new PendingRequests()
  const sessions = {
    ...SessionHost.none,
    get: () => ({
      id: 'fixture-session',
      cwd: data,
      windowKey: 'server',
      createdAt: 1,
      provider: 'codex',
      adapterId: 'codex-chat',
      transport: 'events' as const,
      state: 'working' as const,
      title: 'Fixture caller'
    })
  }
  const mcp = await startStandaloneMcp({
    sessions,
    requests,
    agentTools: {
      announce: () => {},
      resolve: (token) =>
        token === 'fixture-token'
          ? { sessionId: 'fixture-session', windowKey: 'server' }
          : undefined
    },
    executeSecret: async () => {
      throw new Error('No external actions in this scenario')
    }
  })
  const server = await startEmbedded({ ports: { requests, sessions } })
  const api = createApiClient({ url: server.url, token: server.token })
  const client = new Client({ name: 'fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { authorization: 'Bearer fixture-token' } }
      })
    )
    const created = await client.callTool({
      name: 'clave_request_approval',
      arguments: { description: 'Approve fixture action' }
    })
    const content = created.content as Array<{ text: string }>
    const { requestId } = JSON.parse(content[0].text) as { requestId: string }
    expect((await api.requests.list()).pending[0].id).toBe(requestId)
    const fixtures = await Effect.runPromise(
      requestFixtureCatalog.prepare('shared-requests/answered-approval', { requestId })
    )
    const layer = buses.pipe(
      Layer.provide(HandlerRegistry.layer(...requestHandlers)),
      Layer.provide(RequestsPort.layer(requests))
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
    expect(report.completed).toEqual(['shared-requests/approval'])
    expect(report.values.approval).toEqual({ accepted: true })
    expect((await api.requests.list()).pending).toEqual([])
    expect(
      await api.requests.resolve({
        requestId,
        response: { type: 'permission', optionId: 'approve' }
      })
    ).toEqual({ accepted: false })
    const receipt = {
      scenario: 'shared-requests/answered-approval',
      runId: report.runId,
      completed: report.completed,
      requestId,
      target: 'isolated loopback',
      data
    }
    await writeFile(join(data, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } finally {
    await client.close()
    await mcp.close()
    await api.dispose()
    await server.stop()
  }
}, 15_000)
