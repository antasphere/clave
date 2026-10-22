import { describe, expect, it } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEventEnvelope } from '@clave/contract/events'
import type { ElectronAPI } from './index.d'
import type { FleetSnapshot } from './fleet-types'
import type { Session } from '../shared/session-model'
import { createFleetDesktop } from './fleet-desktop'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function discovery(): {
  api: ElectronAPI
  release: () => void
  snapshots: FleetSnapshot[]
  reads: () => number
  insert: () => void
} {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let notify!: (event: ServerEventEnvelope) => void
  let enabled = true
  let reads = 0
  let rows: Session[] = []
  const snapshots: FleetSnapshot[] = []
  const b = {
    api: {
      dispose: async () => {},
      sessions: {
        list: async () => {
          const result = [...rows]
          if (++reads === 1) await held
          return result
        },
        listAdoptable: async () => []
      },
      sidebar: {
        getLayout: async () => ({ windowKey: 'server', revision: 0, groups: [], displayOrder: [] })
      },
      requests: { watch: () => () => {} }
    },
    push: {
      status: 'open',
      connect: () => undefined,
      close: () => undefined,
      whenOpen: async () => {},
      onStatus: () => () => {},
      onEvent: (callback: typeof notify) => {
        notify = callback
        return () => {}
      },
      onRequest: () => () => {}
    }
  } as unknown as Backing
  const api = createFleetDesktop({} as ElectronAPI, {
    invoke: async (channel) => {
      if (channel === 'server:fleet:list')
        return [{ id: 'a', name: 'A', url: 'http://owner-a', enabled }]
      if (channel === 'server:fleet:disconnect') {
        enabled = false
        return
      }
      return { url: 'http://owner-a', token: 'test-only' }
    },
    connect: async () => b,
    changed: () => () => {}
  })
  api.onFleetSnapshot((snapshot) => snapshots.push(snapshot))
  return {
    api,
    release,
    snapshots,
    reads: () => reads,
    insert: () => {
      rows = [
        {
          id: 'new',
          provider: 'terminal',
          transport: 'pty',
          cwd: '/',
          windowKey: 'server',
          state: 'idle',
          createdAt: 1,
          adapterId: 'pty',
          title: 'New'
        }
      ]
      notify({
        id: 'event-1',
        at: 1,
        event: { _tag: 'session.state_changed', id: 'new', state: 'idle' },
        seq: 1
      })
    }
  }
}
describe('fleet discovery under concurrent server events', () => {
  it('reads again when an owning session event arrives after a pending read captured its list', async () => {
    const h = discovery()
    try {
      await h.api.fleetList()
      await flush()
      expect(h.reads()).toBe(1)
      h.insert()
      h.release()
      await flush()
      expect(h.snapshots.at(-1)?.sessions.map((s) => s.title)).toContain('New')
      expect(h.reads()).toBe(2)
    } finally {
      h.release()
      await h.api.fleetDisconnect('a')
    }
  })
  it('does not let a queued discovery revive an intentionally disconnected owner', async () => {
    const h = discovery()
    await h.api.fleetList()
    await flush()
    h.insert()
    await h.api.fleetDisconnect('a')
    h.release()
    await flush()
    expect(h.snapshots).toEqual([])
    expect(h.reads()).toBe(1)
  })
})
