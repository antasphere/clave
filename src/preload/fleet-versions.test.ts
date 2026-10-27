/**
 * A server's upgrade reaches the Servers page live (issue #266, V1-F5): the
 * window's own connection to each server hears `server.upgrade_changed` and
 * each (re)welcome, which is how an upgraded server comes back, and asks main
 * to read that server's version again. Main decides; the window only routes.
 */
import { describe, expect, it } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEventEnvelope } from '@clave/contract/events'
import { FLEET_IPC } from '@clave/contract/fleet'
import type { ElectronAPI } from './index.d'
import { createFleetDesktop } from './fleet-desktop'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function world(): {
  api: ElectronAPI
  asked: unknown[][]
  event: (event: ServerEventEnvelope['event']) => void
  status: (state: string) => void
} {
  const asked: unknown[][] = []
  let notify!: (event: ServerEventEnvelope) => void
  let onStatus!: (state: string, detail: Record<string, unknown>) => void
  let seq = 0
  const b = {
    api: {
      dispose: async () => {},
      sessions: { list: async () => [], listAdoptable: async () => [] },
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
      onStatus: (callback: typeof onStatus) => {
        onStatus = callback
        return () => {}
      },
      onEvent: (callback: typeof notify) => {
        notify = callback
        return () => {}
      },
      onRequest: () => () => {}
    }
  } as unknown as Backing
  const api = createFleetDesktop({} as ElectronAPI, {
    invoke: async (channel, ...args) => {
      asked.push([channel, ...args])
      if (channel === FLEET_IPC.list)
        return [{ id: 'a', name: 'A', url: 'http://a', enabled: true }]
      return { url: 'http://a', token: 'test-only' }
    },
    connect: async () => b,
    changed: () => () => {}
  })
  return {
    api,
    asked,
    event: (event) => notify({ id: `e${++seq}`, seq, at: 1, event }),
    status: (state) => onStatus(state, {})
  }
}
const refreshes = (asked: unknown[][]): unknown[][] =>
  asked.filter(([channel]) => channel === FLEET_IPC.versionRefresh)

describe("a server's upgrade, routed to main", () => {
  it('asks main to read the server again when its upgrade changes', async () => {
    const w = world()
    await w.api.fleetList()
    await flush()
    const before = refreshes(w.asked).length
    w.event({
      _tag: 'server.upgrade_changed',
      status: { supported: true, state: 'failed', target: '3.0.0', error: 'x' }
    })
    await flush()
    expect(refreshes(w.asked).slice(before)).toEqual([[FLEET_IPC.versionRefresh, 'a']])
  })

  it('asks again at each welcome, which is how an upgraded server comes back', async () => {
    const w = world()
    await w.api.fleetList()
    await flush()
    const before = refreshes(w.asked).length
    w.status('open')
    await flush()
    expect(refreshes(w.asked).slice(before)).toEqual([[FLEET_IPC.versionRefresh, 'a']])
  })

  it('does not ask for an event of another kind', async () => {
    const w = world()
    await w.api.fleetList()
    await flush()
    const before = refreshes(w.asked).length
    w.event({ _tag: 'plugins.changed' })
    await flush()
    expect(refreshes(w.asked).length).toBe(before)
  })
})
