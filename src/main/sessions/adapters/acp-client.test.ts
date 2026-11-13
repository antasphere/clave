import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AcpConnection,
  AcpRpcError,
  JSON_RPC_METHOD_NOT_FOUND,
  type RpcNotification,
  type RpcRequest
} from './acp-client'

/** A tiny JSON-RPC peer: each method the client calls is a behaviour. */
const PEER = String.raw`
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
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
    if (frame.method === undefined && frame.id === 1) {
      // The client's answer to our request 1: release the held request.
      out({ jsonrpc: '2.0', id: held, result: { held: true, answer: frame.result ?? frame.error } })
      continue
    }
    switch (frame.method) {
      case 'echo': out({ jsonrpc: '2.0', id: frame.id, result: frame.params ?? null }); break
      case 'split': {
        const line = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { split: 'é-done' } }) + '\n'
        const bytes = Buffer.from(line)
        const cut = bytes.indexOf(Buffer.from('é')) + 1
        process.stdout.write(bytes.subarray(0, cut))
        setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50)
        break
      }
      case 'concat':
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 1 } }) + '\n' +
          'not json at all\n' +
          JSON.stringify({ id: frame.id, result: 'no jsonrpc field' }) + '\n' +
          JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'unknown id' }) + '\n' +
          JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: 'second' }) + '\n'
        )
        break
      case 'hold':
        held = frame.id
        out({ jsonrpc: '2.0', id: frame.id, method: 'ask', params: { from: 'agent' } })
        break
      case 'refuse': out({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'Not signed in' } }); break
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
    notification: Mock<(frame: RpcNotification) => void>
    request: Mock<(frame: RpcRequest) => void>
    error: Mock<(error: Error) => void>
    exit: Mock<(code: number, stderr?: string) => void>
  }
  connection: AcpConnection
  stderr(): string
}

function peer(args: string[] = [], timeout = 30_000): Peer {
  const child = spawn(process.execPath, ['-e', PEER, '--', ...args], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const callbacks = {
    notification: vi.fn<(frame: RpcNotification) => void>(),
    request: vi.fn<(frame: RpcRequest) => void>(),
    error: vi.fn<(error: Error) => void>(),
    exit: vi.fn<(code: number, stderr?: string) => void>()
  }
  const connection = new AcpConnection(child, callbacks, timeout)
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

describe('AcpConnection', () => {
  it('reads a frame split across chunks, even inside a UTF-8 character', async () => {
    const { connection } = peer()
    await expect(connection.request('split')).resolves.toEqual({ split: 'é-done' })
  })

  it('reads frames concatenated in one chunk, ignoring what is not JSON-RPC 2.0', async () => {
    const { connection, callbacks } = peer()
    await expect(connection.request('concat')).resolves.toBe('second')
    expect(callbacks.notification).toHaveBeenCalledWith({ method: 'note', params: { n: 1 } })
    // "not json at all" and the frame without `jsonrpc`; the unknown id is dropped silently.
    expect(connection.ignoredLines).toBe(2)
    expect(callbacks.error).not.toHaveBeenCalled()
  })

  it("keeps the client's ids and the agent's ids apart", async () => {
    const { connection, callbacks } = peer()
    callbacks.request.mockImplementation((frame) => {
      expect(frame).toEqual({ id: 1, method: 'ask', params: { from: 'agent' } })
      connection.respond(frame.id, { yes: true })
    })
    // The client's request 1 is pending when the agent sends its own request 1.
    await expect(connection.request('hold')).resolves.toEqual({
      held: true,
      answer: { yes: true }
    })
    expect(callbacks.request).toHaveBeenCalledTimes(1)
  })

  it('writes respond, reject and notify in the JSON-RPC 2.0 shape', async () => {
    const { connection, stderr } = peer()
    connection.respond(7, { outcome: { outcome: 'cancelled' } })
    connection.reject('x', JSON_RPC_METHOD_NOT_FOUND, 'Method not found')
    connection.notify('record', { a: 1 })
    await connection.request('echo')
    await vi.waitFor(() => expect(stderr().trim().split('\n')).toHaveLength(4))
    expect(
      stderr()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'Method not found' } },
      { jsonrpc: '2.0', method: 'record', params: { a: 1 } },
      { jsonrpc: '2.0', id: 1, method: 'echo' }
    ])
  })

  it('refuses with the agent error code and message', async () => {
    const { connection } = peer()
    const error = await connection.request('refuse').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcpRpcError)
    expect(error).toMatchObject({ code: -32000, message: 'Not signed in' })
  })

  it('times a request out at the given timeout, and null disables it', async () => {
    const { connection } = peer()
    const started = Date.now()
    await expect(connection.request('never', undefined, { timeout: 100 })).rejects.toThrow(
      'did not answer never in time'
    )
    expect(Date.now() - started).toBeLessThan(2000)
    const { connection: patient } = peer([], 100)
    let settled = false
    const waiting = patient.request('never', undefined, { timeout: null }).then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    await patient.close()
    await waiting
  })

  it('rejects every pending request when the child exits, naming the code', async () => {
    const { connection, callbacks } = peer()
    const a = connection.request('never', undefined, { timeout: null })
    const b = connection.request('never')
    connection.notify('die')
    await expect(a).rejects.toThrow('exited with code 3')
    await expect(b).rejects.toThrow('exited with code 3')
    expect(callbacks.exit).toHaveBeenCalledWith(3, expect.any(String))
  })

  it('close ends the child: SIGTERM, then SIGKILL after 3 s for one that ignores it', async () => {
    const { connection, child } = peer()
    await connection.request('echo', {})
    await connection.close()
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
    expect(alive(child.pid!)).toBe(false)

    const stubborn = peer(['--ignore-term'])
    await stubborn.connection.request('echo', {})
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
