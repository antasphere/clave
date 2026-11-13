/**
 * The limit report on the fleet road (PRDCT-4329): a connected server's
 * `session.limit_reported` reaches the window keyed by that server, beside
 * the local bridge's own deliveries, so a server tab's chat draws its limit
 * card instead of the "server ended" pane. Until this relay only this Mac's
 * transports heard the report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import { sessionKey } from '@clave/contract/fleet'
import { createFleetDesktop } from './fleet-desktop'
import type { ElectronAPI } from './index.d'
import type { LimitReport } from '../shared/limit-report'

type Heard = { id: string; report: LimitReport }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function fixture(): {
  api: ElectronAPI
  emit: (owner: string, event: ServerEvent) => void
  local: {
    deliver: (payload: Heard) => void
    clear: (payload: { id: string }) => void
    released: number
  }
} {
  const events = new Map<string, (e: ServerEventEnvelope) => void>()
  const localListeners: Array<(payload: Heard) => void> = []
  const clearedListeners: Array<(payload: { id: string }) => void> = []
  const local = {
    released: 0,
    deliver: (payload: Heard): void => {
      for (const cb of localListeners) cb(payload)
    },
    clear: (payload: { id: string }): void => {
      for (const cb of clearedListeners) cb(payload)
    }
  }
  const localApi = {
    onSessionLimitReported: (cb: (payload: Heard) => void) => {
      localListeners.push(cb)
      return () => {
        localListeners.splice(localListeners.indexOf(cb), 1)
        local.released++
      }
    },
    onSessionLimitCleared: (cb: (payload: { id: string }) => void) => {
      clearedListeners.push(cb)
      return () => {
        clearedListeners.splice(clearedListeners.indexOf(cb), 1)
        local.released++
      }
    }
  } as unknown as ElectronAPI
  const api = createFleetDesktop(localApi, {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'server:fleet:list')
        return [{ id: 'x', name: 'Server x', enabled: true, url: 'http://x' }]
      if (channel === 'window:identity') return { windowKey: 'win-7' }
      return { url: `http://${args[0]}`, token: 'test-only' }
    }),
    changed: () => () => {},
    connect: async (endpoint) => {
      const owner = new URL(endpoint.url).hostname
      return {
        api: {
          dispose: async () => {},
          sessions: { list: async () => [], listAdoptable: async () => [] },
          sidebar: {
            getLayout: async () => ({
              windowKey: 'server',
              revision: 0,
              groups: [],
              displayOrder: []
            })
          },
          requests: { watch: () => () => {} }
        },
        push: {
          status: 'open',
          connect: () => {},
          close: () => {},
          onRequest: () => () => {},
          whenOpen: () => Promise.resolve(),
          onStatus: () => () => {},
          onEvent: (cb: (e: ServerEventEnvelope) => void) => {
            events.set(owner, cb)
            return () => {}
          }
        }
      } as unknown as Backing
    }
  })
  const emit = (owner: string, event: ServerEvent): void =>
    events.get(owner)!({ id: 'test', seq: 1, at: 1, event })
  return { api, emit, local }
}

let h: ReturnType<typeof fixture>
afterEach(async () => {
  await h.api.fleetDisconnect('x')
})

describe('a session’s limit report on the fleet road', () => {
  it('a connected server’s report arrives keyed by that server with its scope and reset; the local bridge’s as it came', async () => {
    h = fixture()
    const heard: Heard[] = []
    const off = h.api.onSessionLimitReported((payload) => heard.push(payload))
    await h.api.fleetList()
    await flush()
    h.emit('x', {
      _tag: 'session.limit_reported',
      id: 's1',
      scope: { family: 'Fable' },
      resetsAt: 1_900_000_000_000
    })
    h.emit('x', { _tag: 'session.limit_reported', id: 's2', scope: 'shared' })
    h.local.deliver({ id: 'local-1', report: { scope: 'credits' } })
    expect(heard).toEqual([
      {
        id: sessionKey({ serverId: 'x', sessionId: 's1' }),
        report: { scope: { family: 'Fable' }, resetsAt: 1_900_000_000_000 }
      },
      // No reset on the wire: no `resetsAt` key in the report.
      { id: sessionKey({ serverId: 'x', sessionId: 's2' }), report: { scope: 'shared' } },
      { id: 'local-1', report: { scope: 'credits' } }
    ])
    // Another event of the same server is no limit.
    h.emit('x', { _tag: 'session.state_changed', id: 's1', state: 'working' })
    expect(heard).toHaveLength(3)
    off()
    expect(h.local.released).toBe(1)
    h.emit('x', { _tag: 'session.limit_reported', id: 's1', scope: 'shared' })
    expect(heard).toHaveLength(3)
  })
})

describe('a session’s limit report closing on the fleet road (PRDCT-4415)', () => {
  it('a connected server’s cleared word arrives keyed by that server; the local bridge’s as it came', async () => {
    h = fixture()
    const heard: { id: string }[] = []
    const off = h.api.onSessionLimitCleared((payload) => heard.push(payload))
    await h.api.fleetList()
    await flush()
    h.emit('x', { _tag: 'session.limit_cleared', id: 's1' })
    h.local.clear({ id: 'local-1' })
    // A report of the same server is no clearing.
    h.emit('x', { _tag: 'session.limit_reported', id: 's1', scope: 'shared' })
    expect(heard).toEqual([
      { id: sessionKey({ serverId: 'x', sessionId: 's1' }) },
      { id: 'local-1' }
    ])
    off()
    expect(h.local.released).toBe(1)
    h.emit('x', { _tag: 'session.limit_cleared', id: 's1' })
    expect(heard).toHaveLength(2)
  })
})
