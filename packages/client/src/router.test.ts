import { describe, expect, it, vi } from 'vitest'
import { type Backing, createMethodRouter } from './router'

const backing = (): Backing => ({ api: { name: 'api' } as never, push: { name: 'push' } as never })

describe('the method router', () => {
  it('sends a method without a server arm over IPC and never asks for an endpoint', async () => {
    const resolve = vi.fn(async () => ({ url: 'http://127.0.0.1:1', token: 't' }))
    const router = createMethodRouter({ resolve, connect: backing })
    const list = router.route({ ipc: async (a: number) => a + 1 })
    expect(await list(1)).toBe(2)
    expect(resolve).not.toHaveBeenCalled()
  })
  it('sends a routed method over IPC while there is no endpoint', async () => {
    const router = createMethodRouter({ resolve: async () => null, connect: backing })
    const server = vi.fn(async () => 'server')
    const list = router.route({ ipc: async () => 'ipc', server })
    expect(await list()).toBe('ipc')
    expect(server).not.toHaveBeenCalled()
  })
  it('sends a routed method to the server once an endpoint exists, with one backing for all', async () => {
    const connect = vi.fn(backing)
    const resolve = vi.fn(async () => ({ url: 'http://127.0.0.1:1', token: 't' }))
    const router = createMethodRouter({ resolve, connect })
    const one = router.route({
      ipc: async (x: string) => `ipc:${x}`,
      server: async (_b, x: string) => `server:${x}`
    })
    const two = router.route({ ipc: async () => 'ipc', server: async () => 'server' })
    expect(await Promise.all([one('a'), two(), one('b')])).toEqual([
      'server:a',
      'server',
      'server:b'
    ])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })
  it('lets a server failure reach the caller instead of falling back to IPC', async () => {
    const router = createMethodRouter({
      resolve: async () => ({ url: 'http://127.0.0.1:1', token: 't' }),
      connect: backing
    })
    const ipc = vi.fn(async () => 'ipc')
    const list = router.route({
      ipc,
      server: async () => {
        throw new Error('server down')
      }
    })
    await expect(list()).rejects.toThrow('server down')
    expect(ipc).not.toHaveBeenCalled()
  })
  it('asks again on the next call while there is no endpoint, and keeps the backing once there is', async () => {
    let calls = 0
    const connect = vi.fn(backing)
    const router = createMethodRouter({
      resolve: async () => {
        calls += 1
        if (calls === 1) throw new Error('no main yet')
        if (calls === 2) return null
        return { url: 'http://127.0.0.1:1', token: 't' }
      },
      connect
    })
    const list = router.route({ ipc: async () => 'ipc', server: async () => 'server' })
    expect(await list()).toBe('ipc')
    expect(await list()).toBe('ipc')
    expect(await list()).toBe('server')
    expect(await list()).toBe('server')
    expect(calls).toBe(3)
    expect(connect).toHaveBeenCalledTimes(1)
  })
  it('a connect that fails fails that call, is forgotten, and the next call connects', async () => {
    let connects = 0
    const router = createMethodRouter({
      resolve: async () => ({ url: 'http://127.0.0.1:1', token: 't' }),
      connect: () => {
        connects += 1
        if (connects === 1) throw new Error('import failed')
        return backing()
      }
    })
    const list = router.route({ ipc: async () => 'ipc', server: async () => 'server' })
    await expect(list()).rejects.toThrow('import failed')
    expect(await list()).toBe('server')
    expect(connects).toBe(2)
  })
  it('asks once for concurrent calls, and again after a reset', async () => {
    let calls = 0
    const router = createMethodRouter({
      resolve: async () => {
        calls += 1
        return { url: 'http://127.0.0.1:1', token: 't' }
      },
      connect: backing
    })
    const list = router.route({ ipc: async () => 'ipc', server: async () => 'server' })
    expect(await Promise.all([list(), list(), list()])).toEqual(['server', 'server', 'server'])
    expect(calls).toBe(1)
    router.reset()
    expect(await list()).toBe('server')
    expect(calls).toBe(2)
  })
})
