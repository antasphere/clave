import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'

/**
 * The model push at the bridge (PRDCT-4256): main sends a session's model on
 * the window's IPC channel and on the server's push channel, and the window
 * hears exactly one. Main names no server here (`server:endpoint` answers
 * null), so this is the IPC road: the one a window is on before its push
 * socket is welcomed, which the first chip switch of a fresh window takes.
 */
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
import './index'
const api = mocks.exposed.get('electronAPI') as ElectronAPI

type IpcListener = (event: unknown, ...args: unknown[]) => void
const listenersOn = (channel: string): IpcListener[] =>
  mocks.on.mock.calls.filter(([c]) => c === channel).map(([, listener]) => listener as IpcListener)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === 'server:endpoint' ? null : undefined
  )
})

describe('the session model listener on the IPC road', () => {
  it('binds the IPC channel at once and hands the window what main sent', () => {
    const heard: unknown[] = []
    const off = api.onSessionModelChanged((payload) => heard.push(payload))
    const [listener, ...more] = listenersOn('session:model-changed')
    expect(more).toEqual([])
    expect(listener).toBeTypeOf('function')
    listener({}, { id: 's1', model: 'claude-opus-5-5' })
    listener({}, { id: 's1', model: 'claude-fable-5-1[1m]' })
    expect(heard).toEqual([
      { id: 's1', model: 'claude-opus-5-5' },
      { id: 's1', model: 'claude-fable-5-1[1m]' }
    ])
    off()
    expect(mocks.removeListener).toHaveBeenCalledWith('session:model-changed', listener)
  })
})
