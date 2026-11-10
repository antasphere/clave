import { expect, it, vi } from 'vitest'
import { Effect, Layer } from 'effect'
import { HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { defineFixture, run } from '@structure-ai/fixtures'
import type { Handlers } from '@structure-ai/grpc'
import { grpcTerminals, type TerminalExit } from '@clave/server'
import type { Terminals } from '@clave/server/terminals-wire'
import { startTerminalProcess, type PtyLike } from './server'

const scheduling = vi.hoisted(() => ({
  spawned: false,
  dataBound: false,
  exitBound: false,
  yielded: false,
  pending: false
}))

// A legal scheduler yield at the first operation after the PTY starts.
// Its queued output must not run before both subscriptions are installed.
vi.mock('@structure-ai/grpc', async (importActual) => {
  const actual = await importActual<typeof import('@structure-ai/grpc')>()
  const { Effect, Scheduler } = await import('effect')
  return {
    ...actual,
    service: (
      descriptor: typeof Terminals,
      handlers: Handlers<typeof Terminals>,
      options: Parameters<typeof actual.service>[2]
    ) =>
      actual.service(
        descriptor,
        {
          ...handlers,
          spawn: (request, context) =>
            handlers.spawn(request, context).pipe(
              Effect.withScheduler({
                shouldYield: (fiber) => {
                  if (
                    scheduling.spawned &&
                    (!scheduling.dataBound || !scheduling.exitBound) &&
                    !scheduling.yielded
                  ) {
                    scheduling.yielded = true
                    scheduling.pending = true
                    return 0
                  }
                  return Scheduler.defaultScheduler.shouldYield(fiber)
                },
                scheduleTask: (task, priority, fiber) => {
                  if (scheduling.pending) {
                    scheduling.pending = false
                    setImmediate(task)
                  } else {
                    Scheduler.defaultScheduler.scheduleTask(task, priority, fiber)
                  }
                }
              })
            )
        },
        options
      )
  }
})

/** The PTY emits on the next event-loop turn, as an already-running child
 * can. No replay is invented by this adapter: subscriptions hear only events
 * delivered after they register. The process and the client use the real RPC. */
class ImmediatePty implements PtyLike {
  readonly pid = 4242
  private data: ((data: string) => void) | undefined
  private exit: ((exit: TerminalExit) => void) | undefined
  private readonly emission: NodeJS.Immediate

  constructor() {
    scheduling.spawned = true
    this.emission = setImmediate(() => {
      this.data?.('0123456789\n'.repeat(30))
      this.exit?.({ exitCode: 0 })
    })
  }

  write(): void {
    // The scripted PTY has no input.
  }
  resize(): void {
    // Its fixed transcript does not depend on terminal dimensions.
  }
  kill(): void {
    clearImmediate(this.emission)
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    scheduling.dataBound = true
    this.data = listener
    return {
      dispose: () => {
        this.data = undefined
      }
    }
  }
  onExit(listener: (exit: TerminalExit) => void): { dispose(): void } {
    scheduling.exitBound = true
    this.exit = listener
    return {
      dispose: () => {
        this.exit = undefined
      }
    }
  }
}

it('loads terminal-process/early-output and preserves its bytes and exit across a scheduler yield', async () => {
  Object.assign(scheduling, {
    spawned: false,
    dataBound: false,
    exitBound: false,
    yielded: false,
    pending: false
  })
  const fixture = defineFixture({
    key: 'terminal-process/early-output',
    create: ({ runId }) =>
      Effect.tryPromise(async () => {
        const process = await startTerminalProcess({
          token: runId,
          retainBytes: 64,
          spawn: () => new ImmediatePty()
        })
        const port = grpcTerminals({ address: process.address, token: runId })
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          const terminal = port.spawn({
            file: 'fixture-pty',
            args: [],
            cwd: '/',
            env: {},
            cols: 80,
            rows: 24
          })
          let output = ''
          terminal.onData((data) => {
            output += data
          })
          const exit = await new Promise<TerminalExit>((resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('terminal callbacks lost at spawn')),
              5_000
            )
            terminal.onExit(resolve)
          })
          return { output, exit }
        } finally {
          clearTimeout(deadline)
          await port.close()
          await process.close()
        }
      })
  })
  const report = await Effect.runPromise(
    run({
      fixtures: { transcript: fixture },
      enabled: true,
      ready: ({ values }) =>
        Effect.sync(() => {
          expect(values.transcript.output.match(/0123456789/g)?.length).toBe(30)
          expect(values.transcript.exit).toEqual({ exitCode: 0 })
        })
    }).pipe(Effect.provide(buses.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
  expect(report.completed).toEqual(['terminal-process/early-output'])
  expect(scheduling.dataBound).toBe(true)
  expect(scheduling.exitBound).toBe(true)
  console.log(
    JSON.stringify({ scenario: fixture.key, runId: report.runId, completed: report.completed })
  )
}, 15_000)
