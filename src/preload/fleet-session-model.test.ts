/**
 * The model push on the fleet road (PRDCT-4256, round 1 gap): a connected
 * server's `session.model_changed` reaches the window keyed by that server,
 * beside the local bridge's own deliveries, so a served tab's sidebar row
 * judges the caps by the model its chat runs on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import { sessionKey } from '@clave/contract/fleet'
import { createFleetDesktop } from './fleet-desktop'
import type { ElectronAPI } from './index.d'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function fixture(): {
  api: ElectronAPI
  emit: (owner: string, event: ServerEvent) => void
  local: { deliver: (payload: { id: string; model: string }) => void; released: number }
} {
  const events = new Map<string, (e: ServerEventEnvelope) => void>()
  const localListeners: Array<(payload: { id: string; model: string }) => void> = []
  const local = {
    released: 0,
    deliver: (payload: { id: string; model: string }): void => {
      for (const cb of localListeners) cb(payload)
    }
  }
  const localApi = {
    onSessionModelChanged: (cb: (payload: { id: string; model: string }) => void) => {
      localListeners.push(cb)
      return () => {
        localListeners.splice(localListeners.indexOf(cb), 1)
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

describe('a session’s model on the fleet road', () => {
  it('a connected server’s model change arrives keyed by that server; the local bridge’s as it came', async () => {
    h = fixture()
    const heard: Array<{ id: string; model: string }> = []
    const off = h.api.onSessionModelChanged((payload) => heard.push(payload))
    await h.api.fleetList()
    await flush()
    h.emit('x', { _tag: 'session.model_changed', id: 's1', model: 'claude-fable-5-1[1m]' })
    h.local.deliver({ id: 'local-1', model: 'claude-opus-5-5' })
    expect(heard).toEqual([
      { id: sessionKey({ serverId: 'x', sessionId: 's1' }), model: 'claude-fable-5-1[1m]' },
      { id: 'local-1', model: 'claude-opus-5-5' }
    ])
    // Another server's event is nobody's here; a state change is not a model.
    h.emit('x', { _tag: 'session.state_changed', id: 's1', state: 'working' })
    expect(heard).toHaveLength(2)
    off()
    expect(h.local.released).toBe(1)
    h.emit('x', { _tag: 'session.model_changed', id: 's1', model: 'claude-haiku-5-5' })
    expect(heard).toHaveLength(2)
  })
})
