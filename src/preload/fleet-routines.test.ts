import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import { sessionKey } from '@clave/contract/fleet'
import type { RoutinesListing } from '@clave/contract/routines/model'
import { createFleetDesktop } from './fleet-desktop'
import type { FleetRoutines } from './fleet-types'
import type { ElectronAPI } from './index.d'

/**
 * A connected server's routines, from the Mac (PRDCT-4149): the bridge reads
 * a server's listing at connect and at each `routines.changed`, publishes it
 * to the window, publishes nothing when a read fails, and routes every act to
 * the server by id, the discussion with this window's key and answered as the
 * session's remote key.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const listingOf = (owner: string, n: number): RoutinesListing => ({
  routines: [],
  viewer: { url: null, note: `read ${n}` },
  server: { id: `${owner}-id`, name: owner }
})

interface Fixture {
  api: ElectronAPI
  calls: Array<{ owner: string; method: string; args: unknown[] }>
  heard: FleetRoutines[]
  failing: Set<string>
  emit: (owner: string, event: ServerEvent) => void
  invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  holds: Map<string, Promise<void>>
  /** Servers whose reads wait for the test: each read parks its resolver here, in call order. */
  deferred: Map<string, Array<(listing: RoutinesListing) => void>>
}
function fixture(): Fixture {
  const calls: Array<{ owner: string; method: string; args: unknown[] }> = []
  const events = new Map<string, (e: ServerEventEnvelope) => void>()
  const failing = new Set<string>()
  const reads = new Map<string, number>()
  const holds = new Map<string, Promise<void>>()
  const deferred = new Map<string, Array<(listing: RoutinesListing) => void>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['x', 'y'].map((id) => ({
        id,
        name: `Server ${id}`,
        enabled: true,
        url: `http://${id}`
      }))
    if (channel === 'window:identity') return { windowKey: 'win-7' }
    return { url: `http://${args[0]}`, token: 'test-only' }
  })
  const api = createFleetDesktop({} as unknown as ElectronAPI, {
    invoke,
    changed: () => () => {},
    connect: async (endpoint) => {
      const owner = new URL(endpoint.url).hostname
      const record =
        (method: string, result?: unknown) =>
        async (...args: unknown[]) => {
          calls.push({ owner, method, args })
          return result
        }
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
          requests: { watch: () => () => {} },
          routines: {
            list: async () => {
              calls.push({ owner, method: 'list', args: [] })
              const parked = deferred.get(owner)
              if (parked) return new Promise<RoutinesListing>((resolve) => parked.push(resolve))
              await holds.get(owner)
              if (failing.has(owner)) throw new Error('CapabilityUnavailable')
              const n = (reads.get(owner) ?? 0) + 1
              reads.set(owner, n)
              return listingOf(owner, n)
            },
            runNow: record('runNow', { id: 'run-1' }),
            dismiss: record('dismiss'),
            deck: record('deck', { html: '<html></html>' }),
            openDiscussion: record('openDiscussion', { sessionId: 'wire-9' })
          }
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
  const heard: FleetRoutines[] = []
  api.onFleetRoutines((update) => heard.push(update))
  const emit = (owner: string, event: ServerEvent): void =>
    events.get(owner)!({ id: 'test', seq: 1, at: 1, event })
  return { api, calls, heard, failing, emit, invoke, holds, deferred }
}

let h: Fixture
beforeEach(() => {
  vi.useFakeTimers()
  h = fixture()
})
afterEach(async () => {
  await h.api.fleetDisconnect('x')
  await h.api.fleetDisconnect('y')
  vi.useRealTimers()
})

describe('a connected server’s routines', () => {
  it('reads and publishes each server’s listing at connect', async () => {
    await h.api.fleetList()
    await flush()
    const byServer = Object.fromEntries(h.heard.map((u) => [u.serverId, u.listing.server?.name]))
    expect(byServer).toEqual({ x: 'x', y: 'y' })
  })

  it('reads again and publishes on a routines.changed event', async () => {
    await h.api.fleetList()
    await flush()
    h.heard.length = 0
    h.emit('x', { _tag: 'routines.changed' } as ServerEvent)
    await flush()
    expect(h.heard).toEqual([{ serverId: 'x', listing: listingOf('x', 2) }])
  })

  it('publishes nothing when a read fails', async () => {
    h.failing.add('y')
    await h.api.fleetList()
    await flush()
    expect(h.heard.map((u) => u.serverId)).toEqual(['x'])
    h.heard.length = 0
    h.emit('y', { _tag: 'routines.changed' } as ServerEvent)
    await flush()
    expect(h.heard).toEqual([])
    await expect(h.api.fleetRoutines('y')).rejects.toThrow(/CapabilityUnavailable/)
    expect(h.heard).toEqual([])
  })

  it('answers a read now and publishes it too', async () => {
    await h.api.fleetList()
    await flush()
    h.heard.length = 0
    const listing = await h.api.fleetRoutines('x')
    expect(listing.server?.name).toBe('x')
    expect(h.heard).toEqual([{ serverId: 'x', listing }])
  })

  it('publishes nothing for a server removed while its read was on the wire', async () => {
    await h.api.fleetList()
    await flush()
    h.heard.length = 0
    let release = (): void => {}
    h.holds.set('x', new Promise<void>((r) => (release = r)))
    const read = h.api.fleetRoutines('x')
    await flush()
    h.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'server:fleet:list')
        return [{ id: 'y', name: 'Server y', enabled: true, url: 'http://y' }]
      return { url: `http://${args[0]}`, token: 'test-only' }
    })
    await h.api.fleetList()
    release()
    await read
    expect(h.heard.filter((u) => u.serverId === 'x')).toEqual([])
  })

  it('two reads crossing on the wire: the newest read wins, the older answer is dropped (Gap 2)', async () => {
    const parked: Array<(listing: RoutinesListing) => void> = []
    h.deferred.set('x', parked)
    const named = (name: string): RoutinesListing => ({
      routines: [],
      viewer: { url: null, note: '' },
      server: { id: 'x-id', name }
    })
    // Read A: the one the connect issues.
    await h.api.fleetList()
    await flush()
    expect(parked).toHaveLength(1)
    // Read B: the one a routines.changed issues while A is still on the wire.
    h.emit('x', { _tag: 'routines.changed' } as ServerEvent)
    await flush()
    expect(parked).toHaveLength(2)
    const [answerA, answerB] = parked
    // B answers first, then A, issued earlier, answers last with stale data.
    answerB(named('read-b'))
    await flush()
    answerA(named('read-a'))
    await flush()
    const forX = h.heard.filter((u) => u.serverId === 'x').map((u) => u.listing.server?.name)
    expect(forX).toEqual(['read-b'])
  })

  it('routes run now, dismiss and the deck to the server named', async () => {
    await h.api.fleetList()
    await flush()
    h.calls.length = 0
    await expect(h.api.fleetRoutineRunNow('y', 'k')).resolves.toEqual({ id: 'run-1' })
    await h.api.fleetRoutineDismiss('x', 'run-2')
    await expect(h.api.fleetRoutineDeck('y', 'run-3')).resolves.toEqual({ html: '<html></html>' })
    expect(h.calls).toEqual([
      { owner: 'y', method: 'runNow', args: ['k'] },
      { owner: 'x', method: 'dismiss', args: ['run-2'] },
      { owner: 'y', method: 'deck', args: ['run-3'] }
    ])
  })

  it('opens a discussion with this window’s key and answers the remote key', async () => {
    await h.api.fleetList()
    await flush()
    h.calls.length = 0
    const opened = await h.api.fleetRoutineDiscussion('x', 'run-4', 'panel')
    expect(h.calls).toEqual([
      { owner: 'x', method: 'openDiscussion', args: ['run-4', 'win-7', 'panel'] }
    ])
    expect(opened).toEqual({ sessionId: sessionKey({ serverId: 'x', sessionId: 'wire-9' }) })
  })
})
