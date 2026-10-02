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
  it('treats a failed endpoint lookup as no endpoint, and asks again after a reset', async () => {
    let calls = 0
    const router = createMethodRouter({
      resolve: async () => {
        calls += 1
        if (calls === 1) throw new Error('no main yet')
        return { url: 'http://127.0.0.1:1', token: 't' }
      },
      connect: backing
    })
    const list = router.route({ ipc: async () => 'ipc', server: async () => 'server' })
    expect(await list()).toBe('ipc')
    expect(await list()).toBe('ipc')
    router.reset()
    expect(await list()).toBe('server')
    expect(calls).toBe(2)
  })
})
