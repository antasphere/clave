import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import { expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { SessionManager } from '../session-manager'
import type { CodexCallbacks, CodexConnection } from './codex-app-server'

/** Test-only target. A recording provider writes its rollout from a real
 * session write; the resumed chat is created through SessionManager too.
 * No real provider, account, database or user session is reachable. */
it('loads and verifies the codex/resumed-chat fixture scenario', async () => {
  const manager = new SessionManager()
  let root = ''
  let threadId = ''
  const connect = (_cwd: string, callbacks: CodexCallbacks): CodexConnection => ({
    request: async (method, params) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: threadId }, model: 'fixture-model' }
      if (method === 'turn/start') {
        const prompt = (params as { input: { text: string }[] }).input[0].text
        const rows = [
          { type: 'task_started', turn_id: 'fixture-turn' },
          {
            type: 'item_completed',
            turn_id: 'fixture-turn',
            item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: prompt }] }
          },
          {
            type: 'item_completed',
            turn_id: 'fixture-turn',
            item: {
              type: 'AgentMessage',
              id: 'a',
              content: [{ type: 'Text', text: 'Saved fixture answer' }]
            }
          }
        ]
        writeFileSync(
          join(root, 'sessions', `rollout-2026-10-12T10-00-00-${threadId}.jsonl`),
          rows
            .map((payload) =>
              JSON.stringify({ timestamp: '2026-10-12T10:00:00Z', type: 'event_msg', payload })
            )
            .join('\n') + '\n'
        )
        callbacks.notification({
          method: 'turn/completed',
          params: { threadId, turn: { id: 'fixture-turn', status: 'completed' } }
        })
        return { turn: { id: 'fixture-turn', status: 'completed' } }
      }
      return {}
    },
    notify: () => {},
    respond: () => {},
    reject: () => {},
    close: async () => callbacks.exit(0)
  })
  const adapter = new CodexAdapter(connect)
  manager.registerAdapter(adapter)
  const create = async (id: string, resume?: string): Promise<void> => {
    adapter.configure(
      id,
      {
        id: 'fixture',
        name: 'Fixture',
        family: 'codex',
        command: ['fixture-only'],
        additionalArgs: []
      },
      { CODEX_HOME: root }
    )
    await manager.create({
      id,
      adapterId: adapter.id,
      provider: 'codex',
      transport: 'events',
      cwd: root,
      title: 'Fixture',
      windowKey: 'fixture-window',
      state: 'idle',
      createdAt: 1,
      options: { resume }
    })
  }
  const Talk = Command.define('codex-fixtures/Talk', {
    payload: Schema.Struct({
      runId: Schema.String,
      sessionId: Schema.String,
      threadId: Schema.String
    }),
    success: Schema.String,
    failure: Schema.String
  })
  const Resume = Command.define('codex-fixtures/Resume', {
    payload: Schema.Struct({ sessionId: Schema.String, threadId: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(Talk, (payload) =>
      Effect.tryPromise(async () => {
        root = join(tmpdir(), `clave-codex-fixture-${payload.runId}`)
        threadId = payload.threadId
        mkdirSync(join(root, 'sessions'), { recursive: true })
        const tokens = createAgentTokenStore(join(root, 'mcp-configs'))
        tokens.announce('http://127.0.0.1:12345/mcp')
        installTerminalPorts({ mcpConfig: tokens.mcpConfig })
        await create(payload.sessionId)
        let off = (): void => {}
        const done = new Promise<void>((resolve) => {
          off = manager.subscribe(payload.sessionId, (stream) => {
            if (
              stream.kind === 'event' &&
              stream.event.type === 'state_change' &&
              stream.event.state === 'done'
            )
              resolve()
          })
        })
        try {
          manager.write(payload.sessionId, { type: 'user_message', text: 'Saved fixture question' })
          await done
        } finally {
          off()
          await manager.kill(payload.sessionId)
        }
        return payload.threadId
      }).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(Resume, (payload) =>
      Effect.tryPromise(async () => {
        await create(payload.sessionId, payload.threadId)
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    )
  )
  const original = defineFixture({
    key: 'codex/conversation',
    create: ({ dispatch, runId, id }) =>
      dispatch(Talk, { runId, sessionId: id('original'), threadId: id('thread') })
  })
  const resumed = defineFixture({
    key: 'codex/resumed',
    dependencies: { original },
    create: ({ dispatch, dependencies, id }) =>
      dispatch(Resume, { sessionId: id('resumed'), threadId: dependencies.original })
  })
  const scenario = defineScenario({
    name: 'codex/resumed-chat',
    description: 'A saved Codex conversation reopened with its chat history',
    input: Schema.Struct({}),
    fixtures: () => ({ original, resumed })
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
              const session = manager.list().find((session) => session.state !== 'ended')
              expect(session).toBeDefined()
              expect(manager.history(session!.id).items.map(({ event }) => event)).toEqual([
                { type: 'user_message', text: 'Saved fixture question' },
                { type: 'assistant_text', delta: 'Saved fixture answer', final: true }
              ])
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    console.log(
      JSON.stringify({ scenario: 'codex/resumed-chat', runId: report.runId, ids: report.ids, root })
    )
  } finally {
    for (const session of manager.list()) await manager.kill(session.id)
    resetTerminalPorts()
  }
}, 10_000)
