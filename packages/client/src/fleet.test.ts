import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFleetClient, type FleetClient } from './fleet'
import type { Backing } from './router'
import type { PushStatus, PushStatusDetail } from './push-client'

function fakeBacking(): Backing & {
  test: {
    status: (status: PushStatus, detail?: PushStatusDetail) => void
    event: (value: unknown) => void
    request: (value: unknown) => void
    stream: (sessionId: string, value: unknown) => void
  }
} {
  const statuses = new Set<(status: PushStatus, detail: PushStatusDetail) => void>()
  const events = new Set<(value: unknown) => void>()
  const requests = new Set<(value: unknown) => void>()
  const streams = new Map<string, (value: unknown) => void>()
  const push = {
    status: 'idle',
    connect: vi.fn(),
    close: vi.fn(),
    onStatus: (fn: typeof statuses extends Set<infer T> ? T : never) => {
      statuses.add(fn)
      return () => statuses.delete(fn)
    },
    onEvent: (fn: (value: unknown) => void) => {
      events.add(fn)
      return () => events.delete(fn)
    },
    onRequest: (fn: (value: unknown) => void) => {
      requests.add(fn)
      return () => requests.delete(fn)
    },
    subscribe: vi.fn((id: string, fn: (value: unknown) => void) => {
      streams.set(id, fn)
      return () => streams.delete(id)
    })
  }
  return {
    api: {
      dispose: vi.fn(async () => {}),
      sessions: { list: vi.fn(async () => ['owned']) }
    } as unknown as Backing['api'],
    push: push as unknown as Backing['push'],
    test: {
      status: (status, detail = {}) => {
        push.status = status
        statuses.forEach((fn) => fn(status, detail))
      },
      event: (value) => events.forEach((fn) => fn(value)),
      request: (value) => requests.forEach((fn) => fn(value)),
      stream: (id, value) => streams.get(id)?.(value)
    }
  }
}

const clients: FleetClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  vi.useRealTimers()
})
const make = (options: Parameters<typeof createFleetClient>[0]): FleetClient => {
  const client = createFleetClient(options)
  clients.push(client)
  return client
}

