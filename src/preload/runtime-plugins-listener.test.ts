import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimePluginsAPI } from '../shared/runtime-plugins'

vi.mock('electron', () => ({
  ipcRenderer: new EventEmitter(),
  contextBridge: { exposeInMainWorld: vi.fn() },
  webUtils: {}
}))

import { contextBridge, ipcRenderer } from 'electron'
import './index'

const channel = 'runtime-plugins:changed'
const exposed = vi.mocked(contextBridge.exposeInMainWorld).mock.calls
const api = exposed.find(([name]) => name === 'electronAPI')![1] as {
  runtimePlugins: RuntimePluginsAPI
}
const cleanups: Array<() => void> = []

function subscribe(callback: () => void): () => void {
  const cleanup = api.runtimePlugins.onChanged(callback)
  cleanups.push(cleanup)
  return cleanup
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  expect(ipcRenderer.listenerCount(channel)).toBe(0)
})

test('many registry subscribers share one native listener through cleanup and resubscribe', () => {
  expect(ipcRenderer.listenerCount(channel)).toBe(0)
  const callbacks = Array.from({ length: 20 }, () => vi.fn())
  const unsubscribe = callbacks.map(subscribe)
  expect(ipcRenderer.listenerCount(channel)).toBe(1)

  ipcRenderer.emit(channel, { sender: 'private IPC event' })
  for (const callback of callbacks) {
    expect(callback).toHaveBeenCalledExactlyOnceWith()
  }

  unsubscribe[0]()
  unsubscribe[0]()
  expect(ipcRenderer.listenerCount(channel)).toBe(1)
  ipcRenderer.emit(channel, {})
  expect(callbacks[0]).toHaveBeenCalledTimes(1)
  for (const callback of callbacks.slice(1)) expect(callback).toHaveBeenCalledTimes(2)

  for (const cleanup of unsubscribe.slice(1)) cleanup()
  expect(ipcRenderer.listenerCount(channel)).toBe(0)

  const next = vi.fn()
  const stopNext = subscribe(next)
  expect(ipcRenderer.listenerCount(channel)).toBe(1)
  unsubscribe[0]()
  ipcRenderer.emit(channel, {})
  expect(next).toHaveBeenCalledExactlyOnceWith()
  stopNext()
  expect(ipcRenderer.listenerCount(channel)).toBe(0)
})

test('duplicate callback subscriptions have independent, idempotent cleanup', () => {
  const callback = vi.fn()
  const stopFirst = subscribe(callback)
  const stopSecond = subscribe(callback)
  expect(ipcRenderer.listenerCount(channel)).toBe(1)
  ipcRenderer.emit(channel, {})
  expect(callback).toHaveBeenCalledTimes(2)

  stopFirst()
  stopFirst()
  expect(ipcRenderer.listenerCount(channel)).toBe(1)
  ipcRenderer.emit(channel, {})
  expect(callback).toHaveBeenCalledTimes(3)

  stopSecond()
  expect(ipcRenderer.listenerCount(channel)).toBe(0)
  ipcRenderer.emit(channel, {})
  expect(callback).toHaveBeenCalledTimes(3)
})
