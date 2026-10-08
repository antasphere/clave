/**
 * The terminal process: the Node process that owns node-pty for a Clave
 * server running on its own (ADR 0003, wave 3). It serves the Terminals port
 * of `packages/server/src/terminals/port.ts` as gRPC on the loopback, with
 * the framework's own package, to a caller presenting its token.
 *
 * What it holds: one record per terminal, with the recent output kept as
 * sequenced events (`retainBytes` of it), so a caller whose stream ended on
 * its deadline re-attaches with the last sequence it saw and misses nothing.
 * What it watches: a terminal that nobody has attached to for `orphanGraceMs`
 * is hung up, then killed, because the only reason is a server that is gone;
 * a terminal that exited is forgotten once its exit was delivered, or after
 * the same grace.
 *
 * `startTerminalProcess` is the whole process minus its command line, so a
 * test runs it in its own process (node-pty loads under plain Node); `main.ts`
 * is the entry `scripts/server-process.mjs` starts from the built bundle.
 * Nothing here imports Electron, and nothing of the HTTP server.
 */
import { randomUUID } from 'node:crypto'
import { create } from '@bufbuild/protobuf'
import { Effect, Exit, Layer, LogLevel, Logger, Scope, Stream } from 'effect'
import { makeServer, service, type Handlers } from '@structure-ai/grpc'
import { Readiness, Shutdown } from '@structure-ai/runtime'
import {
  AttachRequest,
  KillRequest,
  KillResponseSchema,
  PingResponseSchema,
  ResizeRequest,
  ResizeResponseSchema,
  SpawnRefused,
  SpawnRequest,
  SpawnResponseSchema,
  TerminalEvent,
  TerminalEventSchema,
  Terminals,
  UnknownTerminal,
  WriteRequest,
  WriteResponseSchema,
  terminalFailures,
  verifyBearer
} from '@clave/server/terminals-wire'

/** The slice of node-pty the process uses: injectable so a test can run the
 *  process over a fake, and so the native module loads only when asked. */
export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export interface PtySpawn {
  (
    file: string,
    args: readonly string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    }
  ): PtyLike
}

export interface TerminalProcessOptions {
  /** The token every call must present. */
  readonly token: string
  /** `host:port`, the loopback and any free port by default. */
  readonly address?: string
  /** How long a terminal lives with nobody attached before it is hung up. */
  readonly orphanGraceMs?: number
  /** How much recent output is kept per terminal for a re-attach. */
  readonly retainBytes?: number
  /** The longest any call, an attach stream included, may last. The
   *  framework's ceiling, 24 hours, by default. */
  readonly maxCallMs?: number
  /** node-pty's `spawn`, loaded on first use by default. */
  readonly spawn?: PtySpawn
  readonly log?: (line: string) => void
}

export interface TerminalProcessHandle {
  readonly address: string
  /** How many terminals the process holds, exited ones included until forgotten. */
  readonly terminals: () => number
  readonly close: () => Promise<void>
}

const DEFAULT_GRACE_MS = 15_000
const DEFAULT_RETAIN_BYTES = 512 * 1024
const MAX_CALL_MS = 86_400_000

interface Held {
  readonly id: string
  readonly proc: PtyLike
  seq: bigint
  /** The retained output, oldest first; `bytes` their total. */
  events: TerminalEvent[]
  bytes: number
  exited: TerminalEvent | null
  exitedAt: number | null
  readonly subscribers: Set<(event: TerminalEvent) => void>
  attached: number
  /** When the last attached stream left; null while one is attached. */
  detachedAt: number | null
  hungUpAt: number | null
}

