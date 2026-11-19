import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ElectronAPI } from './index.d'
import type { FleetSnapshot } from './fleet-types'
import type { Session } from '../shared/session-model'
import { createFleetDesktop } from './fleet-desktop'

// Issue #423: a server's sessions started from the phone did not show on the
// desktop, and a session the server said was done still showed working. The
// server's own answers were whole all along; the desktop's copy of them was
// frozen. A snapshot is three reads at once, and one that fails (a read that
// times out, a socket replaced under it) used to be dropped without a word:
// nothing read the server again until its next event, and a server whose
// sessions had all gone quiet sends none. These pin that a failed read is
// read again by itself, and that it stops once the server is let go.

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const codex: Session = {
  id: 'codex-1',
  provider: 'codex',
  transport: 'events',
  cwd: '/home/ubuntu',
  windowKey: 'server',
  workspaceId: 'ws-ubuntu',
  state: 'done',
  createdAt: 1,
  adapterId: 'codex-chat',
  title: 'ubuntu'
}

function server(failures: number): {
  api: ElectronAPI
  snapshots: FleetSnapshot[]
  reads: () => number
} {
  let reads = 0
  let enabled = true
  const snapshots: FleetSnapshot[] = []
  const b = {
    api: {
      dispose: async () => {},
      sessions: {
        list: async () => [codex],
        listAdoptable: async () => {
          reads++
          if (reads <= failures) throw new Error('Server request timed out.')
          return []
        }
      },
      sidebar: {
        getLayout: async () => ({
          windowKey: 'server',
          revision: 1,
          groups: [],
          displayOrder: ['codex-1']
        })
      },
      requests: { watch: () => () => {} }
    },
    push: {
      status: 'open',
      connect: () => undefined,
      close: () => undefined,
      whenOpen: async () => {},
      onStatus: () => () => {},
      onEvent: () => () => {},
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
  return { api, snapshots, reads: () => reads }
}

describe('a server snapshot that fails is read again (#423)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the server again after a failed read, with no event to prompt it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = server(1)
    try {
      await h.api.fleetList()
      await flush()
      expect(h.reads()).toBe(1)
      expect(h.snapshots).toEqual([])
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(h.reads()).toBeGreaterThanOrEqual(2)
      const last = h.snapshots.at(-1)
      expect(last?.sessions.map((s) => s.id)).toEqual(['clave-owner:session:a:codex-1'])
      expect(last?.sessions[0]?.state).toBe('done')
    } finally {
      await h.api.fleetDisconnect('a')
    }
  })

  it('keeps trying while the reads keep failing, and stops once one lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = server(3)
    try {
      await h.api.fleetList()
      await flush()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await flush()
      expect(h.reads()).toBe(4)
      expect(h.snapshots).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await flush()
      expect(h.reads()).toBe(4)
    } finally {
      await h.api.fleetDisconnect('a')
    }
  })

  it('does not read a server again once it is disconnected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = server(100)
    await h.api.fleetList()
    await flush()
    expect(h.reads()).toBe(1)
    await h.api.fleetDisconnect('a')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await flush()
    expect(h.reads()).toBe(1)
    expect(h.snapshots).toEqual([])
  })
})
