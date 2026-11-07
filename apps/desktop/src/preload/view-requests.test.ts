/**
 * The preload's two roads for the agent tools (wave 3): a view request the
 * server pushes for THIS window's key runs the dispatcher once, even when the
 * same request reaches the window again (a reconnected socket is a new peer
 * to the server, which sends every waiting request again), and is answered
 * through the server; a request of another window's key is ignored; the IPC
 * road the harness drives is answered over IPC and never through the server.
 * Electron and the client are replaced, as `antasphere-bridge.test.ts` does.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn(),
  requestListeners: new Set<(r: unknown) => void>(),
  answer: vi.fn(async () => undefined),
  connect: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    send: mocks.send,
    removeListener: mocks.removeListener
  },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async () => ({
    api: { views: { answer: mocks.answer } },
    push: {
      connect: mocks.connect,
      onRequest: (listener: (r: unknown) => void) => {
        mocks.requestListeners.add(listener)
        return () => mocks.requestListeners.delete(listener)
      }
    }
  })
}))
import './index'

const api = mocks.exposed.get('electronAPI') as ElectronAPI
mocks.invoke.mockImplementation(async (channel: string) => {
  if (channel === 'server:endpoint') return { url: 'http://127.0.0.1:1', token: 't' }
  if (channel === 'window:identity') return { windowKey: 'w1' }
  return null
})
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
const pushRequest = (frame: unknown): void => {
  for (const listener of mocks.requestListeners) listener(frame)
}

describe('the preload and the view requests', () => {
  it('runs a request of its own key once, answers it through the server, and ignores another key', async () => {
    const seen: unknown[] = []
    api.onMcpCommand((msg) => seen.push(msg))
    await settle()
    expect(mocks.requestListeners.size).toBe(1)
    const frame = {
      requestId: 'r1',
      windowKey: 'w1',
      command: 'createGroup',
      payload: { name: 'x' }
    }
    pushRequest(frame)
    await settle()
    pushRequest(frame)
    await settle()
    expect(seen).toEqual([{ requestId: 'r1', command: 'createGroup', payload: { name: 'x' } }])
    api.mcpRespond({ requestId: 'r1', ok: true, result: 1 })
    await settle()
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.answer).toHaveBeenCalledWith({ requestId: 'r1', ok: true, result: 1 })
    expect(mocks.send).not.toHaveBeenCalledWith('mcp:response', expect.anything())
    pushRequest({ requestId: 'r2', windowKey: 'w2', command: 'list', payload: {} })
    await settle()
    expect(seen).toHaveLength(1)
  })
  it('answers a request that came over IPC (the harness) over IPC, never through the server', async () => {
    const call = mocks.on.mock.calls.find(([channel]) => channel === 'mcp:command')
    expect(call).toBeDefined()
    const handler = call![1] as (event: unknown, msg: unknown) => void
    handler({}, { requestId: 'ipc1', command: 'list', payload: {} })
    api.mcpRespond({ requestId: 'ipc1', ok: true, result: 2 })
    await settle()
    expect(mocks.send).toHaveBeenCalledWith('mcp:response', {
      requestId: 'ipc1',
      ok: true,
      result: 2
    })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
  })
})
