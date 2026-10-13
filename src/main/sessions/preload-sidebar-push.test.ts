import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'

/**
 * The preload's sidebar push (lane B of wave 5, PRDCT-3428, PRDCT-3432): the
 * catch-up read made once the push socket is welcomed hands the layout to the
 * listeners with NO cause, so the store takes a running record in and selects
 * nothing (a cause invented there, 'command', made a closing window's tab
 * take the selection, lane D's round-5 F9); a change pushed by the server
 * keeps the cause it came with. And the boot's records predicate: whether the
 * boot's IPC listing is every adoptable record (in-process) or the server's
 * come after it (attached, or a mode not yet named). Same doubles as
 * preload-routing.test.ts: the module keeps state, so each test imports a
 * fresh copy.
 */
type Listener = (...args: unknown[]) => void
type PushDouble = {
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  subscribed: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  whenOpen: ReturnType<typeof vi.fn>
  events: Set<Listener>
}
const mocks = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    createApiClient: vi.fn(),
    push: null as null | PushDouble,
    getLayout: vi.fn(),
    makePush: (): PushDouble => {
      const push: PushDouble = {
        connect: vi.fn(() => push),
        close: vi.fn(),
        events: new Set(),
        subscribe: vi.fn(() => () => {}),
        subscribed: vi.fn(async (id: string) => ({ id, via: 'server' })),
        onEvent: vi.fn((listener: Listener) => {
          push.events.add(listener)
          return () => {
            push.events.delete(listener)
          }
        }),
        whenOpen: vi.fn(async () => undefined)
      }
      return push
    },
    emitEvent: (event: Record<string, unknown>): void => {
      for (const listener of state.push?.events ?? []) listener({ event })
    }
  }
  return state
})
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener
  },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async (endpoint: { url: string; token: string }) => {
    const push = mocks.makePush()
    mocks.push = push
    return { api: mocks.createApiClient(endpoint), push }
  }
}))

let api: ElectronAPI
const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret', mode: 'in-process' }
const attachedEndpoint = { ...endpoint, mode: 'attached' }
const identity = { windowId: 1, windowKey: 'w-7', workspaceId: null, isPrimary: true }
const onServer = {
  'server:endpoint': endpoint,
  'window:identity': identity,
  'sidebar:transport': 'server'
}
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => table[channel])
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}
const layoutOnServer = { windowKey: 'w-7', revision: 9, groups: [], displayOrder: ['x'] }

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.invoke.mockReset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  delete process.env.CLAVE_SERVER_URL
  delete process.env.CLAVE_SERVER_TOKEN
  mocks.push = null
  mocks.getLayout = vi.fn(async () => layoutOnServer)
  mocks.createApiClient.mockImplementation(() => ({
    sessions: { list: vi.fn(async () => []) },
    sidebar: { getLayout: mocks.getLayout }
  }))
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the sidebar catch-up read', () => {
  it('hands the layout to the listeners with no cause, and a pushed change with the cause it came with', async () => {
    answer(onServer)
    const heard: unknown[] = []
    api.onSidebarLayoutChanged((event) => heard.push(event))
    // A routed call connects the backing; the sidebar's wire rides onServerAvailable.
    await api.sessionsList()
    await settle()
    expect(mocks.push).not.toBeNull()
    expect(mocks.getLayout).toHaveBeenCalledWith('w-7')
    expect(heard).toHaveLength(1)
    const catchUp = heard[0] as { layout: unknown; cause?: unknown }
    expect(catchUp.layout).toEqual(layoutOnServer)
    expect('cause' in catchUp).toBe(false)
    // The server's own push keeps its word.
    mocks.emitEvent({ _tag: 'sidebar.layout_changed', layout: layoutOnServer, cause: 'move' })
    expect(heard).toHaveLength(2)
    expect((heard[1] as { cause?: string }).cause).toBe('move')
  })

  it('reads nothing for a window without a key', async () => {
    answer({ ...onServer, 'window:identity': null })
    api.onSidebarLayoutChanged(() => {})
    await api.sessionsList()
    await settle()
    expect(mocks.getLayout).not.toHaveBeenCalled()
  })
})

describe('whether the boot’s records listing is complete', () => {
  it('is complete inside the app: the IPC read holds every adoptable record', async () => {
    answer(onServer)
    expect(await api.bootRecordsComplete()).toBe(true)
  })

  it('is not complete attached: the server’s records come after the boot', async () => {
    answer({ ...onServer, 'server:endpoint': attachedEndpoint })
    expect(await api.bootRecordsComplete()).toBe(false)
  })

  it('is not complete while main has named no server yet, and is asked again on the next call', async () => {
    answer({ 'server:endpoint': null, 'window:identity': identity })
    expect(await api.bootRecordsComplete()).toBe(false)
    answer(onServer)
    expect(await api.bootRecordsComplete()).toBe(true)
  })
})
