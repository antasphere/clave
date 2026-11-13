/**
 * A terminal verb on a server tab whose server does not answer (PRDCT-4198):
 * the bridge declares `startSession`, `resizeSession` and `writeSession` as
 * fire-and-forget, so the window never catches their promise, and a server
 * that is stopping (its daemon on a self-upgrade) surfaced as one uncaught
 * "did not answer" rejection in the renderer. The road says it once in the
 * console and never throws; the per-session order of the verbs is kept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import { FLEET_IPC, resourceKey } from '@clave/contract/fleet'
import type { ElectronAPI } from './index.d'
import { createFleetDesktop } from './fleet-desktop'

function world(resize: (id: string, cols: number, rows: number) => Promise<void>): ElectronAPI {
  const b = {
    api: {
      dispose: async () => {},
      sessions: { list: async () => [], listAdoptable: async () => [], resize },
      sidebar: {
        getLayout: async () => ({ windowKey: 'server', revision: 0, groups: [], displayOrder: [] })
      },
      requests: { watch: () => () => {} }
    },
    push: {
      status: 'connecting',
      connect: () => undefined,
      close: () => undefined,
      whenOpen: async () => {},
      onStatus: () => () => {},
      onEvent: () => () => {},
      onRequest: () => () => {}
    }
  } as unknown as Backing
  return createFleetDesktop({} as ElectronAPI, {
    invoke: async (channel) => {
      if (channel === FLEET_IPC.list)
        return [{ id: 'a', name: 'A', url: 'http://a', enabled: true }]
      return { url: 'http://a', token: 'test-only' }
    },
    connect: async () => b,
    changed: () => () => {}
  })
}

afterEach(() => vi.restoreAllMocks())

describe('a terminal verb on a server that does not answer', () => {
  const key = resourceKey('session', 'a', 't1')
  it('resolves, warns once, and never rejects to the window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = world(async () => {
      throw new Error("Clave's server at http://a did not answer")
    })
    await api.fleetList()
    await expect(api.resizeSession(key, 100, 30)).resolves.toBeUndefined()
    await expect(api.startSession(key, 120, 40)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain('did not reach the server')
    expect(String(warn.mock.calls[0][0])).toContain('did not answer')
  })
  it('keeps the verbs in order per session when the server answers', async () => {
    const seen: string[] = []
    const api = world(async (_id, cols) => {
      // The first call answers last: the chain, not the clock, keeps the order.
      await new Promise((resolve) => setTimeout(resolve, cols === 1 ? 20 : 1))
      seen.push(String(cols))
    })
    await api.fleetList()
    await Promise.all([api.resizeSession(key, 1, 1), api.resizeSession(key, 2, 2)])
    expect(seen).toEqual(['1', '2'])
  })
})
