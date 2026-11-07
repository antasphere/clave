/**
 * The preload's plugin roads (wave 5, lane C, PRDCT-3433). The lease, the
 * revoke, the panel and the focus report go through the IPC arms whether or
 * not main has named a server (the arms hold the page's URL, the reload drop
 * and the window's close watch, which the server cannot); a view's events are
 * the session's own stream, read for the lease's session and no other; the
 * plugin change is heard on the push channel once the socket is open, with
 * one re-list at the welcome; and a window relays the server's plugin events
 * to the shell on the binding `onMcpCommand` holds. The doubles are those of
 * `preload-server-events.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'

type Listener = (...args: unknown[]) => void
type PushDouble = {
  status: string
  connect: ReturnType<typeof vi.fn>
  whenOpen: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onStatus: ReturnType<typeof vi.fn>
  onRequest: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  subscribed: ReturnType<typeof vi.fn>
  events: Set<Listener>
  statuses: Set<Listener>
  open: () => void
}
const mocks = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    plugins: {} as Record<string, ReturnType<typeof vi.fn>>,
    push: null as null | PushDouble,
    makePush: (): PushDouble => {
      let resolveOpen: () => void = () => {}
      const opened = new Promise<void>((r) => {
        resolveOpen = r
      })
      const push: PushDouble = {
        status: 'connecting',
        connect: vi.fn(() => push),
        whenOpen: vi.fn(() => opened),
        onEvent: vi.fn((listener: Listener) => {
          push.events.add(listener)
          return () => {
            push.events.delete(listener)
          }
        }),
        onStatus: vi.fn((listener: Listener) => {
          push.statuses.add(listener)
          return () => {
            push.statuses.delete(listener)
          }
        }),
        onRequest: vi.fn(() => () => {}),
        subscribe: vi.fn(() => () => {}),
        subscribed: vi.fn(async (id: string) => ({ id })),
        events: new Set(),
        statuses: new Set(),
        open: () => {
          push.status = 'open'
          for (const listener of [...push.statuses]) listener('open', { attempt: 1 })
          resolveOpen()
        }
      }
      return push
    },
    emitEvent: (event: Record<string, unknown>, id = 'e1'): void => {
      for (const listener of mocks.push?.events ?? []) listener({ id, seq: 1, at: 0, event })
    }
  }
  return state
})
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async () => {
    const push = mocks.makePush()
    mocks.push = push
    return { api: { plugins: mocks.plugins }, push }
  }
}))

let api: ElectronAPI
const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret', mode: 'in-process' }
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => table[channel])
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const channels = (): string[] => mocks.invoke.mock.calls.map(([c]) => c as string)
/** The IPC listener main would send on, as the preload bound it. */
const ipcListenerOn = (channel: string): ((event: unknown, ...args: unknown[]) => void) => {
  const found = mocks.on.mock.calls.filter(([c]) => c === channel).at(-1)?.[1]
  if (typeof found !== 'function') throw new Error(`no IPC listener bound on ${channel}`)
  return found as (event: unknown, ...args: unknown[]) => void
}
const ipcListenersOn = (channel: string): number =>
  mocks.on.mock.calls.filter(([c]) => c === channel).length -
  mocks.removeListener.mock.calls.filter(([c]) => c === channel).length
/** The server comes: a routed call connects the backing and announces it. A
 *  watch ask still in flight (a listener bound just before) would answer the
 *  call with its own null endpoint, so it is let finish first. */
const serverComes = async (): Promise<void> => {
  await settle()
  answer({ 'server:endpoint': endpoint })
  await api.pluginsList().catch(() => undefined)
  await settle()
  expect(mocks.push).not.toBeNull()
}
const lease = { leaseId: 'l1', url: 'clave-preview://t/view.html', sessionId: 's1' }

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.invoke.mockReset()
  mocks.push = null
  mocks.plugins = {
    list: vi.fn(async () => [{ id: 'server' }]),
    leaseView: vi.fn(async () => ({ ...lease, file: '/f', csp: '' })),
    revokeView: vi.fn(async () => undefined),
    panel: vi.fn(async () => ({ file: '/f', csp: '' })),
    context: vi.fn(async () => undefined)
  }
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the lease, the revoke, the panel and the focus report go through the arm', () => {
  it('before any server is named', async () => {
    answer({ 'server:endpoint': null, 'plugins:view-lease': lease, 'plugins:panel': { url: 'u' } })
    expect(await api.pluginsViewLease('p', 'log', 's1')).toEqual(lease)
    expect(await api.pluginsPanel('p', 'side')).toEqual({ url: 'u' })
    await api.pluginsContext('s1')
    await api.pluginsViewRevoke('l1')
    expect(channels().filter((c) => c !== 'server:endpoint' && c !== 'server:external')).toEqual([
      'plugins:view-lease',
      'plugins:panel',
      'plugins:context',
      'plugins:view-revoke'
    ])
  })
  it('and once main named one, while the list goes to the server', async () => {
    await serverComes()
    expect(mocks.plugins.list).toHaveBeenCalledTimes(1)
    answer({
      'server:endpoint': endpoint,
      'plugins:view-lease': lease,
      'plugins:panel': { url: 'u' }
    })
    mocks.invoke.mockClear()
    expect(await api.pluginsViewLease('p', 'log', 's1')).toEqual(lease)
    expect(await api.pluginsPanel('p', 'side')).toEqual({ url: 'u' })
    await api.pluginsContext(null)
    await api.pluginsViewRevoke('l1')
    expect(channels()).toEqual([
      'plugins:view-lease',
      'plugins:panel',
      'plugins:context',
      'plugins:view-revoke'
    ])
    expect(mocks.plugins.leaseView).not.toHaveBeenCalled()
    expect(mocks.plugins.panel).not.toHaveBeenCalled()
    expect(mocks.plugins.context).not.toHaveBeenCalled()
    expect(mocks.plugins.revokeView).not.toHaveBeenCalled()
  })
})

