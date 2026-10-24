/**
 * Main's two answers about the server for a window, and its word when it
 * names one (PRDCT-3527): `server:external` answers the launch decision at
 * once, before the server is up, and every window hears
 * `server:endpoint-named` the moment main names it, so none waits for its
 * next poll (two seconds of a launch's restore before).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FLEET_IPC, type SavedServerConnection } from '../../../packages/contract/src/fleet'
import { ServerConnectionRegistry } from '../server-connections/registry'
import { fileStorage } from '../ports/storage'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ window: number; channel: string }> = []
const windows = [1, 2].map((id) => ({
  isDestroyed: () => false,
  webContents: { send: (channel: string) => sent.push({ window: id, channel }) }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
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

describe('saved fleet connection IPC', () => {
  let dir: string
  let registry: ServerConnectionRegistry
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clave-vps-a-ipc-'))
    registry = new ServerConnectionRegistry(
      {
        storage: fileStorage(dir),
        secrets: {
          available: () => true,
          seal: () => 'opaque-ref',
          open: () => 'private-token',
          discard: vi.fn()
        }
      },
      () => 'server-a'
    )
    handlers.clear()
    registerServerHandlers(registry)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel)
    expect(handler, `Missing handler ${channel}`).toBeTypeOf('function')
    return handler!({}, ...args)
  }

  it('returns only public records and broadcasts save/disconnect/connect/remove to all windows', () => {
    const saved = invoke(FLEET_IPC.save, {
      name: 'VPS',
      url: 'http://100.64.0.1:9000',
      token: 'private-token'
    }) as SavedServerConnection
    expect(saved).toEqual({
      id: 'server-a',
      name: 'VPS',
      url: 'http://100.64.0.1:9000',
      enabled: true
    })
    expect(invoke(FLEET_IPC.list)).toEqual([saved])
    expect(invoke(FLEET_IPC.endpoint, saved.id)).toEqual({ url: saved.url, token: 'private-token' })
    expect(invoke(FLEET_IPC.disconnect, saved.id)).toEqual({ ...saved, enabled: false })
    expect(() => invoke(FLEET_IPC.endpoint, saved.id)).toThrow(/disconnected/i)
    expect(invoke(FLEET_IPC.connect, saved.id)).toEqual(saved)
    invoke(FLEET_IPC.remove, saved.id)
    expect(invoke(FLEET_IPC.list)).toEqual([])
    expect(sent).toEqual(
      Array.from({ length: 4 }, () => [
        { window: 1, channel: FLEET_IPC.changed },
        { window: 2, channel: FLEET_IPC.changed }
      ]).flat()
    )
    expect(JSON.stringify(sent)).not.toMatch(/private-token|opaque-ref/)
    expect(handlers.get('server:endpoint')?.()).toBeNull()
  })

  it('does not broadcast failed mutations and leaves the local endpoint intact', () => {
    setClaveServerEndpoint({ url: 'http://127.0.0.1:9', token: 'local-token', mode: 'in-process' })
    sent.length = 0
    expect(() =>
      invoke(FLEET_IPC.save, { name: 'bad', url: 'http://user:private-token@host' })
    ).toThrow()
    expect(() => invoke(FLEET_IPC.remove, 'missing')).toThrow()
    expect(() => invoke(FLEET_IPC.endpoint, 'local')).toThrow()
    expect(sent).toEqual([])
    expect(handlers.get('server:endpoint')?.()).toEqual({
      url: 'http://127.0.0.1:9',
      token: 'local-token',
      mode: 'in-process'
    })
  })
})
