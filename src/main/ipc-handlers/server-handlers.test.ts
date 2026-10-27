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
const payloads: Array<{ channel: string; args: unknown[] }> = []
const windows = [1, 2].map((id) => ({
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ window: id, channel })
      if (id === 1) payloads.push({ channel, args })
    }
  }
}))
// A packaged app on a beta, for the version sync's own wiring (issue #266).
const electronApp = vi.hoisted(() => ({ isPackaged: true, getVersion: () => '3.0.0-beta.9' }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: { getAllWindows: () => windows },
  app: electronApp
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
  registerServerHandlers(undefined, { versionSync: null })
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
    registerServerHandlers(registry, { versionSync: null })
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

describe('the version sync behind the fleet IPC (issue #266)', () => {
  let dir: string
  let registry: ServerConnectionRegistry
  const stops: Array<() => Promise<unknown>> = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clave-srvup-ipc-'))
    let tokens = 0
    const sealed = new Map<string, string>()
    let ids = 0
    registry = new ServerConnectionRegistry(
      {
        storage: fileStorage(dir),
        secrets: {
          available: () => true,
          seal: (token: string) => {
            const ref = `ref-${++tokens}`
            sealed.set(ref, token)
            return ref
          },
          open: (ref: string) => sealed.get(ref)!,
          discard: vi.fn()
        }
      },
      () => `server-${++ids}`
    )
    handlers.clear()
    sent.length = 0
    payloads.length = 0
  })
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const invoke = (channel: string, ...args: unknown[]): unknown =>
    handlers.get(channel)!({}, ...args)

  it('refreshes when the saved list changes, answers the results, and upgrades now through the sync', async () => {
    const calls: string[] = []
    const sync = {
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      refresh: async () => (calls.push('refresh'), []),
      results: () => (calls.push('results'), []),
      refreshServer: async (id: string) => (calls.push(`one:${id}`), []),
      upgradeNow: async (id: string) => (calls.push(`now:${id}`), { serverId: id } as never)
    }
    registerServerHandlers(registry, { versionSync: sync })
    expect(calls).toEqual(['start'])
    invoke(FLEET_IPC.save, { name: 'VPS', url: 'http://100.64.0.1:9000', token: 'private-token' })
    expect(calls).toEqual(['start', 'refresh'])
    expect(await invoke(FLEET_IPC.versions)).toEqual([])
    expect(await invoke(FLEET_IPC.versions, true)).toEqual([])
    await invoke(FLEET_IPC.upgradeNow, 'server-1')
    // A window heard the server's upgrade change: that server alone is read again.
    await invoke(FLEET_IPC.versionRefresh, 'server-1')
    expect(calls).toEqual([
      'start',
      'refresh',
      'results',
      'refresh',
      'now:server-1',
      'one:server-1'
    ])
  })

  it("reads each enabled server through main's own client, and asks an older one to upgrade once idle", async () => {
    const { startEmbedded } = await import('@clave/server')
    const { FakeSource } = await import('@clave/server/test-support')
    const { createServer } = await import('node:http')
    // A daemon installed from the beta.8 tag, recording what it is asked.
    const asked: unknown[] = []
    const daemon = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        serverInfo: {
          info: () => ({
            version: '3.0.0-beta.8',
            installRef: 'v3.0.0-beta.8',
            upgrade: { supported: true, state: 'idle' }
          }),
          requestUpgrade: (request) => {
            asked.push(request)
            return {
              supported: true,
              state: 'waiting-for-idle',
              target: request.version,
              mode: 'when-idle'
            }
          },
          subscribe: () => () => {}
        }
      }
    })
    stops.push(() => daemon.stop())
    // A server from before the domain: its router's 404.
    const old = createServer((_request, response) =>
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    )
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve))
    stops.push(() => new Promise((resolve) => old.close(resolve)))
    const oldUrl = `http://127.0.0.1:${(old.address() as { port: number }).port}`
    registerServerHandlers(registry)
    registry.save({ name: 'VPS', url: daemon.url, token: daemon.token })
    registry.save({ name: 'Old', url: oldUrl, token: 'old-token' })
    const results = (await invoke(FLEET_IPC.versions, true)) as Array<Record<string, unknown>>
    expect(results).toEqual([
      expect.objectContaining({
        serverId: 'server-1',
        kind: 'upgrading',
        serverVersion: '3.0.0-beta.8',
        target: '3.0.0-beta.9'
      }),
      expect.objectContaining({
        serverId: 'server-2',
        kind: 'manual',
        command: 'bash ~/install-server.sh --ref v3.0.0-beta.9'
      })
    ])
    expect(asked).toEqual([{ version: '3.0.0-beta.9', when: 'idle' }])
    expect(payloads.filter((p) => p.channel === FLEET_IPC.versionsChanged).at(-1)?.args[0]).toEqual(
      results
    )
    expect(JSON.stringify(payloads)).not.toContain(daemon.token)
  })

  it('a dev build reads but never asks', async () => {
    electronApp.isPackaged = false
    try {
      const { startEmbedded } = await import('@clave/server')
      const { FakeSource } = await import('@clave/server/test-support')
      const asked: unknown[] = []
      const daemon = await startEmbedded({
        ports: {
          sessions: new FakeSource(),
          serverInfo: {
            info: () => ({
              version: '3.0.0-beta.8',
              installRef: 'v3.0.0-beta.8',
              upgrade: { supported: true, state: 'idle' }
            }),
            requestUpgrade: (request) => (
              asked.push(request),
              { supported: true, state: 'running' }
            ),
            subscribe: () => () => {}
          }
        }
      })
      stops.push(() => daemon.stop())
      registerServerHandlers(registry)
      registry.save({ name: 'VPS', url: daemon.url, token: daemon.token })
      const [result] = (await invoke(FLEET_IPC.versions, true)) as Array<Record<string, unknown>>
      expect(result).toMatchObject({ kind: 'upgrade', automatic: false })
      await expect(invoke(FLEET_IPC.upgradeNow, 'server-1') as Promise<unknown>).rejects.toThrow(
        /development build/
      )
      expect(asked).toEqual([])
    } finally {
      electronApp.isPackaged = true
    }
  })
})
