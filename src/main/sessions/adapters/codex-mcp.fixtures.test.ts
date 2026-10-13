import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import { expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter'
import { SessionManager } from '../session-manager'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'

/** Explicit test target: real session commands and token issuer, a recording
 * provider, and no provider turn or external resource. Retain the run receipt
 * for inspection; teardown revokes the credentials through SessionManager. */
it('loads and verifies codex/authenticated-chat-tabs', async () => {
  const manager = new SessionManager()
  let root = ''
  const callers = new Map<string, string>()
  let tokens: ReturnType<typeof createAgentTokenStore>
  const adapter = new CodexAdapter((_cwd, callbacks, _profile, env) => ({
    request: async (method, params) => {
      if (method === 'thread/start' || method === 'thread/resume') {
        const config = (params as { config: Record<string, { bearer_token_env_var: string }> })
          .config
        const server = Object.entries(config).find(([key]) =>
          key.startsWith('mcp_servers.clave_')
        )![1]
        const token = env![server.bearer_token_env_var]
        const owner = tokens.resolve(token)
        if (!owner) throw new Error('Fixture provider has no authenticated Clave caller')
        callers.set(env!.CLAVE_SESSION_ID, owner.sessionId)
        return { thread: { id: `thread-${owner.sessionId}` } }
      }
      if (method === 'turn/start') throw new Error('Provider turns are forbidden in this fixture')
      return {}
    },
    notify: () => {},
    respond: () => {},
    reject: () => {},
    close: async () => callbacks.exit(0)
  }))
  manager.registerAdapter(adapter)
  const Open = Command.define('codex-mcp-fixtures/Open', {
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
          root = join(tmpdir(), `clave-codex-mcp-fixture-${payload.runId}`)
          mkdirSync(root, { recursive: true })
          tokens = createAgentTokenStore(join(root, 'mcp-configs'), () => 'fixture-window')
          tokens.announce('http://127.0.0.1:12345/mcp')
          installTerminalPorts({ mcpConfig: tokens.mcpConfig })
        }
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
          options: payload.resume ? { resume: 'fixture-saved-thread' } : {}
        })
        await adapter.models({ id: payload.sessionId })
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    )
  )
  const fresh = defineFixture({
    key: 'codex/authenticated-fresh',
    create: ({ dispatch, runId, id }) =>
      dispatch(Open, { runId, sessionId: id('fresh'), resume: false })
  })
  const resumed = defineFixture({
    key: 'codex/authenticated-resumed',
    dependencies: { fresh },
    create: ({ dispatch, runId, id }) =>
      dispatch(Open, { runId, sessionId: id('resumed'), resume: true })
  })
  const scenario = defineScenario({
    name: 'codex/authenticated-chat-tabs',
    description: 'Fresh and resumed chat tabs authenticate as their own Clave caller',
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
            Effect.sync(() => {
              const sessions = manager.list()
              expect(sessions).toHaveLength(2)
              for (const session of sessions) expect(callers.get(session.id)).toBe(session.id)
              expect(new Set(callers.values()).size).toBe(2)
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    const receipt = {
      scenario: 'codex/authenticated-chat-tabs',
      target: 'isolated-recording-provider',
      runId: report.runId,
      ids: report.ids,
      root
    }
    writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } finally {
    for (const session of manager.list()) await manager.kill(session.id)
    resetTerminalPorts()
  }
}, 10_000)
