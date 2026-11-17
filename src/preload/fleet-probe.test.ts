/**
 * A window asks every server's socket whether its server is still there at
 * the moments a socket most often dies without a word: the network coming
 * back, the window focused again, the page visible again (PRDCT-4668). A
 * hidden page asks nothing. Without a DOM the module installs no hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import { FLEET_IPC } from '@clave/contract/fleet'
import type { ElectronAPI } from './index.d'
import { createFleetDesktop } from './fleet-desktop'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function world(): { probe: ReturnType<typeof vi.fn>; api: ElectronAPI } {
  const probe = vi.fn()
  const b = {
    api: {
      dispose: async () => {},
      sessions: { list: async () => [], listAdoptable: async () => [] },
      sidebar: {
        getLayout: async () => ({ windowKey: 'server', revision: 0, groups: [], displayOrder: [] })
      },
      requests: { watch: () => () => {} },
      routines: { list: async () => ({ routines: [] }) }
    },
    push: {
      status: 'open',
      connect: () => undefined,
      close: () => undefined,
      probe,
      whenOpen: async () => {},
      onStatus: () => () => {},
      onEvent: () => () => {},
      onRequest: () => () => {}
    }
  } as unknown as Backing
  const api = createFleetDesktop({} as ElectronAPI, {
    invoke: async (channel) => {
      if (channel === FLEET_IPC.list)
        return [{ id: 'a', name: 'A', url: 'http://a', enabled: true }]
      return { url: 'http://a', token: 'test-only' }
    },
    connect: async () => b,
    changed: () => () => {}
  })
  return { probe, api }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the window probes its servers when it is likely a socket died', () => {
  it('on online, focus, and the page becoming visible', async () => {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const { probe, api } = world()
    await api.fleetList()
    await flush()
    win.dispatchEvent(new Event('online'))
    expect(probe).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('focus'))
    expect(probe).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(probe).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('installs nothing without a DOM', async () => {
    expect(typeof window).toBe('undefined')
    const { probe, api } = world()
    await api.fleetList()
    await flush()
    expect(probe).not.toHaveBeenCalled()
  })
})
