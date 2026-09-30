import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, it, expect, vi } from 'vitest'
import { CodexAppServer } from './codex-app-server'

function setup(timeout = 1000): {
  client: CodexAppServer
  child: EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  callbacks: {
    notification: ReturnType<typeof vi.fn>
    request: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
    exit: ReturnType<typeof vi.fn>
  }
  writes: Record<string, unknown>[]
  receive(frame: unknown): void
} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0))
      return true
    })
  })
  const callbacks = { notification: vi.fn(), request: vi.fn(), error: vi.fn(), exit: vi.fn() }
  const writes: Record<string, unknown>[] = []
  child.stdin.on('data', (data) => writes.push(JSON.parse(data.toString())))
  const client = new CodexAppServer(
    child as unknown as ChildProcessWithoutNullStreams,
    callbacks,
    timeout
  )
  const receive = (frame: unknown): void => {
    child.stdout.write(JSON.stringify(frame) + '\n')
  }
  return { client, child, callbacks, writes, receive }
}
describe('Codex stdio JSON-RPC', () => {
  it('correlates out-of-order replies and independent server ids across chunk boundaries', async () => {
    const { client, child, callbacks, writes, receive } = setup()
    const first = client.request('first', { a: 1 })
    const second = client.request('second')
    expect(writes.map((f) => f.id)).toEqual([1, 2])
    receive({ id: 2, result: 'second result' })
    child.stdout.write('{"method":"stream","params":{"delta":"hé')
    child.stdout.write('llo"}}\n')
    receive({ id: 1, method: 'approve', params: { command: 'echo' } })
    expect(callbacks.request).toHaveBeenCalledWith({
      id: 1,
      method: 'approve',
      params: { command: 'echo' }
    })
    client.respond(1, { decision: 'cancel' })
    expect(writes[2]).toEqual({ id: 1, result: { decision: 'cancel' } })
    receive({ id: 1, result: 'first result' })
    expect(await first).toBe('first result')
    expect(await second).toBe('second result')
    expect(callbacks.notification).toHaveBeenCalledWith({
      method: 'stream',
      params: { delta: 'héllo' }
    })
    expect(() => client.respond(1, {})).toThrow('Unknown')
    await client.close()
  })
  it('rejects protocol errors, times out requests, and tolerates their late replies', async () => {
    const { client, receive } = setup(10)
    const failure = client.request('bad')
    receive({ id: 1, error: { code: -1, message: 'No thread' } })
    await expect(failure).rejects.toThrow('No thread')
    await expect(client.request('slow')).rejects.toThrow('timed out')
    receive({ id: 2, result: {} })
    await client.close()
  })
  it('disconnect rejects every pending call and emits exit once', async () => {
    const { client, child, callbacks } = setup()
    const a = client.request('a')
    const b = client.request('b')
    const checks = Promise.all([
      expect(a).rejects.toThrow('disconnected'),
      expect(b).rejects.toThrow('disconnected')
    ])
    child.emit('close', 7)
    await checks
    expect(callbacks.exit).toHaveBeenCalledExactlyOnceWith(7, '')
    await expect(client.request('c')).rejects.toThrow('closed')
    await client.close()
  })
  it.each(['not json\n', '[]\n', '{"id":1}\n', 'x'.repeat(16 * 1024 * 1024 + 1)])(
    'fails closed on malformed or oversized input (%#)',
    async (data) => {
      const { client, child, callbacks } = setup()
      child.stdout.write(data)
      await client.close()
      expect(callbacks.error).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledTimes(1)
    }
  )
  it('reports spawn failure, rejects pending initialization, and closes cleanly', async () => {
    const { client, child, callbacks } = setup()
    const pending = client.request('initialize')
    const check = expect(pending).rejects.toThrow('closed')
    child.emit('error', new Error('ENOENT'))
    await check
    await client.close()
    expect(callbacks.error.mock.calls[0][0].message).toBe('ENOENT')
  })
  it('returns a JSON-RPC error for unsupported server requests', async () => {
    const { client, receive, writes } = setup()
    receive({ id: 'server-id', method: 'unknown' })
    client.reject('server-id', 'Unsupported')
    expect(writes[0]).toEqual({ id: 'server-id', error: { code: -32601, message: 'Unsupported' } })
    await client.close()
  })
})

it('retains only the last 4 KiB of stderr for abnormal-exit diagnostics', () => {
  const { child, callbacks } = setup()
  child.stderr.write('discarded prefix\n' + 'x'.repeat(5000))
  child.stderr.write('\nError: invalid Codex configuration')
  child.emit('close', 1)
  expect(callbacks.exit).toHaveBeenCalledTimes(1)
  const [code, stderr] = callbacks.exit.mock.calls[0]
  expect(code).toBe(1)
  expect(Buffer.byteLength(stderr)).toBe(4096)
  expect(stderr).not.toContain('discarded prefix')
  expect(stderr).toMatch(/Error: invalid Codex configuration$/)
})
