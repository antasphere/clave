/**
 * The terminal process and the server's port over the wire to it, both in
 * this process: `startTerminalProcess` over node-pty on a loopback port,
 * `grpcTerminals` on the framework's client. What is pinned: the bytes of a
 * real shell, a write that keeps its order, a resize the shell sees, a kill,
 * the exit code and the signal, a wrong token refused before any handler,
 * the re-attach past a stream's deadline with no output lost, a terminal
 * nobody attaches to hung up by the process, and a process gone: the open
 * terminals end, a new spawn is refused with the capability error, the
 * readiness answer turns false.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { Chunk, Effect, Exit, Scope, Stream } from 'effect'
import { makeClient } from '@structure-ai/grpc'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { grpcTerminals, type GrpcTerminals } from '@clave/server'
import type { TerminalExit, TerminalProcess } from '@clave/server'
import {
  AttachRequestSchema,
  SpawnRequestSchema,
  Terminals as TerminalsDescriptor,
  bearer,
  terminalFailures,
  type TerminalEvent
} from '@clave/server/terminals-wire'
import { startTerminalProcess, type PtyLike, type TerminalProcessHandle } from './server'

const TOKEN = 'a-token-for-the-test'
const SH = '/bin/sh'
const ENV = { PATH: '/bin:/usr/bin', TERM: 'xterm-256color' }

const spawnSh = (port: GrpcTerminals, script: string, cols = 80, rows = 24): TerminalProcess =>
  port.spawn({ file: SH, args: ['-c', script], cwd: '/', env: ENV, cols, rows })

/** Collect a terminal's output and its exit. */
const watch = (
  terminal: TerminalProcess
): { output: () => string; exit: Promise<TerminalExit> } => {
  let output = ''
  terminal.onData((data) => {
    output += data
  })
  const exit = new Promise<TerminalExit>((resolve) => terminal.onExit(resolve))
  return { output: () => output, exit }
}

const until = async (predicate: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!predicate()) throw new Error(`not true within ${ms} ms`)
}

