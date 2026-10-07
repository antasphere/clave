import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'
const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}
}))
import '../../preload/index'
const api = mocks.exposed.get('electronAPI') as ElectronAPI
/** The IPC calls made, the router's own endpoint lookups left out. */
const ipcCalls = (): unknown[][] =>
  mocks.invoke.mock.calls.filter(([channel]) => channel !== 'server:endpoint')

beforeEach(() => {
  vi.clearAllMocks()
  // Main names no server here: every method goes over IPC, as before the split.
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === 'server:endpoint' ? null : { id: 'session' }
  )
})

describe('session preload bridge', () => {
  it('reference-counts subscriptions so one view cannot detach another', async () => {
    await api.sessionsSubscribe('shared')
    await api.sessionsSubscribe('shared')
    mocks.invoke.mockClear()
    await api.sessionsUnsubscribe('shared')
    expect(ipcCalls()).toEqual([])
    await api.sessionsUnsubscribe('shared')
    expect(ipcCalls()).toEqual([['sessions:unsubscribe', 'shared']])
  })
  it('rolls back a rejected subscription before another attempt', async () => {
    mocks.invoke.mockImplementationOnce(async (channel: string) => {
      if (channel === 'server:endpoint') return null
      throw new Error('Unknown session')
    })
    mocks.invoke.mockImplementationOnce(async () => {
      throw new Error('Unknown session')
    })
    await expect(api.sessionsSubscribe('retry')).rejects.toThrow('Unknown session')
    await api.sessionsSubscribe('retry')
    mocks.invoke.mockClear()
    await api.sessionsUnsubscribe('retry')
    expect(ipcCalls()).toEqual([['sessions:unsubscribe', 'retry']])
  })
  it('keeps the legacy PTY exit listener and adapter exit listener on their own channels', () => {
    const legacy = api.onSessionExit('id', () => {})
    const adapter = api.onSessionStreamExit('id', () => {})
    expect(mocks.on.mock.calls.map(([channel]) => channel)).toEqual([
      'pty:exit:id',
      'sessions:exit:id'
    ])
    legacy()
    adapter()
    expect(mocks.removeListener.mock.calls.map(([channel]) => channel)).toEqual([
      'pty:exit:id',
      'sessions:exit:id'
    ])
  })
  it('forwards typed messages and byte input without coercion', async () => {
    const bytes = new Uint8Array([0xc3, 0xa9])
    await api.sessionsWrite('id', bytes)
    await api.sessionsWrite('id', { type: 'user_message', text: 'hello' })
    expect(ipcCalls()).toEqual([
      ['sessions:write', 'id', bytes],
      ['sessions:write', 'id', { type: 'user_message', text: 'hello' }]
    ])
  })
})
