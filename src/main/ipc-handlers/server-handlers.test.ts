/**
 * Main's two answers about the server for a window, and its word when it
 * names one (PRDCT-3527): `server:external` answers the launch decision at
 * once, before the server is up, and every window hears
 * `server:endpoint-named` the moment main names it, so none waits for its
 * next poll (two seconds of a launch's restore before).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, () => unknown>()
const sent: Array<{ window: number; channel: string }> = []
const windows = [1, 2].map((id) => ({
  isDestroyed: () => false,
  webContents: { send: (channel: string) => sent.push({ window: id, channel }) }
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: () => unknown) => handlers.set(channel, fn) },
  BrowserWindow: { getAllWindows: () => windows }
}))

import { registerServerHandlers } from './server-handlers'
import {
  resetClaveServerBootForTests,
  setClaveServerEndpoint,
  setServerExternal
} from '../server/endpoint'

beforeEach(() => {
  resetClaveServerBootForTests()
  handlers.clear()
  sent.length = 0
  registerServerHandlers()
})

describe('the server handlers', () => {
  it('answers whether the launch is external, before any server is named', () => {
    expect(handlers.get('server:external')?.()).toBe(false)
    setServerExternal(true)
    expect(handlers.get('server:external')?.()).toBe(true)
    expect(handlers.get('server:endpoint')?.()).toBeNull()
  })
  it('tells every window when the server is named', () => {
    expect(sent).toEqual([])
    setClaveServerEndpoint({ url: 'http://127.0.0.1:9', token: 't', mode: 'attached' })
    expect(sent).toEqual([
      { window: 1, channel: 'server:endpoint-named' },
      { window: 2, channel: 'server:endpoint-named' }
    ])
  })
})
