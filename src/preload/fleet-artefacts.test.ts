import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import { sessionKey } from '@clave/contract/fleet'
import type { Artefact, ArtefactPreview } from '@clave/contract/artefacts/model'
import { createFleetDesktop } from './fleet-desktop'
import type { ElectronAPI } from './index.d'

/**
 * A connected server's artefacts, from the Mac (PRDCT-4474): the window's
 * list is this Mac's plus each server's, re-keyed; a server's preview is
 * framed through a loopback port of this Mac opened on the lease the
 * server's hold answers; a renewal that answers a new lease opens the new
 * forward before letting go of the old one; a release lets go of both, the
 * forward even when the server does not answer; a server's events arrive
 * re-keyed; a session of this Mac never opens a forward.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const LEASE_A = 'a'.repeat(32)
const LEASE_B = 'b'.repeat(32)
const artefactOf = (sessionId: string, title = 'deck'): Artefact => ({
  sessionId,
  target: `/srv/${title}`,
  page: `/srv/${title}/index.html`,
  title,
  openedAt: '2026-11-12T10:00:00.000Z'
})

interface Fixture {
  api: ElectronAPI
  calls: Array<{ owner: string; method: string; args: unknown[] }>
  localCalls: Array<{ method: string; args: unknown[] }>
  invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  /** What a server's hold answers next, by owner. */
  leases: Map<string, string>
  failing: Set<string>
  emit: (owner: string, event: ServerEvent) => void
  local: { emit: (change: { sessionId: string; artefact: Artefact | null }) => void }
}

