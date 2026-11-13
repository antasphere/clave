import { mkdirSync, readFileSync } from 'node:fs'
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
import type { BackgroundTask, SessionEvent } from '../../../shared/session-model'
import type { CodexCallbacks, CodexConnection, RpcNotification } from './codex-app-server'

/** Test-only target. A recording provider answers the session's own requests
 * and replays the Codex 0.162.1 capture in agent-tasks.ndjson, from the turn
 * the message starts to the subagent's completion after it. The sessions are
 * created and written through SessionManager; no real provider, account or
 * user session is reachable. */
const frames: { direction: string; frame: RpcNotification & { id?: number; result?: unknown } }[] =
  readFileSync(new URL('../fixtures/codex-app-server/agent-tasks.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const startReply = frames.find((r) => r.direction === 'server' && r.frame.id === 2)!.frame.result
const notifications = frames
  .filter((r) => r.direction === 'server' && r.frame.method && r.frame.id === undefined)
  .map((r) => r.frame)
const turnEnd = notifications.findIndex(
  (f) =>
    f.method === 'turn/completed' && (f.params as { threadId: string }).threadId === 'thread-parent'
)
/** The last snapshot in these events, as the running-task stack names it. */
const rowsOf = (events: SessionEvent[]): string[] =>
  (
    events.findLast((e) => e.type === 'background_tasks') as { tasks: BackgroundTask[] } | undefined
  )?.tasks.map((t) => `${t.kind}:${t.description}:${t.model ?? '-'}`) ?? []

it('loads and verifies the codex/agent-tasks fixture scenario', async () => {
  const manager = new SessionManager()
  let root = ''
  const replays = new Map<string, () => void>()
  let runningAtTurnEnd: readonly string[] = []
  const events = new Map<string, SessionEvent[]>()
  const connect = (cwd: string, callbacks: CodexCallbacks): CodexConnection => ({
    request: async (method) => {
      if (method === 'thread/start') return startReply
      if (method === 'turn/start') {
        // The turn as recorded: the subagent, the background command and the
        // foreground one, up to the turn's end. What came after waits for the
        // scenario's next command.
        setImmediate(() => {
          for (const frame of notifications.slice(0, turnEnd + 1)) callbacks.notification(frame)
        })
        replays.set(cwd, () => {
          for (const frame of notifications.slice(turnEnd + 1)) callbacks.notification(frame)
        })
        return { turn: { id: 'turn-parent', status: 'inProgress' } }
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
  /** Resolves on the first event of this session that `match` accepts. */
  const until = (id: string, match: (event: SessionEvent) => boolean): Promise<void> => {
    let off = (): void => {}
    return new Promise<void>((resolve) => {
      off = manager.subscribe(id, (stream) => {
        if (stream.kind === 'event' && match(stream.event)) resolve()
      })
    }).finally(() => off())
  }

  const StartTurn = Command.define('codex-fixtures/StartAgentTasks', {
    payload: Schema.Struct({ runId: Schema.String, sessionId: Schema.String }),
    success: Schema.Struct({ sessionId: Schema.String, running: Schema.Array(Schema.String) }),
    failure: Schema.String
  })
  const FinishWork = Command.define('codex-fixtures/FinishAgentTasks', {
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(StartTurn, (payload) =>
      Effect.tryPromise(async () => {
        root = join(tmpdir(), `clave-codex-agent-tasks-${payload.runId}`)
        const cwd = join(root, payload.sessionId)
        mkdirSync(cwd, { recursive: true })
        const tokens = createAgentTokenStore(join(root, 'mcp-configs'))
        tokens.announce('http://127.0.0.1:12345/mcp')
        installTerminalPorts({ mcpConfig: tokens.mcpConfig })
        adapter.configure(payload.sessionId, {
          id: 'fixture',
          name: 'Fixture',
          family: 'codex',
          command: ['fixture-only'],
          additionalArgs: []
        })
        await manager.create({
          id: payload.sessionId,
          adapterId: adapter.id,
          provider: 'codex',
          transport: 'events',
          cwd,
          title: 'Agent tasks fixture',
          windowKey: 'fixture-window',
          state: 'idle',
          createdAt: 1
        })
        const log: SessionEvent[] = []
        events.set(payload.sessionId, log)
        manager.subscribe(payload.sessionId, (stream) => {
          if (stream.kind === 'event') log.push(stream.event)
        })
        const done = until(
          payload.sessionId,
          (e) => e.type === 'state_change' && e.state === 'done'
        )
        manager.write(payload.sessionId, { type: 'user_message', text: 'Run the agent tasks' })
        await done
        runningAtTurnEnd = manager.background(payload.sessionId).map((task) => task.id)
        return {
          sessionId: payload.sessionId,
          running: manager.background(payload.sessionId).map((task) => task.id)
        }
      }).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(FinishWork, (payload) =>
      Effect.tryPromise(async () => {
        const session = manager.get(payload.sessionId)
        const replay = session && replays.get(session.cwd)
        if (!replay) throw new Error('No recorded turn to finish')
        const empty = until(
          payload.sessionId,
          (e) => e.type === 'background_tasks' && e.tasks.length === 0
        )
        replay()
        await empty
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    )
  )
  const turn = defineFixture({
    key: 'codex/agent-tasks/turn',
    create: ({ dispatch, runId, id }) => dispatch(StartTurn, { runId, sessionId: id('session') })
  })
  const finished = defineFixture({
    key: 'codex/agent-tasks/finished',
    dependencies: { turn },
    create: ({ dispatch, dependencies }) =>
      dispatch(FinishWork, { sessionId: dependencies.turn.sessionId })
  })
  const scenario = defineScenario({
    name: 'codex/agent-tasks',
    description:
      'A Codex chat whose turn ends with a subagent and a background command still running',
    input: Schema.Struct({}),
    fixtures: () => ({ turn, finished })
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
              const [id] = [...events.keys()]
              const log = events.get(id)!
              // At the turn's end: the subagent and the command, never the
              // foreground echo, in the order Codex started them.
              const atTurnEnd = log.findIndex(
                (e) => e.type === 'state_change' && e.state === 'done'
              )
              expect(rowsOf(log.slice(0, atTurnEnd + 1))).toEqual([
                'agent:sleep_test:gpt-6.1-sol',
                'shell:sleep 30 && echo bg2:-'
              ])
              // What a view binding late is handed (SessionHost.subscribe
              // replays the manager's held list) was that same list.
              expect(runningAtTurnEnd).toEqual([
                'thread-child',
                'exec-466909ea-f9c9-47bb-8534-47350b3b1a60'
              ])
              // The child's text never reached the transcript.
              expect(
                log.some((e) => e.type === 'assistant_text' && /Done\.|20-second/.test(e.delta))
              ).toBe(false)
              // And once everything finished: nothing listed, nothing held.
              expect(rowsOf(log)).toEqual([])
              expect(manager.background(id)).toEqual([])
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    console.log(
      JSON.stringify({ scenario: 'codex/agent-tasks', runId: report.runId, ids: report.ids, root })
    )
  } finally {
    for (const session of manager.list()) await manager.kill(session.id)
    resetTerminalPorts()
  }
}, 10_000)
