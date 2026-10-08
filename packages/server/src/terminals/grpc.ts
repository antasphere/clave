/**
 * The Terminals port over the wire: what a server running on its own gives
 * `ports.terminals` (ADR 0003, wave 3). Each spawn becomes a terminal in the
 * terminal process (`src/main/terminal-process/`), reached as gRPC over the
 * loopback with the framework's client and the process's token.
 *
 * The port's `spawn` is synchronous and the wire is not, so a spawn returns
 * its handle at once: what is written, resized or killed before the process
 * answers waits in the handle's queue, in order, and goes out once it has;
 * the pid is 0 until the answer names it. Writes, resizes and kills go one
 * at a time per terminal, each sent once the one before answered, so the
 * keystrokes keep their order; consecutive writes waiting together go as
 * one. The output comes over one attach stream per terminal; when the
 * stream's deadline ends (`attachTimeoutMs`, an hour by default, under the
 * framework's 24-hour ceiling) the handle re-attaches with the last sequence
 * it saw and the process replays what it missed.
 *
 * A terminal process that stops answering is told three ways: every open
 * handle ends with an exit (code 1, the sentence in the log), a new spawn is
 * refused with `CapabilityUnavailable` naming the process, and `ready()`
 * answers false, which the server's readiness check reports.
 */
import { create } from '@bufbuild/protobuf'
import { Cause, Effect, Exit, Fiber, Scope, Stream } from 'effect'
import { makeClient, GrpcError, Status, type Client } from '@structure-ai/grpc'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { TerminalExit, TerminalProcess, TerminalSpawn, TerminalsService } from './port'
import {
  AttachRequestSchema,
  KillRequestSchema,
  PingRequestSchema,
  ResizeRequestSchema,
  SpawnRefused,
  SpawnRequestSchema,
  Terminals as TerminalsDescriptor,
  UnknownTerminal,
  WriteRequestSchema,
  bearer,
  terminalFailures,
  type TerminalEvent
} from './wire'

export interface GrpcTerminalsOptions {
  /** `host:port` of the terminal process. */
  readonly address: string
  readonly token: string
  /** The deadline of a unary call (spawn, write, resize, kill, ping). */
  readonly callTimeoutMs?: number
  /** The deadline of an attach stream, after which the handle re-attaches. */
  readonly attachTimeoutMs?: number
  readonly log?: (line: string) => void
}

export interface GrpcTerminals extends TerminalsService {
  readonly address: string
  /** Whether the process answers a ping right now. */
  ready(): Promise<boolean>
  /** Whether the process was found gone; stays true once it is. */
  down(): boolean
  close(): Promise<void>
}

type Op =
  | { kind: 'write'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'kill'; signal: string | undefined }

const CALL_TIMEOUT_MS = 10_000
const ATTACH_TIMEOUT_MS = 3_600_000

/** The exit a handle reports when its terminal was lost rather than ended. */
export const LOST_EXIT: TerminalExit = { exitCode: 1 }

const describe = (error: unknown): string =>
  error instanceof SpawnRefused
    ? `spawn refused: ${error.reason}`
    : error instanceof UnknownTerminal
      ? `unknown terminal ${error.id}`
      : error instanceof GrpcError
        ? `${error.message} (gRPC ${error.code})`
        : error instanceof Error
          ? error.message
          : String(error)

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit)
    ? Cause.failureOption(exit.cause).pipe((o) => (o._tag === 'Some' ? o.value : undefined))
    : undefined

/** The process is not there, or will never take this port's calls: both
 *  are for good. */
const isGone = (error: unknown): boolean =>
  error instanceof GrpcError &&
  (error.code === Status.UNAVAILABLE || error.code === Status.UNAUTHENTICATED)

const whyGone = (error: unknown): string =>
  error instanceof GrpcError && error.code === Status.UNAUTHENTICATED
    ? 'it refused the token this server holds'
    : describe(error)