describe('the terminal process and the port over the wire to it', () => {
  const open: Array<TerminalProcessHandle | GrpcTerminals> = []
  afterEach(async () => {
    for (const handle of open.splice(0).reverse()) await handle.close()
  })

  const start = async (
    options: Partial<Parameters<typeof startTerminalProcess>[0]> = {},
    client: Partial<Parameters<typeof grpcTerminals>[0]> = {}
  ): Promise<{ process: TerminalProcessHandle; port: GrpcTerminals }> => {
    const process = await startTerminalProcess({ token: TOKEN, ...options })
    const port = grpcTerminals({ address: process.address, token: TOKEN, ...client })
    open.push(process, port)
    return { process, port }
  }

  it('streams the bytes of a shell, carries a write in order, and reports the exit code', async () => {
    const { port } = await start()
    const terminal = spawnSh(port, 'read a; read b; echo "got:$a:$b"; exit 7')
    const { output, exit } = watch(terminal)
    // Written before the spawn has answered: queued, in order.
    terminal.write('first\n')
    terminal.write('second\n')
    expect(await exit).toEqual({ exitCode: 7 })
    expect(output()).toContain('got:first:second')
    expect(terminal.pid).toBeGreaterThan(0)
  })

  it('resizes the terminal the shell sees, and a kill ends it with its signal', async () => {
    const { port } = await start()
    const terminal = spawnSh(port, 'stty size; read x; stty size; echo done', 80, 24)
    const { output, exit } = watch(terminal)
    await until(() => output().includes('24 80'))
    terminal.resize(132, 50)
    terminal.write('\n')
    await until(() => output().includes('50 132'))
    expect(await exit).toEqual({ exitCode: 0 })

    const sleeper = spawnSh(port, 'sleep 30')
    const sleeping = watch(sleeper)
    await until(() => sleeper.pid > 0)
    sleeper.kill('SIGTERM')
    const exited = await sleeping.exit
    expect(exited.signal).toBe(15)
  })

  it('refuses a caller without the token before any handler runs', async () => {
    const { process, port } = await start()
    const wrong = grpcTerminals({ address: process.address, token: 'not-the-token' })
    open.push(wrong)
    expect(await wrong.ready()).toBe(false)
    expect(wrong.down()).toBe(true)
    expect(() => spawnSh(wrong, 'echo never')).toThrow(CapabilityUnavailable)
    // The right token on the same process still works.
    expect(await port.ready()).toBe(true)
    expect(process.terminals()).toBe(0)
  })

  it('re-attaches past the attach stream deadline and loses no output', async () => {
    const { port } = await start({}, { attachTimeoutMs: 150 })
    // Ten lines, 60 ms apart: the stream's deadline falls inside them.
    const terminal = spawnSh(
      port,
      'i=0; while [ $i -lt 10 ]; do echo line-$i; i=$((i+1)); sleep 0.06; done'
    )
    const { output, exit } = watch(terminal)
    expect(await exit).toEqual({ exitCode: 0 })
    for (let i = 0; i < 10; i++) expect(output()).toContain(`line-${i}`)
    expect(output().match(/line-/g)?.length).toBe(10)
  })

  it('loses nothing written between the spawn and the first attach, whatever the ring holds', async () => {
    const { process } = await start({ retainBytes: 64 })
    const port = grpcTerminals({ address: process.address, token: TOKEN })
    open.push(port)
    // Thirty lines at once: written before the handle's first attach has
    // reached the process, far beyond a 64-byte ring.
    const terminal = spawnSh(port, 'i=0; while [ $i -lt 30 ]; do echo 0123456789; i=$((i+1)); done')
    const { output, exit } = watch(terminal)
    expect(await exit).toEqual({ exitCode: 0 })
    expect(output().match(/0123456789/g)?.length).toBe(30)
  })

  it('hangs up a terminal nobody has attached to for the grace period', async () => {
    const { process } = await start({ orphanGraceMs: 200 })
    const port = grpcTerminals({ address: process.address, token: TOKEN })
    open.push(port)
    const terminal = spawnSh(port, 'sleep 30')
    await until(() => terminal.pid > 0)
    expect(process.terminals()).toBe(1)
    // The caller goes away without a kill: its client closed.
    await port.close()
    await until(() => process.terminals() === 0, 3_000)
  })

  it('a process gone ends the open terminals, refuses a new spawn, and turns readiness false', async () => {
    const { process, port } = await start()
    const terminal = spawnSh(port, 'sleep 30')
    const { exit } = watch(terminal)
    await until(() => terminal.pid > 0)
    expect(await port.ready()).toBe(true)
    await process.close()
    const exited = await exit
    expect(exited).toEqual({ exitCode: 1 })
    expect(await port.ready()).toBe(false)
    expect(port.down()).toBe(true)
    let refused: unknown
    try {
      spawnSh(port, 'echo never')
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(CapabilityUnavailable)
    expect((refused as CapabilityUnavailable).capability).toBe('terminals')
    expect((refused as CapabilityUnavailable).message).toContain(process.address)
  })

  it('a spawn the process cannot do ends with the reason in the log and an exit, not a hang', async () => {
    // node-pty itself reports a missing file or directory as an exit 1 of
    // the child; what throws at spawn is the library refusing its
    // arguments, so the refusal is driven through the injected spawn.
    const lines: string[] = []
    const { port } = await start(
      {
        spawn: () => {
          throw new Error('posix_spawnp failed')
        }
      },
      { log: (line) => lines.push(line) }
    )
    const terminal = spawnSh(port, 'echo never')
    const { exit } = watch(terminal)
    expect(await exit).toEqual({ exitCode: 1 })
    expect(lines.join('\n')).toMatch(/spawn refused: posix_spawnp failed/)
    expect(port.down()).toBe(false)
  })

  it("a missing file or directory is the shell's own exit 1, with the process still up", async () => {
    const { port } = await start()
    const terminal = port.spawn({
      file: SH,
      args: ['-c', 'echo never'],
      cwd: '/this/directory/does/not/exist',
      env: ENV,
      cols: 80,
      rows: 24
    })
    const { exit } = watch(terminal)
    expect(await exit).toEqual({ exitCode: 1 })
    expect(port.down()).toBe(false)
    expect(await port.ready()).toBe(true)
  })
})

/** A terminal the test scripts: it emits exactly what the test says, when
 *  the test says it, and records what was asked of it. */
class FakePty implements PtyLike {
  readonly pid = 4242
  readonly written: string[] = []
  readonly killed: string[] = []
  readonly resized: Array<[number, number]> = []
  private readonly data = new Set<(data: string) => void>()
  private readonly exits = new Set<(exit: { exitCode: number; signal?: number }) => void>()
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGHUP')
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.data.add(listener)
    return { dispose: () => this.data.delete(listener) }
  }
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exits.add(listener)
    return { dispose: () => this.exits.delete(listener) }
  }
  emit(data: string): void {
    for (const listener of this.data) listener(data)
  }
  exit(exitCode: number): void {
    for (const listener of this.exits) listener({ exitCode, signal: 0 })
  }
}

const shape = (event: TerminalEvent): string =>
  event.event.case === 'output'
    ? `${event.seq}:${event.event.value.data}`
    : event.event.case === 'exited'
      ? `${event.seq}:exit ${event.event.value.exitCode}`
      : event.event.case === 'gap'
        ? `${event.seq}:gap ${event.event.value.lost}`
        : `${event.seq}:?`

