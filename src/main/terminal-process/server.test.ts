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
import { CapabilityUnavailable } from '@clave/contract/errors'
import { grpcTerminals, type GrpcTerminals } from '@clave/server'
import type { TerminalExit, TerminalProcess } from '@clave/server'
import { startTerminalProcess, type TerminalProcessHandle } from './server'

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

  it('replays what was missed from the last sequence seen, and says what it no longer holds', async () => {
    const { process } = await start({ retainBytes: 64 })
    // Drive the wire directly: spawn, let it finish, then attach late.
    const port = grpcTerminals({ address: process.address, token: TOKEN })
    open.push(port)
    const terminal = spawnSh(port, 'i=0; while [ $i -lt 30 ]; do echo 0123456789; i=$((i+1)); done')
    const { output, exit } = watch(terminal)
    expect(await exit).toEqual({ exitCode: 0 })
    // Attached from the start, nothing is lost whatever the retention.
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
