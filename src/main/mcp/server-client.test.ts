import { describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import { NO_SERVER_MESSAGE, createServerClient } from './server-client'

/**
 * Main's client of the server: it waits for the boot to name a server, fails
 * at once when the boot has decided there is none, is built once per address
 * and rebuilt when the address changes, the previous one disposed.
 */
const fakeClient = (): ClaveApiClient =>
  ({ dispose: vi.fn(async () => undefined) }) as unknown as ClaveApiClient

describe('the server client of the agent tools', () => {
  it('waits for the boot to name a server, then connects to it once', async () => {
    let endpoint: { url: string; token: string; mode: 'in-process' } | null = null
    const connect = vi.fn(async () => fakeClient())
    const client = createServerClient({
      endpoint: () => endpoint,
      settled: () => false,
      connect,
      waitMs: 2_000,
      sleep: async () => {
        endpoint = { url: 'http://127.0.0.1:1', token: 't', mode: 'in-process' }
      }
    })
    const [a, b] = await Promise.all([client.api(), client.api()])
    expect(a).toBe(b)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:1',
      token: 't',
      mode: 'in-process'
    })
  })
  it('fails at once when the boot decided there is no server', async () => {
    // A sleep that refuses to be called: a wait here is the defect, and it
    // must read as an assertion, not as a worker spinning 15 s on microtasks.
    const sleep = vi.fn(async () => {
      throw new Error('the client waited for a boot that had already decided')
    })
    const client = createServerClient({
      endpoint: () => null,
      settled: () => true,
      connect: async () => fakeClient(),
      waitMs: 15_000,
      sleep
    })
    await expect(client.api()).rejects.toThrow(NO_SERVER_MESSAGE)
    expect(sleep).not.toHaveBeenCalled()
  })
  it('gives up after the wait when the boot never decides', async () => {
    let now = 0
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const client = createServerClient({
        endpoint: () => null,
        settled: () => false,
        connect: async () => fakeClient(),
        waitMs: 1_000,
        sleep: async () => {
          now += 400
        }
      })
      await expect(client.api()).rejects.toThrow(NO_SERVER_MESSAGE)
    } finally {
      spy.mockRestore()
    }
  })
  it('rebuilds the client when the address changes and disposes the old one', async () => {
    let endpoint = { url: 'http://127.0.0.1:1', token: 't1', mode: 'in-process' }
    const first = fakeClient()
    const second = fakeClient()
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const client = createServerClient({ endpoint: () => endpoint, settled: () => true, connect })
    expect(await client.api()).toBe(first)
    endpoint = { url: 'http://127.0.0.1:2', token: 't2', mode: 'in-process' }
    expect(await client.api()).toBe(second)
    await Promise.resolve()
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
  })
  it('forgets a client that failed to build, so the next call tries again', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('no client'))
      .mockResolvedValueOnce(fakeClient())
    const client = createServerClient({
      endpoint: () => ({ url: 'http://127.0.0.1:1', token: 't', mode: 'in-process' }),
      settled: () => true,
      connect
    })
    await expect(client.api()).rejects.toThrow('no client')
    await expect(client.api()).resolves.toBeDefined()
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
