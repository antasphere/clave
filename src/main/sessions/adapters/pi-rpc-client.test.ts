import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { PiRpcConnection, PiRpcError, type PiRpcEvent } from './pi-rpc-client'

/** A tiny Pi-shaped peer: each command type the client sends is a behaviour. */
const PEER = String.raw`
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const ok = (frame, data) => out({ id: frame.id, type: 'response', command: frame.type, success: true, ...(data === undefined ? {} : { data }) })
let held
let buffer = ''
if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) !== -1) {
    const frame = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    process.stderr.write(JSON.stringify(frame) + '\n')
    switch (frame.type) {
      case 'echo': ok(frame, frame.params ?? null); break
      case 'empty': ok(frame); break
      case 'split': {
        const line = JSON.stringify({ id: frame.id, type: 'response', command: 'split', success: true, data: { split: 'é-done' } }) + '\n'
        const bytes = Buffer.from(line)
        const cut = bytes.indexOf(Buffer.from('é')) + 1
        process.stdout.write(bytes.subarray(0, cut))
        setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50)
        break
      }
      case 'concat':
        process.stdout.write(
          JSON.stringify({ type: 'agent_start' }) + '\n' +
          'not json at all\n' +
          JSON.stringify({ no: 'type' }) + '\n' +
          JSON.stringify({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' }) + '\n' +
          JSON.stringify({ id: 'c9999', type: 'response', command: 'late', success: true }) + '\n' +
          JSON.stringify({ type: 'turn_start' }) + '\n' +
          JSON.stringify({ id: frame.id, type: 'response', command: 'concat', success: true, data: 'second' }) + '\n'
        )
        break
      case 'hold': held = frame; break
      case 'release':
        out({ type: 'message_update', n: 1 })
        ok(frame, 'released')
        out({ type: 'message_update', n: 2 })
        ok(held, 'held')
        out({ type: 'message_update', n: 3 })
        break
      case 'refuse': out({ id: frame.id, type: 'response', command: 'refuse', success: false, error: 'Model not found: x/y' }); break
      case 'die': process.exit(3)
      case 'never': break
    }
  }
})
`

const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
})

interface Peer {
  child: ChildProcessWithoutNullStreams
  callbacks: {
    event: Mock<(frame: PiRpcEvent) => void>
    error: Mock<(error: Error) => void>
    exit: Mock<(code: number, stderr?: string) => void>
  }
  connection: PiRpcConnection
  stderr(): string
}

function peer(args: string[] = [], timeout = 30_000): Peer {
  const child = spawn(process.execPath, ['-e', PEER, '--', ...args], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const callbacks = {
    event: vi.fn<(frame: PiRpcEvent) => void>(),
    error: vi.fn<(error: Error) => void>(),
    exit: vi.fn<(code: number, stderr?: string) => void>()
  }
  const connection = new PiRpcConnection(child, callbacks, timeout)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  return { child, callbacks, connection, stderr: () => stderr }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('PiRpcConnection', () => {
  it('reads a frame split across chunks, even inside a UTF-8 character', async () => {
    const { connection } = peer()
    await expect(connection.command('split')).resolves.toEqual({ split: 'é-done' })
  })

  it('reads frames concatenated in one chunk: events in order, non-JSON counted', async () => {
    const { connection, callbacks } = peer()
    await expect(connection.command('concat')).resolves.toBe('second')
    expect(callbacks.event.mock.calls.map((call) => call[0])).toEqual([
      { type: 'agent_start' },
      // A response no command waits on is an event, so a parse failure shows.
      { type: 'response', command: 'parse', success: false, error: 'Failed to parse command' },
      { id: 'c9999', type: 'response', command: 'late', success: true },
      { type: 'turn_start' }
    ])
    // "not json at all", and the object with no type.
    expect(connection.ignoredLines).toBe(2)
    expect(callbacks.error).not.toHaveBeenCalled()
  })

  it('correlates responses by id out of order, events delivered in order between them', async () => {
    const { connection, callbacks } = peer()
    const order: string[] = []
    callbacks.event.mockImplementation((frame) => order.push(`event ${String(frame.n)}`))
    const held = connection.command('hold').then((data) => order.push(`hold ${String(data)}`))
    const released = connection
      .command('release')
      .then((data) => order.push(`release ${String(data)}`))
    await Promise.all([held, released])
    // The third event may come in a later chunk than the last answer: waited
    // for, never read early (verifier round 3).
    await expect.poll(() => order.filter((entry) => entry.startsWith('event')).length).toBe(3)
    // Events go out synchronously as each line is read; a resolution after.
    expect(order.filter((entry) => entry.startsWith('event'))).toEqual([
      'event 1',
      'event 2',
      'event 3'
    ])
    expect(order).toContain('hold held')
    expect(order).toContain('release released')
  })

  it('sends { id, type, ...params } with unique ids, and send() frames as they are', async () => {
    const { connection, stderr } = peer()
    await connection.command('echo', { message: 'hi', id: 'spoofed', type: 'spoofed' })
    await connection.command('empty')
    connection.send({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
    await connection.command('echo')
    await vi.waitFor(() => expect(stderr().trim().split('\n')).toHaveLength(4))
    expect(
      stderr()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { id: 'c1', type: 'echo', message: 'hi' },
      { id: 'c2', type: 'empty' },
      { type: 'extension_ui_response', id: 'ui-1', cancelled: true },
      { id: 'c3', type: 'echo' }
    ])
  })

  it('resolves data, undefined when Pi returns none', async () => {
    const { connection } = peer()
    await expect(connection.command('empty')).resolves.toBeUndefined()
  })

  it('a refusal rejects with PiRpcError carrying Pi’s error', async () => {
    const { connection } = peer()
    const error = await connection.command('refuse').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PiRpcError)
    expect(error).toMatchObject({ message: 'Model not found: x/y', command: 'refuse' })
  })

  it('times a command out at the given timeout, and null disables it', async () => {
    const { connection } = peer()
    const started = Date.now()
    await expect(connection.command('never', undefined, { timeout: 100 })).rejects.toThrow(
      'did not answer never in time'
    )
    expect(Date.now() - started).toBeLessThan(2000)
    const { connection: patient } = peer([], 100)
    let settled = false
    const waiting = patient.command('never', undefined, { timeout: null }).then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    await patient.close()
    await waiting
  })

  it('rejects every pending command when the child exits, naming the code', async () => {
    const { connection, callbacks } = peer()
    const a = connection.command('never', undefined, { timeout: null })
    const b = connection.command('never')
    connection.send({ type: 'die' })
    await expect(a).rejects.toThrow('exited with code 3')
    await expect(b).rejects.toThrow('exited with code 3')
    expect(callbacks.exit).toHaveBeenCalledWith(3, expect.any(String))
    await expect(connection.command('echo')).rejects.toThrow('closed')
  })

  it('close ends the child: SIGTERM, then SIGKILL after 3 s for one that ignores it', async () => {
    const { connection, child } = peer()
    await connection.command('echo', {})
    const pending = expect(
      connection.command('never', undefined, { timeout: null })
    ).rejects.toThrow('was closed')
    await connection.close()
    await pending
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
    expect(alive(child.pid!)).toBe(false)

    const stubborn = peer(['--ignore-term'])
    await stubborn.connection.command('echo', {})
    const kill = vi.spyOn(stubborn.child, 'kill')
    const started = Date.now()
    await stubborn.connection.close()
    const elapsed = Date.now() - started
    expect(kill.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(stubborn.child.signalCode).toBe('SIGKILL')
    expect(alive(stubborn.child.pid!)).toBe(false)
  }, 10_000)
})
