import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import { expect, it, vi } from 'vitest'
import type { SessionEvent } from '../../../shared/session-model'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'

/** Test-only target. The Claude chat adapter spawns its CLI through
 * node:child_process; here that spawn is a recording process that answers the
 * session's own message with the Claude Code capture in
 * claude-stream/background-bash.ndjson: a Bash call run in the background, a
 * Bash call waited on, the answer, and after the turn the background command's
 * completion. The session is created and written through SessionManager and
 * every frame goes through the real ClaudeStreamTranslator. No real CLI,
 * account or user session is reachable. */
const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  mcpConfig: { write: vi.fn((): string | null => null), remove: vi.fn() }
}))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
vi.mock('../../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell-launch')>()),
  findExecutable: () => null
}))
vi.mock('../../launch-profile-manager', () => ({
  launchProfileManager: {
    resolve: () => ({
      id: 'fixture',
      name: 'Fixture',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
  }
}))
vi.mock('./pty-backend', () => ({
  accountTokenForSpawn: () => null,
  buildSpawnEnv: (env: Record<string, string>) => env,
  getLoginShellEnv: () => ({ PATH: '/fixture/bin' }),
  getUserShell: () => '/bin/zsh',
  buildClaudeHookSettingsArg: (id: string) => JSON.stringify({ hooks: id }),
  shellSingleQuote: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
  isValidClaudeSessionId: (s: string) => /^[\w-]+$/.test(s)
}))
import { ClaudeAdapter } from './claude-adapter'
import { SessionManager } from '../session-manager'

const lines = readFileSync(
  new URL('../fixtures/claude-stream/background-bash.ndjson', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
/** The first `result` closes the reader's turn; what follows is the
 *  background command finishing, and the CLI's own turn about it. */
const turnEnd = lines.findIndex((line) => JSON.parse(line).type === 'result')
const BACKGROUND_CALL = 'toolu_01B3915RsziZbG17XXwgRkkA'
const BACKGROUND_TASK = 'by169hk6v'

it('loads and verifies the claude/bash-tasks fixture scenario', async () => {
  installTerminalPorts({ mcpConfig: mock.mcpConfig })
  const manager = new SessionManager()
  const adapter = new ClaudeAdapter()
  manager.registerAdapter(adapter)
  const finishes = new Map<string, () => void>()
  const events = new Map<string, SessionEvent[]>()
  let current = ''
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      // The adapter waits for the owned process's exit, then its close.
      kill: vi.fn(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0)
      }),
      exitCode: null,
      signalCode: null
    })
    const id = current
    let buffered = ''
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let index: number
      while ((index = buffered.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffered.slice(0, index))
        buffered = buffered.slice(index + 1)
        // The reader's message: the recorded turn, up to its result.
        if (frame.type === 'user')
          setImmediate(() => {
            for (const line of lines.slice(0, turnEnd + 1)) child.stdout.write(`${line}\n`)
          })
      }
    })
    finishes.set(id, () => {
      for (const line of lines.slice(turnEnd + 1)) child.stdout.write(`${line}\n`)
    })
    return child
  })
  /** Resolves on the first event of this session that `match` accepts. */
  const until = (id: string, match: (event: SessionEvent) => boolean): Promise<void> => {
    let off = (): void => {}
    return new Promise<void>((resolve) => {
      off = manager.subscribe(id, (stream) => {
        if (stream.kind === 'event' && match(stream.event)) resolve()
      })
    }).finally(() => off())
  }
  let heldAtTurnEnd: string[] = []

  const StartTurn = Command.define('claude-fixtures/StartBashTasks', {
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })
  const FinishWork = Command.define('claude-fixtures/FinishBashTasks', {
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(StartTurn, (payload) =>
      Effect.tryPromise(async () => {
        current = payload.sessionId
        await manager.create({
          id: payload.sessionId,
          adapterId: adapter.id,
          provider: 'claude',
          transport: 'events',
          cwd: '/tmp',
          title: 'Bash tasks fixture',
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
        manager.write(payload.sessionId, { type: 'user_message', text: 'Run the Bash tasks' })
        await done
        heldAtTurnEnd = manager.background(payload.sessionId).map((t) => t.toolUseId ?? t.id)
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(FinishWork, (payload) =>
      Effect.tryPromise(async () => {
        const finish = finishes.get(payload.sessionId)
        if (!finish) throw new Error('No recorded turn to finish')
        const empty = until(
          payload.sessionId,
          (e) => e.type === 'background_tasks' && e.tasks.length === 0
        )
        finish()
        await empty
        return payload.sessionId
      }).pipe(Effect.mapError(String))
    )
  )
  const turn = defineFixture({
    key: 'claude/bash-tasks/turn',
    create: ({ dispatch, id }) => dispatch(StartTurn, { sessionId: id('session') })
  })
  const finished = defineFixture({
    key: 'claude/bash-tasks/finished',
    dependencies: { turn },
    create: ({ dispatch, dependencies }) => dispatch(FinishWork, { sessionId: dependencies.turn })
  })
  const scenario = defineScenario({
    name: 'claude/bash-tasks',
    description:
      'A Claude chat whose turn runs one Bash call in the background and waits on another',
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
              const index = (match: (e: SessionEvent) => boolean): number => log.findIndex(match)
              const calls = log.flatMap((e) =>
                e.type === 'tool_call' && e.name === 'Bash' && !e.parent
                  ? [`${e.id}:${JSON.stringify(e.input)}`]
                  : []
              )
              // Both Bash calls reach the view on the main thread, the first
              // asking for the background.
              expect(calls).toHaveLength(2)
              expect(calls[0]).toContain(`${BACKGROUND_CALL}:`)
              expect(calls[0]).toContain('"run_in_background":true')
              expect(calls[1]).toContain('echo fgc')
              // The order the view relies on: the call, then the list naming
              // it, then its "running in background" result.
              const called = index((e) => e.type === 'tool_call' && e.id === BACKGROUND_CALL)
              const listed = index(
                (e) =>
                  e.type === 'background_tasks' &&
                  e.tasks.some((t) => t.id === BACKGROUND_TASK && t.toolUseId === BACKGROUND_CALL)
              )
              const acknowledged = index(
                (e) => e.type === 'tool_result' && e.id === BACKGROUND_CALL
              )
              const done = index((e) => e.type === 'state_change' && e.state === 'done')
              expect(called).toBeGreaterThanOrEqual(0)
              expect(listed).toBeGreaterThan(called)
              expect(acknowledged).toBeGreaterThan(listed)
              expect(done).toBeGreaterThan(acknowledged)
              // Held past the turn, then gone at the command's completion.
              expect(heldAtTurnEnd).toEqual([BACKGROUND_CALL])
              const shell = log.flatMap((e) => (e.type === 'background_tasks' ? [e.tasks] : []))
              expect(shell.at(-1)).toEqual([])
              expect(manager.background(id)).toEqual([])
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    console.log(
      JSON.stringify({ scenario: 'claude/bash-tasks', runId: report.runId, ids: report.ids })
    )
  } finally {
    for (const session of manager.list()) await manager.kill(session.id)
    resetTerminalPorts()
  }
}, 10_000)