describe('independent fleet backings', () => {
  it('recognizes an already welcomed backing instead of timing it out', async () => {
    vi.useFakeTimers()
    const a = fakeBacking()
    a.test.status('open')
    const client = make({
      resolve: async () => ({ url: 'http://a', token: 't' }),
      connect: () => a,
      timeoutMs: 50
    })
    await client.connect('a')
    expect(client.list()[0].state).toBe('connected')
    await vi.advanceTimersByTimeAsync(51)
    expect(client.list()[0].state).toBe('connected')
  })
  it('routes by exact owner, tags events/requests/streams and keeps bare IDs on wire', async () => {
    const a = fakeBacking(),
      b = fakeBacking()
    const factory = vi.fn((_endpoint, id) => (id === 'a' ? a : b))
    const client = make({
      resolve: async (id) => ({ url: `http://${id}`, token: 'secret' }),
      connect: factory
    })
    const events: unknown[] = [],
      requests: unknown[] = [],
      streams: unknown[] = []
    client.onEvent((value) => events.push(value))
    client.onRequest((value) => requests.push(value))
    expect(await client.connect('a')).toBe(a)
    expect(await client.connect('b')).toBe(b)
    expect(await client.backing('a')).toBe(a)
    expect(await client.connect('a')).toBe(a)
    expect(factory).toHaveBeenCalledTimes(2)
    await client.subscribe({ serverId: 'a', sessionId: 'same' }, (value) => streams.push(value))
    await client.subscribe({ serverId: 'b', sessionId: 'same' }, (value) => streams.push(value))
    a.test.stream('same', 'a bytes')
    b.test.stream('same', 'b bytes')
    a.test.event({ id: 'same' })
    b.test.event({ id: 'same' })
    b.test.request({ requestId: 'same' })
    expect(streams).toEqual([
      { serverId: 'a', value: 'a bytes' },
      { serverId: 'b', value: 'b bytes' }
    ])
    expect(events).toEqual([
      { serverId: 'a', value: { id: 'same' } },
      { serverId: 'b', value: { id: 'same' } }
    ])
    expect(requests).toEqual([{ serverId: 'b', value: { requestId: 'same' } }])
    expect(a.push.subscribe).toHaveBeenCalledWith('same', expect.any(Function), undefined)
    await expect(client.backing('missing')).rejects.toThrow()
  })
  it('isolates acquisition failures and never includes arbitrary error/secret text in status', async () => {
    const b = fakeBacking()
    const client = make({
      resolve: async (id) => {
        if (id === 'a') throw new Error('private-token')
        return { url: 'http://b', token: 't' }
      },
      connect: () => b
    })
    const results = await Promise.allSettled([client.connect('a'), client.connect('b')])
    expect(results.map((value) => value.status)).toEqual(['rejected', 'fulfilled'])
    expect(await client.backing('b')).toBe(b)
    expect(JSON.stringify(client.list())).not.toContain('private-token')
    expect(client.list().find((s) => s.serverId === 'a')?.state).toBe('offline')
  })
  it('bounds acquisition and disposes a late factory result after disconnect', async () => {
    vi.useFakeTimers()
    const a = fakeBacking()
    let finish!: (value: Backing) => void
    const factory = vi.fn(
      () =>
        new Promise<Backing>((resolve) => {
          finish = resolve
        })
    )
    const client = make({
      resolve: async () => ({ url: 'http://a', token: 't' }),
      connect: factory,
      timeoutMs: 50
    })
    const pending = client.connect('a')
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(51)
    await rejected
    expect(client.list()[0].state).toBe('offline')
    await client.disconnect('a')
    finish(a)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.push.close).toHaveBeenCalledOnce()
    expect(a.api.dispose).toHaveBeenCalledOnce()
    expect(client.list()[0].state).toBe('disconnected')
    expect(a.push.connect).not.toHaveBeenCalled()
  })
  it('cancels acquisition promptly and prevents late resolution from opening a socket', async () => {
    let finish!: (value: { url: string; token: string }) => void
    const factory = vi.fn(() => fakeBacking())
    const client = make({
      resolve: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      connect: factory
    })
    const pending = client.connect('a')
    const rejected = expect(pending).rejects.toThrow()
    await Promise.resolve()
    await client.disconnect('a')
    await rejected
    finish({ url: 'http://a', token: 't' })
    await Promise.resolve()
    await Promise.resolve()
    expect(factory).not.toHaveBeenCalled()
  })
  it('maps welcome/retry/refusal independently and does not retry rejected credentials', async () => {
    const a = fakeBacking(),
      b = fakeBacking()
    const client = make({
      resolve: async () => ({ url: 'http://a', token: 't' }),
      connect: (_endpoint, id) => (id === 'a' ? a : b)
    })
    await Promise.all([client.connect('a'), client.connect('b')])
    b.test.status('open')
    a.test.status('reconnecting', { attempt: 3, reason: 'secret-echo' })
    expect(client.list()).toEqual(
      expect.arrayContaining([
        { serverId: 'a', state: 'reconnecting', attempt: 3, error: 'unreachable' },
        { serverId: 'b', state: 'connected' }
      ])
    )
    a.test.status('closed', { final: 'unauthorized', reason: 'secret-echo' })
    expect(client.list().find((s) => s.serverId === 'a')).toEqual({
      serverId: 'a',
      state: 'unauthorized',
      error: 'unauthorized'
    })
    await expect(client.backing('a')).rejects.toThrow()
    expect(JSON.stringify(client.list())).not.toContain('secret-echo')
    expect(await client.backing('b')).toBe(b)
  })
  it('marks a silent handshake offline while allowing a later welcome', async () => {
    vi.useFakeTimers()
    const a = fakeBacking()
    const client = make({
      resolve: async () => ({ url: 'http://a', token: 't' }),
      connect: () => a,
      timeoutMs: 50
    })
    await client.connect('a')
    await vi.advanceTimersByTimeAsync(51)
    expect(client.list()[0].state).toBe('offline')
    a.test.status('open')
    expect(client.list()[0].state).toBe('connected')
  })
  it('disconnects only transports, detaches callbacks, retains state until remove, and reconnects fresh', async () => {
    const a = fakeBacking(),
      replacement = fakeBacking()
    let count = 0
    const client = make({
      resolve: async () => ({ url: 'http://a', token: 't' }),
      connect: () => (++count === 1 ? a : replacement)
    })
    const events: unknown[] = []
    client.onEvent((value) => events.push(value))
    await client.connect('a')
    await client.disconnect('a')
    a.test.event({ id: 'late' })
    a.test.status('open')
    expect(events).toEqual([])
    expect(client.list()).toEqual([{ serverId: 'a', state: 'disconnected' }])
    expect(a.push.close).toHaveBeenCalledOnce()
    expect(a.api.dispose).toHaveBeenCalledOnce()
    expect(await client.connect('a')).toBe(replacement)
    await client.remove('a')
    expect(client.list()).toEqual([])
    await expect(client.backing('a')).rejects.toThrow()
    await client.close()
    await expect(client.connect('a')).rejects.toThrow()
  })
})