export function grpcTerminals(options: GrpcTerminalsOptions): GrpcTerminals {
  const log = options.log ?? (() => {})
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
  const attachTimeoutMs = options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS
  const metadata = bearer(options.token)
  const scope = Effect.runSync(Scope.make())
  const client: Client<typeof TerminalsDescriptor, typeof terminalFailures> = Effect.runSync(
    makeClient(TerminalsDescriptor, {
      address: options.address,
      security: { mode: 'insecure' },
      failures: terminalFailures
    }).pipe(Scope.extend(scope))
  )

  let down: string | null = null
  let closing = false
  const live = new Set<Remote>()

  const markDown = (why: string): void => {
    if (down !== null) return
    down = why
    log(`the terminal process at ${options.address} is gone: ${why}`)
    for (const remote of [...live]) remote.lost(why)
  }

  const call = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(effect)

  class Remote implements TerminalProcess {
    private id: string | null = null
    private _pid = 0
    private ended = false
    private readonly ops: Op[] = []
    private inFlight = false
    private after = 0n
    /** The attach stream in flight, interrupted on close so the process
     *  sees the stream go and starts its grace period. */
    private following: Fiber.RuntimeFiber<unknown, unknown> | null = null
    private readonly dataListeners = new Set<(data: string) => void>()
    private readonly exitListeners = new Set<(exit: TerminalExit) => void>()

    constructor(private readonly spec: TerminalSpawn) {
      live.add(this)
      void this.start()
    }

    get pid(): number {
      return this._pid
    }

    write(data: string): void {
      if (this.ended) return
      this.ops.push({ kind: 'write', data })
      this.pump()
    }

    resize(cols: number, rows: number): void {
      if (this.ended) return
      this.ops.push({ kind: 'resize', cols, rows })
      this.pump()
    }

    kill(signal?: string): void {
      if (this.ended) return
      this.ops.push({ kind: 'kill', signal })
      this.pump()
    }

    onData(listener: (data: string) => void): () => void {
      this.dataListeners.add(listener)
      return () => this.dataListeners.delete(listener)
    }

    onExit(listener: (exit: TerminalExit) => void): () => void {
      this.exitListeners.add(listener)
      return () => this.exitListeners.delete(listener)
    }

    /** The terminal is gone without an exit of its own. */
    lost(why: string): void {
      if (this.ended) return
      log(`terminal ${this.id ?? '(not yet spawned)'} lost: ${why}`)
      this.finish(LOST_EXIT)
    }

    private finish(exit: TerminalExit): void {
      if (this.ended) return
      this.ended = true
      this.ops.length = 0
      live.delete(this)
      // Nothing after the exit: the stream still open on a lost terminal
      // is cancelled, so the process sees it detached, and no listener
      // hears output after the exit it was told of.
      this.dataListeners.clear()
      void this.detach()
      for (const listener of this.exitListeners) listener(exit)
    }

    /** Stop following: the stream is cancelled on the wire. */
    detach(): Promise<void> {
      const fiber = this.following
      this.following = null
      return fiber
        ? Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined)
        : Promise.resolve()
    }

    private async start(): Promise<void> {
      const exit = await call(
        client.spawn(
          create(SpawnRequestSchema, {
            file: this.spec.file,
            args: [...this.spec.args],
            cwd: this.spec.cwd,
            env: { ...this.spec.env },
            cols: this.spec.cols,
            rows: this.spec.rows,
            name: this.spec.name ?? ''
          }),
          { metadata, timeoutMs: callTimeoutMs }
        )
      )
      if (Exit.isSuccess(exit)) {
        this.id = exit.value.id
        this._pid = exit.value.pid
        this.pump()
        void this.follow()
        return
      }
      const error = failureOf(exit)
      if (isGone(error)) markDown(whyGone(error))
      else log(`spawn of ${this.spec.file} failed: ${describe(error ?? exit.cause)}`)
      this.finish(LOST_EXIT)
    }

    private pump(): void {
      if (this.inFlight || this.ended || this.id === null || this.ops.length === 0) return
      const id = this.id
      let op = this.ops.shift()!
      if (op.kind === 'write') {
        let data = op.data
        while (this.ops[0]?.kind === 'write') data += (this.ops.shift() as { data: string }).data
        op = { kind: 'write', data }
      }
      const options = { metadata, timeoutMs: callTimeoutMs }
      const effect: Effect.Effect<unknown, GrpcError | UnknownTerminal> =
        op.kind === 'write'
          ? client.write(create(WriteRequestSchema, { id, data: op.data }), options)
          : op.kind === 'resize'
            ? client.resize(
                create(ResizeRequestSchema, { id, cols: op.cols, rows: op.rows }),
                options
              )
            : client.kill(create(KillRequestSchema, { id, signal: op.signal ?? '' }), options)
      this.inFlight = true
      void call(effect).then((exit) => {
        this.inFlight = false
        if (Exit.isFailure(exit)) {
          const error = failureOf(exit)
          if (isGone(error)) return markDown(whyGone(error))
          log(`${op.kind} on terminal ${id} failed: ${describe(error ?? exit.cause)}`)
          // The process does not hold this terminal any more: the attach
          // stream is what reports its end; nothing queued can land.
          if (error instanceof UnknownTerminal) this.ops.length = 0
        }
        this.pump()
      })
    }

    /** One attach stream after another, each from the last sequence seen,
     *  until the exit arrives or the terminal is lost. */
    private async follow(): Promise<void> {
      const id = this.id!
      let attempts = 0
      while (!this.ended && !closing) {
        const fiber = Effect.runFork(
          client
            .attach(create(AttachRequestSchema, { id, after: this.after }), {
              metadata,
              timeoutMs: attachTimeoutMs
            })
            .pipe(Stream.runForEach((event) => Effect.sync(() => this.onEvent(event))))
        )
        this.following = fiber
        const exit = await Effect.runPromise(Fiber.await(fiber))
        this.following = null
        if (this.ended || closing) return
        const error = failureOf(exit)
        if (
          Exit.isSuccess(exit) ||
          (error instanceof GrpcError && error.code === Status.DEADLINE_EXCEEDED)
        ) {
          // The stream ended on its deadline, or the process closed it
          // without an exit: re-attach from where this handle is.
          continue
        }
        if (error instanceof UnknownTerminal) {
          log(`terminal ${id} is no longer held by the process`)
          return this.finish(LOST_EXIT)
        }
        // A CANCELLED here is the process's doing (its server closing its
        // calls), not this handle's: its own cancel returns above.
        attempts += 1
        if (isGone(error)) return markDown(whyGone(error))
        const answer = await ping()
        if (answer === 'gone') return
        if (attempts > 3) {
          log(
            `attach to terminal ${id} failed ${attempts} times, the terminal is given up: ${describe(error ?? exit.cause)}`
          )
          return this.finish(LOST_EXIT)
        }
        log(`attach to terminal ${id} failed, trying again: ${describe(error ?? exit.cause)}`)
      }
    }

    private onEvent(event: TerminalEvent): void {
      if (event.seq > this.after) this.after = event.seq
      switch (event.event.case) {
        case 'output':
          for (const listener of this.dataListeners) listener(event.event.value.data)
          return
        case 'exited': {
          const { exitCode, signal } = event.event.value
          this.finish({ exitCode, ...(signal !== undefined && { signal }) })
          return
        }
        case 'gap':
          log(`terminal ${this.id}: ${event.event.value.lost} output events were lost on re-attach`)
          return
        default:
          return
      }
    }
  }

  /** One ping. `gone` is UNAVAILABLE, the process not there, and marks it
   *  down for good; `slow` is any other failure (a stall past the deadline,
   *  a refused token), answered as not ready this time and nothing more,
   *  because a process that is alive and late must not lose its terminals. */
  const ping = async (): Promise<'ok' | 'slow' | 'gone'> => {
    if (down !== null) return 'gone'
    const exit = await call(
      client.ping(create(PingRequestSchema), {
        metadata,
        timeoutMs: Math.min(callTimeoutMs, 2_000)
      })
    )
    if (Exit.isSuccess(exit)) return 'ok'
    const error = failureOf(exit)
    if (isGone(error)) {
      markDown(whyGone(error))
      return 'gone'
    }
    log(`ping failed, the process is not answering yet: ${describe(error ?? exit.cause)}`)
    return 'slow'
  }

  return {
    address: options.address,
    spawn(spec) {
      if (closing)
        throw new CapabilityUnavailable({
          capability: 'terminals',
          message: 'This server is stopping and starts no more terminals.'
        })
      if (down !== null)
        throw new CapabilityUnavailable({
          capability: 'terminals',
          message: `The terminal process at ${options.address} is gone (${down}): this server cannot start a terminal until the pair is started again.`
        })
      return new Remote(spec)
    },
    ready: async () => (await ping()) === 'ok',
    down: () => down !== null,
    close: async () => {
      closing = true
      // The streams first, so the process sees every terminal detached and
      // starts their grace, then the channel.
      await Promise.all([...live].map((remote) => remote.detach()))
      await Effect.runPromise(Scope.close(scope, Exit.void))
      for (const remote of [...live]) remote.lost('the server closed its terminal client')
    }
  }
}