describe("a view's events are the lease's session's own stream", () => {
  it('reads the stream of the session the lease named, subscribing when nobody in the window had', async () => {
    answer({
      'server:endpoint': null,
      'plugins:view-lease': lease,
      'sessions:subscribe': { id: 's1' }
    })
    await api.pluginsViewLease('p', 'log', 's1')
    const heard: unknown[] = []
    const stop = api.onPluginViewEvent('l1', (event) => heard.push(event))
    await settle()
    expect(channels()).toContain('sessions:subscribe')
    ipcListenerOn('sessions:stream:s1')(
      {},
      { kind: 'event', event: { type: 'state_change', state: 'working' } }
    )
    ipcListenerOn('sessions:stream:s1')({}, { kind: 'data', data: 'bytes' })
    expect(heard).toEqual([{ type: 'state_change', state: 'working' }])
    stop()
    expect(ipcListenersOn('sessions:stream:s1')).toBe(0)
    expect(channels()).toContain('sessions:unsubscribe')
  })
  it('hears nothing for a lease this window never took, or gave back', async () => {
    answer({ 'server:endpoint': null, 'plugins:view-lease': lease })
    expect(api.onPluginViewEvent('unknown', () => undefined)).toBeTypeOf('function')
    expect(ipcListenersOn('sessions:stream:s1')).toBe(0)
    await api.pluginsViewLease('p', 'log', 's1')
    await api.pluginsViewRevoke('l1')
    api.onPluginViewEvent('l1', () => undefined)
    expect(ipcListenersOn('sessions:stream:s1')).toBe(0)
  })
})

describe('the plugin change and the relay of the server’s plugin events', () => {
  it('is heard over IPC before the server, then on the push channel, with nothing at the welcome', async () => {
    answer({ 'server:endpoint': null })
    let changes = 0
    const stop = api.onPluginsChanged(() => {
      changes += 1
    })
    ipcListenerOn('plugins:changed')({})
    expect(changes).toBe(1)
    await serverComes()
    mocks.push!.open()
    await settle()
    // No catch-up at the welcome: the stores listed at their mount and
    // re-list on a change; a welcome's re-list to every subscriber at once
    // was a full-tree re-render at a chat's first rows.
    expect(changes).toBe(1)
    expect(ipcListenersOn('plugins:changed')).toBe(0)
    mocks.emitEvent({ _tag: 'plugins.changed' })
    expect(changes).toBe(2)
    stop()
    mocks.emitEvent({ _tag: 'plugins.changed' })
    expect(changes).toBe(2)
  })
  it('relays a notification and a change to the shell, with the event’s id, on the binding onMcpCommand holds', async () => {
    answer({ 'server:endpoint': null })
    const stop = api.onMcpCommand(() => undefined)
    await serverComes()
    mocks.push!.open()
    await settle()
    mocks.invoke.mockClear()
    mocks.emitEvent(
      { _tag: 'plugins.notified', pluginId: 'p', name: 'Hello', title: 'Done', body: 'All good' },
      'n1'
    )
    mocks.emitEvent({ _tag: 'plugins.changed' }, 'c1')
    await settle()
    expect(mocks.invoke.mock.calls).toEqual([
      ['plugins:show-notification', 'n1', 'Hello', 'Done', 'All good'],
      ['plugins:changed-heard', 'c1']
    ])
    stop()
    mocks.invoke.mockClear()
    mocks.emitEvent({ _tag: 'plugins.changed' }, 'c2')
    await settle()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
