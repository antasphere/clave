import { describe, it, expect } from 'vitest'
import { nodePtyTerminals, type TerminalProcess } from './terminal'

/**
 * The one terminal adapter, node-pty, driven under plain Node: the port is
 * what the terminal backend sees of a process, so what crosses it (the data
 * as text, the exit as a code, the four verbs) is proven on the real module,
 * not on a mock of it.
 */
const terminals = nodePtyTerminals()

function spawnShell(command: string, env: Record<string, string> = {}): TerminalProcess {
  return terminals.spawn({
    file: '/bin/sh',
    args: ['-c', command],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', ...env },
    cols: 80,
    rows: 24,
    name: 'xterm-256color'
  })
}

function exitOf(process: ReturnType<typeof spawnShell>): Promise<number> {
  return new Promise((resolve) => process.onExit(({ exitCode }) => resolve(exitCode)))
}

describe('nodePtyTerminals', () => {
  it('delivers the output as text and the exit as the code the command left', async () => {
    const process = spawnShell('printf hello-from-pty; exit 3')
    let output = ''
    process.onData((data) => {
      output += data
    })
    expect(process.pid).toBeGreaterThan(0)
    expect(await exitOf(process)).toBe(3)
    expect(output).toContain('hello-from-pty')
  })

  it('writes reach the process, and the environment is the one given', async () => {
    const process = spawnShell('read line; printf "got:%s:%s" "$line" "$CLAVE_PORT_TEST"', {
      CLAVE_PORT_TEST: 'through-the-port'
    })
    let output = ''
    process.onData((data) => {
      output += data
    })
    process.write('typed-in\r')
    expect(await exitOf(process)).toBe(0)
    expect(output).toContain('got:typed-in:through-the-port')
  })

  it('resizes without complaint, and a kill ends the process', async () => {
    const process = spawnShell('sleep 30')
    process.resize(132, 44)
    process.resize(0, 0)
    const exit = exitOf(process)
    process.kill()
    await expect(exit).resolves.toBeTypeOf('number')
  })

  it('an unsubscribed listener hears nothing more', async () => {
    const process = spawnShell('printf first; sleep 0.2; printf second')
    let output = ''
    const stop = process.onData((data) => {
      output += data
      if (output.includes('first')) stop()
    })
    await exitOf(process)
    expect(output).toContain('first')
    expect(output).not.toContain('second')
  })
})
