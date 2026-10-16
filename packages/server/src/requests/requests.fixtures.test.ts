import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, it, vi } from 'vitest'
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
import { CodexTranslator } from '../../../../src/main/sessions/adapters/codex-adapter'
import type { CodexConnection } from '../../../../src/main/sessions/adapters/codex-app-server'
import { requestAwareSessionHost } from '../../../../src/main/sessions/request-aware-host'
import type { SessionStream } from '../../../contract/src/sessions'

it('loads duplicate-label native questions through the command fixture and verifies private HTTP rejection and provider effects', async () => {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const data = await mkdtemp(join(scratch, 'native-fixture-'))
  const requests = new PendingRequests()
  let receive!: (id: string, stream: SessionStream) => void
  const respond = vi.fn()
  const translator = new CodexTranslator((event) =>
    receive('fixture-native', { kind: 'event', event })
  )
  const wrapped = requestAwareSessionHost({
    host: {
      ...SessionHost.none,
      subscribe: () => () => {},
      write: async (_id, input) => {
        if (input.type === 'permission_response')
          translator.answer(
            input.id,
            input.optionId,
            { respond } as unknown as CodexConnection,
            input.answers
          )
      }
    },
    requests,
    subscribeAll: (listener) => {
      receive = listener
      return () => {}
    }
  })
  const server = await startEmbedded({ ports: { requests, sessions: wrapped.host } })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    expect(
      translator.request({
        id: 91,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'fixture-thread',
          turnId: 'fixture-turn',
          itemId: 'fixture-item',
          isBlocking: true,
          questions: [
            { id: 'public-id', header: 'Public', question: 'Value?', options: null },
            {
              id: 'private-id',
              header: 'Private',
              question: 'Value?',
              options: null,
              isSecret: true
            }
          ]
        }
      })
    ).toBe(true)
    const pending = (await api.requests.list()).pending[0]
    expect(pending.questions?.map((q) => q.id)).toEqual(['public-id', 'private-id'])
    expect(pending.secretQuestions).toEqual(['private-id'])
    const privateValue = 'FIXTURE-NATIVE-PRIVATE-SENTINEL'
    const rejected = await fetch(server.url + '/requests/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: pending.id,
        response: {
          type: 'permission',
          optionId: 'answer',
          answers: {
            'public-id': 'public answer',
            'private-id': { value: privateValue }
          }
        }
      })
    })
    expect(rejected.status).toBe(400)
    const text = await rejected.text()
    expect(text).not.toContain(privateValue)
    expect(text).not.toContain('private-id')
    expect(respond).not.toHaveBeenCalled()
    expect((await api.requests.list()).pending).toHaveLength(1)
    const fixtures = await Effect.runPromise(
      requestFixtureCatalog.prepare('shared-requests/answered-native-questions', {
        requestId: pending.id,
        answers: { 'public-id': 'public answer', 'private-id': privateValue }
      })
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
    expect(report.completed).toEqual(['shared-requests/native-questions'])
    expect(report.values.questions).toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledExactlyOnceWith(91, {
      answers: {
        'public-id': { answers: ['public answer'] },
        'private-id': { answers: [privateValue] }
      }
    })
    expect((await api.requests.list()).pending).toEqual([])
    expect(JSON.stringify(requests.result(pending.id, 'fixture-native'))).not.toContain(
      privateValue
    )
    const receipt = {
      scenario: 'shared-requests/answered-native-questions',
      runId: report.runId,
      completed: report.completed,
      requestId: pending.id,
      target: 'isolated loopback native protocol fixture',
      data
    }
    await writeFile(join(data, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } finally {
    await api.dispose()
    await server.stop()
    wrapped.close()
    requests.close()
  }
}, 15_000)

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