const nodePtySpawn = (): PtySpawn => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')
  return (file, args, options) => pty.spawn(file, [...args], options)
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function startTerminalProcess(
  options: TerminalProcessOptions
): Promise<TerminalProcessHandle> {
  const grace = options.orphanGraceMs ?? DEFAULT_GRACE_MS
  const retain = options.retainBytes ?? DEFAULT_RETAIN_BYTES
  const log = options.log ?? (() => {})
  let spawn: PtySpawn | null = options.spawn ?? null
  const held = new Map<string, Held>()

  const push = (term: Held, event: TerminalEvent): void => {
    if (event.event.case === 'output') {
      term.events.push(event)
      term.bytes += Buffer.byteLength(event.event.value.data)
      while (term.bytes > retain && term.events.length > 1) {
        const dropped = term.events.shift()!
        term.bytes -= Buffer.byteLength(
          dropped.event.case === 'output' ? dropped.event.value.data : ''
        )
      }
    }
    for (const subscriber of term.subscribers) subscriber(event)
  }

  const forget = (term: Held): void => {
    held.delete(term.id)
  }

  const sweep = (): void => {
    const now = Date.now()
    for (const term of held.values()) {
      if (term.exited) {
        if (term.exitedAt !== null && (term.attached === 0 || now - term.exitedAt > grace))
          forget(term)
        continue
      }
      if (term.attached > 0 || term.detachedAt === null || now - term.detachedAt <= grace) continue
      if (term.hungUpAt === null) {
        log(
          `terminal ${term.id} (pid ${term.proc.pid}): nobody attached for ${grace} ms, hanging up`
        )
        term.hungUpAt = now
        try {
          term.proc.kill('SIGHUP')
        } catch {
          /* already gone */
        }
      } else if (now - term.hungUpAt > grace) {
        log(
          `terminal ${term.id} (pid ${term.proc.pid}): still running ${grace} ms after SIGHUP, killing`
        )
        try {
          term.proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        term.hungUpAt = now
      }
    }
  }
  const sweeper = setInterval(sweep, Math.max(50, Math.floor(grace / 4)))
  sweeper.unref()

  const lookup = (id: string): Effect.Effect<Held, UnknownTerminal> => {
    const term = held.get(id)
    return term ? Effect.succeed(term) : Effect.fail(new UnknownTerminal({ id }))
  }

  const handlers = {
    ping: () => Effect.succeed(create(PingResponseSchema, { terminals: held.size })),

    spawn: (request: SpawnRequest) =>
      Effect.try({
        try: () => {
          spawn ??= nodePtySpawn()
          return spawn(request.file, request.args, {
            name: request.name || 'xterm-256color',
            cols: Math.max(1, request.cols),
            rows: Math.max(1, request.rows),
            cwd: request.cwd,
            env: { ...request.env }
          })
        },
        catch: (error) => new SpawnRefused({ reason: reason(error) })
      }).pipe(
        Effect.map((proc) => {
          const term: Held = {
            id: randomUUID(),
            proc,
            seq: 0n,
            events: [],
            bytes: 0,
            exited: null,
            exitedAt: null,
            subscribers: new Set(),
            attached: 0,
            detachedAt: Date.now(),
            hungUpAt: null
          }
          held.set(term.id, term)
          proc.onData((data) => {
            term.seq += 1n
            push(
              term,
              create(TerminalEventSchema, {
                seq: term.seq,
                event: { case: 'output', value: { data } }
              })
            )
          })
          proc.onExit(({ exitCode, signal }) => {
            term.seq += 1n
            const exited = create(TerminalEventSchema, {
              seq: term.seq,
              event: {
                case: 'exited',
                value: { exitCode, ...(signal !== undefined && signal !== 0 && { signal }) }
              }
            })
            term.exited = exited
            term.exitedAt = Date.now()
            push(term, exited)
            if (term.attached === 0) forget(term)
          })
          return create(SpawnResponseSchema, { id: term.id, pid: proc.pid })
        })
      ),

    write: (request: WriteRequest) =>
      lookup(request.id).pipe(
        Effect.map((term) => {
          term.proc.write(request.data)
          return create(WriteResponseSchema)
        })
      ),

    resize: (request: ResizeRequest) =>
      lookup(request.id).pipe(
        Effect.map((term) => {
          term.proc.resize(Math.max(1, request.cols), Math.max(1, request.rows))
          return create(ResizeResponseSchema)
        })
      ),

    kill: (request: KillRequest) =>
      lookup(request.id).pipe(
        Effect.map((term) => {
          term.proc.kill(request.signal || undefined)
          return create(KillResponseSchema)
        })
      ),

    attach: (request: AttachRequest) =>
      Stream.unwrap(
        lookup(request.id).pipe(
          Effect.map((term) =>
            Stream.asyncPush<TerminalEvent>(
              (emit) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    term.attached += 1
                    term.detachedAt = null
                    term.hungUpAt = null
                    const after = request.after
                    const first = term.events[0]
                    if (first !== undefined && first.seq > after + 1n) {
                      emit.single(
                        create(TerminalEventSchema, {
                          seq: after,
                          event: { case: 'gap', value: { lost: first.seq - after - 1n } }
                        })
                      )
                    }
                    for (const event of term.events) if (event.seq > after) emit.single(event)
                    if (term.exited) {
                      if (term.exited.seq > after) emit.single(term.exited)
                      emit.end()
                      return () => {}
                    }
                    const subscriber = (event: TerminalEvent): void => {
                      emit.single(event)
                      if (event.event.case === 'exited') emit.end()
                    }
                    term.subscribers.add(subscriber)
                    return () => term.subscribers.delete(subscriber)
                  }),
                  (unsubscribe) =>
                    Effect.sync(() => {
                      unsubscribe()
                      term.attached -= 1
                      if (term.attached === 0) {
                        term.detachedAt = Date.now()
                        if (term.exited) forget(term)
                      }
                    })
                ),
              { bufferSize: 'unbounded' }
            )
          )
        )
      )
  } satisfies Handlers<typeof Terminals>

  const registration = service(Terminals, handlers, { failures: terminalFailures })

  const scope = Effect.runSync(Scope.make())
  const runtime = Shutdown.layer().pipe(Layer.provideMerge(Readiness.layer))
  try {
    const context = await Effect.runPromise(Layer.buildWithScope(runtime, scope))
    const server = await Effect.runPromise(
      makeServer([registration], {
        address: options.address ?? '127.0.0.1:0',
        security: { mode: 'insecure' },
        maxCallMs: options.maxCallMs ?? MAX_CALL_MS,
        verify: verifyBearer(options.token)
      }).pipe(
        Scope.extend(scope),
        Effect.provide(context),
        Logger.withMinimumLogLevel(LogLevel.Warning)
      )
    )
    await Effect.runPromise(
      Effect.provide(Readiness, context).pipe(Effect.flatMap((r) => r.setReady))
    )
    return {
      address: server.address,
      terminals: () => held.size,
      close: async () => {
        clearInterval(sweeper)
        await Effect.runPromise(Scope.close(scope, Exit.void))
        // The terminals go with the process: nothing of this process's
        // outlives it, whichever way it ends.
        for (const term of held.values()) {
          if (term.exited) continue
          try {
            term.proc.kill('SIGHUP')
          } catch {
            /* already gone */
          }
        }
        held.clear()
      }
    }
  } catch (error) {
    clearInterval(sweeper)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