function fixture(): Fixture {
  const calls: Fixture['calls'] = []
  const localCalls: Fixture['localCalls'] = []
  const events = new Map<string, (e: ServerEventEnvelope) => void>()
  const leases = new Map<string, string>([
    ['x', LEASE_A],
    ['y', LEASE_A]
  ])
  const failing = new Set<string>()
  let forwards = 0
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['x', 'y'].map((id) => ({
        id,
        name: `Server ${id}`,
        enabled: true,
        url: `http://${id}`
      }))
    if (channel === 'forwards:open') {
      forwards++
      return { url: `http://127.0.0.1:${40000 + forwards}/`, key: `${args[0]}:${args[1]}` }
    }
    if (channel === 'forwards:release') return undefined
    return { url: `http://${args[0]}`, token: 'test-only' }
  })
  const localChanged = new Set<(change: { sessionId: string; artefact: Artefact | null }) => void>()
  const localRecord =
    (method: string, answer: unknown) =>
    async (...args: unknown[]): Promise<unknown> => {
      localCalls.push({ method, args })
      return answer
    }
  const local = {
    artefacts: {
      list: async () => [artefactOf('own-1', 'mine')],
      hold: localRecord('hold', { url: 'http://127.0.0.1:5555/', holdId: 'lh', ttlMs: 90_000 }),
      release: localRecord('release', undefined),
      saveVersion: localRecord('saveVersion', { version: 1, created: true }),
      versions: localRecord('versions', { versions: [] }),
      close: localRecord('close', undefined),
      onChanged: (cb: (change: { sessionId: string; artefact: Artefact | null }) => void) => {
        localChanged.add(cb)
        return () => localChanged.delete(cb)
      },
      onPreviewExited: () => () => {},
      slidelessState: localRecord('slidelessState', { phase: 'ready', version: '1', error: null }),
      installSlideless: localRecord('installSlideless', null),
      onSlidelessState: () => () => {}
    }
  }
  let holds = 0
  const api = createFleetDesktop(local as unknown as ElectronAPI, {
    invoke,
    changed: () => () => {},
    connect: async (endpoint) => {
      const owner = new URL(endpoint.url).hostname
      const record =
        (method: string, answer: (...args: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
          calls.push({ owner, method, args })
          if (failing.has(owner)) throw new Error('The owning Clave server is not connected.')
          return answer(...args)
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
          routines: { list: async () => ({ routines: [] }) },
          artefacts: {
            list: async () => {
              if (failing.has(owner)) throw new Error('CapabilityUnavailable')
              return [artefactOf('wire-1', owner)]
            },
            hold: record(
              'hold',
              (_sessionId, holdId): ArtefactPreview => ({
                holdId: typeof holdId === 'string' ? holdId : `h${++holds}`,
                lease: leases.get(owner)!,
                url: 'http://127.0.0.1:9999/',
                ttlMs: 90_000
              })
            ),
            release: record('release', () => undefined),
            saveVersion: record('saveVersion', () => ({ version: 3, created: true })),
            versions: record('versions', () => ({ versions: [] })),
            close: record('close', () => undefined),
            slidelessState: record('slidelessState', () => ({
              phase: 'missing',
              version: null,
              error: null
            }))
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
  const emit = (owner: string, event: ServerEvent): void =>
    events.get(owner)!({ id: 'test', seq: 1, at: 1, event })
  return {
    api,
    calls,
    localCalls,
    invoke,
    leases,
    failing,
    emit,
    local: { emit: (change) => localChanged.forEach((cb) => cb(change)) }
  }
}

const X = sessionKey({ serverId: 'x', sessionId: 'wire-1' })
const forwardCalls = (h: Fixture): unknown[][] =>
  h.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('forwards:'))

let h: Fixture
beforeEach(async () => {
  h = fixture()
  await h.api.fleetList()
  await flush()
})
afterEach(async () => {
  await h.api.fleetDisconnect('x')
  await h.api.fleetDisconnect('y')
})

describe('a connected server’s artefacts', () => {
  it('lists this Mac’s and each server’s, the server’s sessions re-keyed', async () => {
    const listed = await h.api.artefacts.list()
    expect(listed.map((a) => [a.sessionId, a.title])).toEqual([
      ['own-1', 'mine'],
      [sessionKey({ serverId: 'x', sessionId: 'wire-1' }), 'x'],
      [sessionKey({ serverId: 'y', sessionId: 'wire-1' }), 'y']
    ])
  })

  it('a server that refuses contributes nothing and breaks nothing', async () => {
    h.failing.add('y')
    const listed = await h.api.artefacts.list()
    expect(listed.map((a) => a.sessionId)).toEqual(['own-1', X])
  })

  it('a remote hold opens a forward on the server’s lease and answers the Mac’s url', async () => {
    const held = await h.api.artefacts.hold(X)
    expect(h.calls).toEqual([{ owner: 'x', method: 'hold', args: ['wire-1', undefined] }])
    expect(forwardCalls(h)).toEqual([['forwards:open', 'x', LEASE_A]])
    expect(held).toEqual({ url: 'http://127.0.0.1:40001/', holdId: 'h1', ttlMs: 90_000 })
  })

  it('a renewal on the same lease opens nothing and keeps the url', async () => {
    const first = await h.api.artefacts.hold(X)
    const renewed = await h.api.artefacts.hold(X, first.holdId)
    expect(h.calls.at(-1)).toEqual({ owner: 'x', method: 'hold', args: ['wire-1', 'h1'] })
    expect(forwardCalls(h)).toEqual([['forwards:open', 'x', LEASE_A]])
    expect(renewed.url).toBe(first.url)
  })

  it('a renewal on a new lease opens the new forward BEFORE releasing the old one', async () => {
    const first = await h.api.artefacts.hold(X)
    h.leases.set('x', LEASE_B)
    const renewed = await h.api.artefacts.hold(X, first.holdId)
    expect(forwardCalls(h)).toEqual([
      ['forwards:open', 'x', LEASE_A],
      ['forwards:open', 'x', LEASE_B],
      ['forwards:release', `x:${LEASE_A}`]
    ])
    expect(renewed.url).toBe('http://127.0.0.1:40002/')
    // The release that follows lets go of the new forward, not the old one again.
    await h.api.artefacts.release(X, renewed.holdId)
    expect(forwardCalls(h).at(-1)).toEqual(['forwards:release', `x:${LEASE_B}`])
  })

  it('a release releases on the server and on this Mac', async () => {
    const held = await h.api.artefacts.hold(X)
    await h.api.artefacts.release(X, held.holdId)
    expect(h.calls.at(-1)).toEqual({ owner: 'x', method: 'release', args: ['wire-1', 'h1'] })
    expect(forwardCalls(h).at(-1)).toEqual(['forwards:release', `x:${LEASE_A}`])
  })

  it('a release whose server call fails still releases the forward', async () => {
    const held = await h.api.artefacts.hold(X)
    h.failing.add('x')
    await expect(h.api.artefacts.release(X, held.holdId)).rejects.toThrow()
    await flush()
    expect(forwardCalls(h).at(-1)).toEqual(['forwards:release', `x:${LEASE_A}`])
  })

  it('routes a version and a close to the server by the key', async () => {
    await expect(h.api.artefacts.saveVersion(X)).resolves.toEqual({ version: 3, created: true })
    await expect(h.api.artefacts.versions(X)).resolves.toEqual({ versions: [] })
    await h.api.artefacts.close(sessionKey({ serverId: 'y', sessionId: 'wire-2' }))
    expect(h.calls).toEqual([
      { owner: 'x', method: 'saveVersion', args: ['wire-1'] },
      { owner: 'x', method: 'versions', args: ['wire-1'] },
      { owner: 'y', method: 'close', args: ['wire-2'] }
    ])
  })

  it('a session of this Mac never touches forwards:open', async () => {
    const held = await h.api.artefacts.hold('own-1')
    await h.api.artefacts.hold('own-1', held.holdId)
    await h.api.artefacts.release('own-1', held.holdId)
    expect(held.url).toBe('http://127.0.0.1:5555/')
    expect(forwardCalls(h)).toEqual([])
    expect(h.localCalls.map((c) => c.method)).toEqual(['hold', 'hold', 'release'])
    expect(h.calls).toEqual([])
  })

  it('a server’s events arrive re-keyed, beside this Mac’s', async () => {
    const changes: unknown[] = []
    const exited: string[] = []
    const states: unknown[] = []
    h.api.artefacts.onChanged((change) => changes.push(change))
    h.api.artefacts.onPreviewExited((id) => exited.push(id))
    h.api.artefacts.onSlidelessState((change) => states.push(change))
    h.emit('x', {
      _tag: 'artefact.changed',
      sessionId: 'wire-1',
      artefact: artefactOf('wire-1')
    } as ServerEvent)
    h.emit('y', { _tag: 'artefact.changed', sessionId: 'wire-2', artefact: null } as ServerEvent)
    h.emit('x', { _tag: 'artefact.preview_exited', sessionId: 'wire-1' } as ServerEvent)
    h.emit('y', {
      _tag: 'slideless.state_changed',
      state: { phase: 'installing', version: null, error: null }
    } as ServerEvent)
    h.local.emit({ sessionId: 'own-1', artefact: null })
    expect(changes).toEqual([
      { sessionId: X, artefact: { ...artefactOf('wire-1'), sessionId: X } },
      { sessionId: sessionKey({ serverId: 'y', sessionId: 'wire-2' }), artefact: null },
      { sessionId: 'own-1', artefact: null }
    ])
    expect(exited).toEqual([X])
    expect(states).toEqual([
      { serverId: 'y', state: { phase: 'installing', version: null, error: null } }
    ])
  })

  it('reads a machine’s Slideless: this Mac without an id, a server by its id', async () => {
    await expect(h.api.artefacts.slidelessState()).resolves.toMatchObject({ phase: 'ready' })
    await expect(h.api.artefacts.slidelessState('x')).resolves.toMatchObject({ phase: 'missing' })
    await expect(h.api.artefacts.slidelessState('nowhere')).rejects.toThrow(
      'The owning Clave server is not connected.'
    )
  })
})
