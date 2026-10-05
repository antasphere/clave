import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'

/** The preload's router, on its one routed method: `sessionsList` goes over
 *  IPC while main knows no server, to the server (scoped to the window) once
 *  it does, and a server failure reaches the caller rather than IPC. */
const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  apiList: vi.fn(),
  createApiClient: vi.fn(),
  router: null as null | { reset: () => void }
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}
}))
vi.mock('@clave/client/router', async (importActual) => {
  const actual = await importActual<typeof import('@clave/client/router')>()
  return {
    ...actual,
    // The preload builds its router once at import; the tests reset it.
    createMethodRouter: (options: Parameters<typeof actual.createMethodRouter>[0]) => {
      const router = actual.createMethodRouter(options)
      mocks.router = router
      return router
    }
  }
})
// The preload builds its backing through the Node transport
// (`@clave/client/node`, ADR 0003); the double hands back the mocked request
// client for the endpoint it was given, and a push client that never opens.
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async (endpoint: { url: string; token: string }) => ({
    api: mocks.createApiClient(endpoint),
    push: {
      connect(): unknown {
        return this
      },
      close(): void {
        /* nothing to close in a test double */
      }
    }
  })
}))
import '../../preload/index'
const api = mocks.exposed.get('electronAPI') as ElectronAPI

const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret' }
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel in table) {
      const value = table[channel]
      if (value instanceof Error) throw value
      return value
    }
    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.router?.reset()
  delete process.env.CLAVE_SERVER_URL
  delete process.env.CLAVE_SERVER_TOKEN
  mocks.createApiClient.mockReturnValue({ sessions: { list: mocks.apiList } })
})

describe('the preload routes sessionsList', () => {
  it('goes over IPC while main has no server, and keeps going there', async () => {
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    expect(mocks.createApiClient).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.map(([c]) => c)).toEqual(['server:endpoint', 'sessions:list'])
  })
  it('goes to the server, scoped to this window, once main names an endpoint', async () => {
    answer({
      'server:endpoint': endpoint,
      'window:identity': { windowId: 1, windowKey: 'w-7', workspaceId: null, isPrimary: true },
      'sessions:list': [{ id: 'ipc' }]
    })
    mocks.apiList.mockResolvedValue([{ id: 'server' }])
    expect(await api.sessionsList()).toEqual([{ id: 'server' }])
    expect(mocks.createApiClient).toHaveBeenCalledExactlyOnceWith(endpoint)
    expect(mocks.apiList).toHaveBeenCalledExactlyOnceWith('w-7')
    expect(mocks.invoke.mock.calls.map(([c]) => c)).not.toContain('sessions:list')
  })
  it('answers nothing for a window without a key, as IPC does', async () => {
    answer({ 'server:endpoint': endpoint, 'window:identity': null })
    expect(await api.sessionsList()).toEqual([])
    expect(mocks.apiList).not.toHaveBeenCalled()
  })
  it('lets the server’s failure through instead of falling back to IPC', async () => {
    answer({
      'server:endpoint': endpoint,
      'window:identity': { windowId: 1, windowKey: 'w-7', workspaceId: null, isPrimary: true },
      'sessions:list': [{ id: 'ipc' }]
    })
    mocks.apiList.mockRejectedValue(new Error('server down'))
    await expect(api.sessionsList()).rejects.toThrow('server down')
    expect(mocks.invoke.mock.calls.map(([c]) => c)).not.toContain('sessions:list')
  })
  it('never reads an endpoint from its own environment: main over IPC is the only source', async () => {
    process.env.CLAVE_SERVER_URL = 'http://127.0.0.1:9/outer'
    process.env.CLAVE_SERVER_TOKEN = 'outer'
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    expect(mocks.createApiClient).not.toHaveBeenCalled()
  })
  it('asks main again on the next call while there is no server yet', async () => {
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    answer({
      'server:endpoint': endpoint,
      'window:identity': { windowId: 1, windowKey: 'w-7', workspaceId: null, isPrimary: true }
    })
    mocks.apiList.mockResolvedValue([{ id: 'server' }])
    expect(await api.sessionsList()).toEqual([{ id: 'server' }])
  })
})