/** The framework's client on the wire, with the test choosing every call. */
const wire = (
  address: string
): {
  spawn: () => Promise<string>
  /** The events of an attach from `after`, the first `take` of them (all
   *  of them, until the stream ends after the exit, when `take` is absent). */
  attach: (id: string, after: bigint, take?: number) => Promise<string[]>
  attachFails: (id: string, after: bigint) => Promise<unknown>
  close: () => Promise<void>
} => {
  const scope = Effect.runSync(Scope.make())
  const client = Effect.runSync(
    makeClient(TerminalsDescriptor, {
      address,
      security: { mode: 'insecure' },
      failures: terminalFailures
    }).pipe(Scope.extend(scope))
  )
  const metadata = bearer(TOKEN)
  const stream = (id: string, after: bigint): Stream.Stream<TerminalEvent, unknown> =>
    client.attach(create(AttachRequestSchema, { id, after }), { metadata, timeoutMs: 5_000 })
  return {
    spawn: () =>
      Effect.runPromise(
        client.spawn(
          create(SpawnRequestSchema, {
            file: 'fake',
            args: [],
            cwd: '/',
            env: {},
            cols: 80,
            rows: 24
          }),
          { metadata }
        )
      ).then((answer) => answer.id),
    attach: (id, after, take) =>
      Effect.runPromise(
        (take === undefined ? stream(id, after) : stream(id, after).pipe(Stream.take(take))).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Chunk.toArray(chunk).map(shape))
        )
      ),
    attachFails: (id, after) =>
      Effect.runPromiseExit(stream(id, after).pipe(Stream.runDrain)).then((exit) =>
        Exit.isFailure(exit) ? exit.cause : undefined
      ),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('what the process keeps and replays, on the wire with a scripted terminal', () => {
  const open: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    for (const handle of open.splice(0).reverse()) await handle.close()
  })

  const start = async (
    options: Partial<Parameters<typeof startTerminalProcess>[0]> = {}
  ): Promise<{
    process: TerminalProcessHandle
    pty: FakePty
    client: ReturnType<typeof wire>
  }> => {
    const pty = new FakePty()
    const process = await startTerminalProcess({ token: TOKEN, spawn: () => pty, ...options })
    const client = wire(process.address)
    open.push(process, client)
    return { process, pty, client }
  }

  it('an exit while nobody is attached is found by the next attach, after the output before it', async () => {
    const { pty, client } = await start()
    const id = await client.spawn()
    pty.emit('a')
    pty.emit('b')
    pty.exit(3)
    expect(await client.attach(id, 0n)).toEqual(['1:a', '2:b', '3:exit 3'])
  })

  it('an attach from the last sequence seen replays only what came after it', async () => {
    const { pty, client } = await start()
    const id = await client.spawn()
    pty.emit('a')
    pty.emit('b')
    pty.emit('c')
    expect(await client.attach(id, 0n, 3)).toEqual(['1:a', '2:b', '3:c'])
    expect(await client.attach(id, 2n, 1)).toEqual(['3:c'])
    pty.exit(0)
    expect(await client.attach(id, 3n)).toEqual(['4:exit 0'])
    expect(await client.attach(id, 4n)).toEqual([])
  })

  it('keeps every byte written before the first attach, whatever the ring holds', async () => {
    const { pty, client } = await start({ retainBytes: 16 })
    const id = await client.spawn()
    for (let i = 0; i < 50; i++) pty.emit(`line-${String(i).padStart(2, '0')}\n`)
    const events = await client.attach(id, 0n, 50)
    expect(events).toHaveLength(50)
    expect(events[0]).toBe('1:line-00\n')
    expect(events[49]).toBe('50:line-49\n')
  })

  it('once attached, the ring applies and a re-attach past it says what was lost', async () => {
    const { pty, client } = await start({ retainBytes: 16 })
    const id = await client.spawn()
    pty.emit('0123456789\n')
    expect(await client.attach(id, 0n, 1)).toEqual(['1:0123456789\n'])
    // Ten more lines of 11 bytes with a 16-byte ring: the last one is kept.
    for (let i = 0; i < 10; i++) pty.emit(`${i}123456789\n`)
    expect(await client.attach(id, 1n, 2)).toEqual(['1:gap 9', '11:9123456789\n'])
  })

  it('forgets an exited terminal after the grace, not before', async () => {
    const { pty, client, process } = await start({ orphanGraceMs: 200 })
    const id = await client.spawn()
    pty.exit(0)
    await sleep(60)
    expect(await client.attach(id, 0n)).toEqual(['1:exit 0'])
    expect(process.terminals()).toBe(1)
    await sleep(400)
    expect(process.terminals()).toBe(0)
    const cause = await client.attachFails(id, 0n)
    expect(String(cause)).toContain('UnknownTerminal')
  })

  it('hangs up a terminal nobody attached to once the grace has passed, and not before', async () => {
    const { pty, client } = await start({ orphanGraceMs: 300 })
    await client.spawn()
    await sleep(120)
    expect(pty.killed).toEqual([])
    await sleep(400)
    expect(pty.killed).toEqual(['SIGHUP'])
    // Still running after another grace: killed for good.
    await sleep(400)
    expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL'])
  })

  it('hangs up every terminal still running when the process closes', async () => {
    const { pty, client, process } = await start()
    const id = await client.spawn()
    expect(await client.attach(id, 0n, 0)).toEqual([])
    await process.close()
    expect(pty.killed).toEqual(['SIGHUP'])
  })
})
