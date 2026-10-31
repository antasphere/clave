import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import { expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter'
import { spawnCodexAppServer, type CodexConnection } from './codex-app-server'
import { fixtureShell, installFixtureCodex } from './codex-runtime-fixture'
import { SessionManager } from '../session-manager'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'

it('loads and verifies codex/runtime-survives-upgrade for fresh and resumed chats', async () => {
  const manager = new SessionManager()
  let root = ''
  let install = ''
  const connections = new Map<string, CodexConnection>()
  const threads = new Map<string, { method: string; threadId?: string }>()
  const adapter = new CodexAdapter((cwd, callbacks, profile, env) => {
    const connection = spawnCodexAppServer(cwd, callbacks, profile, env)
    const id = env!.CLAVE_SESSION_ID
    connections.set(id, connection)
    return {
      ...connection,
      request: (method, params) => {
        if (method === 'thread/start' || method === 'thread/resume')
          threads.set(id, { method, threadId: (params as { threadId?: string }).threadId })
        return connection.request(method, params)
      },
      notify: (method, params) => connection.notify(method, params),
      respond: (id, result) => connection.respond(id, result),
      reject: (id, message) => connection.reject(id, message),
      close: () => connection.close()
    }
  })
  manager.registerAdapter(adapter)
  const Open = Command.define('codex-runtime-fixtures/Open', {
    payload: Schema.Struct({
      runId: Schema.String,
      sessionId: Schema.String,
      resume: Schema.Boolean
    }),
    success: Schema.String,
    failure: Schema.String
  })
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(Open, (payload) =>
      Effect.tryPromise(async () => {
        if (!root) {
          root = join(tmpdir(), `clave-codex-upgrade-fixture-${payload.runId}`)
          mkdirSync(root, { recursive: true })
          vi.stubEnv('SHELL', fixtureShell(root))
          install = installFixtureCodex(root)
          const tokens = createAgentTokenStore(join(root, 'mcp-configs'), () => 'fixture-window')
          tokens.announce('http://127.0.0.1:12345/mcp')
          installTerminalPorts({ mcpConfig: tokens.mcpConfig })
        }
        adapter.configure(payload.sessionId, {
          id: 'fixture',
          name: 'Fixture',
          family: 'codex',
          command: [join(install, 'bin', 'codex')],
          additionalArgs: []
        })
        await manager.create({
          id: payload.sessionId,
          adapterId: adapter.id,
          provider: 'codex',
          transport: 'events',
          cwd: root,
          windowKey: 'fixture-window',
          state: 'idle',
          title: 'Fixture',
          createdAt: 1,
          options: payload.resume ? { resume: 'saved-provider-thread' } : {}
        })
        await adapter.models({ id: payload.sessionId })
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    )
  )
  const fresh = defineFixture({
    key: 'codex/runtime-fresh',
    create: ({ dispatch, runId, id }) =>
      dispatch(Open, { runId, sessionId: id('fresh'), resume: false })
  })
  const resumed = defineFixture({
    key: 'codex/runtime-resumed',
    dependencies: { fresh },
    create: ({ dispatch, runId, id }) =>
      dispatch(Open, { runId, sessionId: id('resumed'), resume: true })
  })
  const scenario = defineScenario({
    name: 'codex/runtime-survives-upgrade',
    description: 'Fresh and resumed chats retain executable helpers after installer cleanup',
    input: Schema.Struct({}),
    fixtures: () => ({ fresh, resumed })
  })
  try {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fixtures = yield* scenario.prepare({})
        return yield* run({
          fixtures,
          enabled: true,
          ready: () =>
            Effect.tryPromise(async () => {
              expect(manager.list()).toHaveLength(2)
              expect([...threads.values()]).toEqual([
                { method: 'thread/start', threadId: undefined },
                { method: 'thread/resume', threadId: 'saved-provider-thread' }
              ])
              rmSync(install, { recursive: true })
              for (const connection of connections.values()) {
                expect(await connection.request('helper')).toEqual({ output: 'helper-old:old' })
                expect(await connection.request('child')).toEqual({ output: 'helper-old:old' })
              }
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    const receipt = {
      scenario: scenario.name,
      target: 'isolated-standalone-provider',
      runId: report.runId,
      ids: report.ids,
      root
    }
    writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } finally {
    for (const session of manager.list()) await manager.kill(session.id)
    resetTerminalPorts()
    vi.unstubAllEnvs()
  }
}, 15_000)
