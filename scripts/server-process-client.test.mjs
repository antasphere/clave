/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test utility */
import { describe, expect, it, vi } from 'vitest'
import { withServerClient } from './server-process-client.mjs'

const fixture = () => {
  const order = []
  const server = {
    pid: 123,
    url: 'http://127.0.0.1:12345',
    processState: vi.fn(() => ({ exitCode: 9, signalCode: null })),
    stderr: vi.fn(() => 'fixture server stopped unexpectedly')
  }
  const client = {
    push: { close: vi.fn(() => order.push('push.close')) },
    api: { dispose: vi.fn(async () => order.push('api.dispose')) }
  }
  return { server, client, order }
}

describe('a server process check and its client cleanup', () => {
  it('runs once, keeps the result and closes both clients without reading diagnostics on success', async () => {
    const { server, client, order } = fixture()
    const check = vi.fn(async (actual) => {
      expect(actual).toBe(client)
      order.push('check')
      return { checks: 3 }
    })
    await expect(withServerClient(server, client, check)).resolves.toEqual({ checks: 3 })
    expect(check).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['check', 'push.close', 'api.dispose'])
    expect(server.processState).not.toHaveBeenCalled()
    expect(server.stderr).not.toHaveBeenCalled()
  })

  it('keeps a failed request as the cause, captures child diagnostics and closes both clients', async () => {
    const { server, client, order } = fixture()
    const original = new Error('connection refused')
    const check = vi.fn(async () => {
      throw original
    })
    const error = await withServerClient(server, client, check).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.cause).toBe(original)
    expect(error.errors).toEqual([original])
    expect(error.message).toContain('123')
    expect(error.message).toContain(server.url)
    expect(error.message).toContain('"exitCode":9')
    expect(error.message).toContain('"signalCode":null')
    expect(error.message).toContain('fixture server stopped unexpectedly')
    expect(check).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['push.close', 'api.dispose'])
  })

  it('preserves a non-Error rejection and still fails', async () => {
    const { server, client } = fixture()
    const error = await withServerClient(server, client, async () => {
      throw undefined
    }).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([undefined])
    expect(client.push.close).toHaveBeenCalledTimes(1)
    expect(client.api.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the API even when closing the push client throws', async () => {
    const { server, client } = fixture()
    const closing = new Error('push close failed')
    client.push.close.mockImplementation(() => {
      throw closing
    })
    const error = await withServerClient(server, client, async () => 'checked').catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([closing])
    expect(client.api.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails on an API disposal error after a successful check', async () => {
    const { server, client } = fixture()
    const disposing = new Error('API disposal failed')
    client.api.dispose.mockRejectedValue(disposing)
    const error = await withServerClient(server, client, async () => 'checked').catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([disposing])
    expect(client.push.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the check error first when both cleanup operations also fail', async () => {
    const { server, client } = fixture()
    const original = new Error('original check failure')
    const closing = new Error('push close failed')
    const disposing = new Error('API disposal failed')
    client.push.close.mockImplementation(() => {
      throw closing
    })
    client.api.dispose.mockRejectedValue(disposing)
    const error = await withServerClient(server, client, () => {
      throw original
    }).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.cause).toBe(original)
    expect(error.errors).toEqual([original, closing, disposing])
    expect(client.push.close).toHaveBeenCalledTimes(1)
    expect(client.api.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports the actual signal without inventing an exit code', async () => {
    const { server, client } = fixture()
    server.processState.mockReturnValue({ exitCode: null, signalCode: 'SIGKILL' })
    const error = await withServerClient(server, client, () => {
      throw new Error('request failed')
    }).catch((e) => e)
    expect(error.message).toContain('"exitCode":null')
    expect(error.message).toContain('"signalCode":"SIGKILL"')
  })

  it('keeps both exit fields null if the process is still running', async () => {
    const { server, client } = fixture()
    server.processState.mockReturnValue({ exitCode: null, signalCode: null })
    const error = await withServerClient(server, client, () => {
      throw new Error('request failed while process remained alive')
    }).catch((e) => e)
    expect(error.message).toContain('"exitCode":null')
    expect(error.message).toContain('"signalCode":null')
  })
})
