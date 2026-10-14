import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { RequestPluginView } from '@clave/contract/plugins'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { pluginHandlers } from './handlers'
import {
  Plugins,
  type PluginPage,
  type PluginPermission,
  type PluginRecord,
  type PluginSecretRequest,
  type PluginViewLease,
  type PluginsEvent,
  type PluginsService
} from './port'
import type { Unsubscribe } from '../sessions/port'

/**
 * The plugins domain (wave 5, lane C, PRDCT-3433), through the HTTP API and
 * the push channel over a fake port: each call reaches the port with what it
 * was sent, a plain `Error` is the declared `PluginRefused`, a
 * `CapabilityUnavailable` is that failure, anything else a defect, and the
 * port's news reaches a client as a server event.
 */
const aPlugin = (id: string): PluginRecord => ({
  id,
  version: '1.0.0',
  source: 'link',
  enabled: false,
  permissionsGranted: [],
  installedAt: '2026-10-12T00:00:00.000Z',
  directory: `/plugins/${id}`,
  status: 'disabled',
  panels: ['main'],
  commands: ['hello'],
  toolbar: [],
  generation: 0
})

/** A port the test reads and drives: every call recorded, `refuse` thrown
 *  by the next call that is not a read of the records. */
class FakePlugins implements PluginsService {
  readonly records: PluginRecord[] = [aPlugin('clave.demo')]
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  readonly listeners = new Set<(event: PluginsEvent) => void>()
  /** What `requestView` answers. */
  answer: unknown = { ok: true }
  /** Thrown by the next call of any method but `list` and `subscribe`. */
  refuse: unknown = null

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
    const refusal = this.refuse
    if (refusal !== null) {
      this.refuse = null
      throw refusal
    }
  }
  list = (): ReadonlyArray<PluginRecord> => {
    const refusal = this.refuse
    if (refusal !== null) {
      this.refuse = null
      throw refusal
    }
    return this.records
  }
  enable = (id: string, grants: ReadonlyArray<PluginPermission>): void =>
    this.record('enable', id, grants)
  disable = (id: string): void => this.record('disable', id)
  link = (folder: string): string => {
    this.record('link', folder)
    return `linked.${folder.split('/').pop() ?? ''}`
  }
  remove = (id: string): void => this.record('remove', id)
  command = async (id: string, command: string): Promise<void> =>
    this.record('command', id, command)
  panel = (pluginId: string, panelId: string): PluginPage => {
    this.record('panel', pluginId, panelId)
    return { file: `/plugins/${pluginId}/${panelId}.html`, csp: "default-src 'self'" }
  }
  context = (windowKey: string, sessionId: string | null): void =>
    this.record('context', windowKey, sessionId)
  leaseView = (pluginId: string, viewId: string, sessionId: string): PluginViewLease => {
    this.record('leaseView', pluginId, viewId, sessionId)
    return { leaseId: 'lease-1', sessionId, file: `/plugins/${pluginId}/${viewId}.html`, csp: '' }
  }
  requestView = async (leaseId: string, method: string, params: unknown): Promise<unknown> => {
    this.record('requestView', leaseId, method, params)
    return this.answer
  }
  revokeView = (leaseId: string): void => this.record('revokeView', leaseId)
  secrets = (): ReadonlyArray<PluginSecretRequest> => {
    this.record('secrets')
    return [{ id: 'sec-1', pluginId: 'clave.demo', title: 'API key' }]
  }
  replySecret = (id: string, value: string | null): void => this.record('replySecret', id, value)
  subscribe = (listener: (event: PluginsEvent) => void): Unsubscribe => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(event: PluginsEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

let server: EmbeddedServer
let fake: FakePlugins

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const get = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: headers(server.token) })
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })
const welcomed = async (): Promise<Peer> => {
  const peer = new Peer(server.url.replace('http', 'ws') + '/push')
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome', serverId: server.serverId })
  return peer
}

beforeEach(async () => {
  fake = new FakePlugins()
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), plugins: fake },
    helloTimeoutMs: 200
  })
})
afterEach(async () => {
  await server.stop()
})

describe('the plugins group of the HTTP API', () => {
  it('lists the records the port holds', async () => {
    const response = await get('/plugins')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(fake.records)
  })

  it('hands an enable its id and grants, and answers no content', async () => {
    const response = await post('/plugins/enable', {
      id: 'clave.demo',
      grants: ['sessions.read', 'net']
    })
    expect(response.status).toBe(204)
    expect(fake.calls).toEqual([
      { method: 'enable', args: ['clave.demo', ['sessions.read', 'net']] }
    ])
  })

  it('answers the store’s plain refusal as the declared PluginRefused', async () => {
    fake.refuse = new Error('All declared permissions must be granted before enabling')
    const response = await post('/plugins/enable', { id: 'clave.demo', grants: [] })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'PluginRefused',
      message: 'All declared permissions must be granted before enabling'
    })
  })

  it('answers a CapabilityUnavailable the port throws as that failure', async () => {
    fake.refuse = new CapabilityUnavailable({
      capability: 'plugins',
      message: 'No plugin host on this server'
    })
    const response = await post('/plugins/disable', { id: 'clave.demo' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'plugins',
      message: 'No plugin host on this server'
    })
  })

  it('takes an error that is not a plain Error as a defect, never a refusal', async () => {
    fake.refuse = new TypeError('records is not iterable')
    expect((await post('/plugins/remove', { id: 'clave.demo' })).status).toBe(500)
  })

  it('answers the list with the registry’s own sentence when it could not be read', async () => {
    // The entry that could not read installed.json runs a refusing service:
    // the person reads why in Settings instead of an empty list or a 500.
    fake.refuse = new Error('Plugin registry could not be read: ZodError')
    const response = await get('/plugins')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'PluginRefused',
      message: 'Plugin registry could not be read: ZodError'
    })
  })

  it('answers a link with the id the port gave', async () => {
    const response = await post('/plugins/link', { folder: '/Users/me/my-plugin' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'linked.my-plugin' })
    expect(fake.calls).toEqual([{ method: 'link', args: ['/Users/me/my-plugin'] }])
  })

  it('answers a panel with its page, and the declared refusal for an unknown one', async () => {
    const response = await get('/plugins/panel?pluginId=clave.demo&panelId=main')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      file: '/plugins/clave.demo/main.html',
      csp: "default-src 'self'"
    })
    fake.refuse = new Error('Unknown panel: nope')
    const refused = await get('/plugins/panel?pluginId=clave.demo&panelId=nope')
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      _tag: 'PluginRefused',
      message: 'Unknown panel: nope'
    })
  })

  it('carries a view request’s answer, and no result key when the plugin answered none', async () => {
    const lease = await post('/plugins/views/lease', {
      pluginId: 'clave.demo',
      viewId: 'chat',
      sessionId: 's1'
    })
    expect(lease.status).toBe(200)
    expect(await lease.json()).toMatchObject({ leaseId: 'lease-1', sessionId: 's1' })

    fake.answer = { items: [1, 2] }
    const answered = await post('/plugins/views/request', {
      leaseId: 'lease-1',
      method: 'items',
      params: { page: 2 }
    })
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ result: { items: [1, 2] } })
    expect(fake.calls.at(-1)).toEqual({
      method: 'requestView',
      args: ['lease-1', 'items', { page: 2 }]
    })

    fake.answer = undefined
    const empty = await post('/plugins/views/request', { leaseId: 'lease-1', method: 'ping' })
    expect(empty.status).toBe(200)
    const body = (await empty.json()) as Record<string, unknown>
    expect(body).toEqual({})
    expect('result' in body).toBe(false)
  })

  it('reaches the port for the context, a command, a revoke and a secret reply', async () => {
    expect((await post('/plugins/context', { windowKey: 'w1', sessionId: null })).status).toBe(204)
    expect((await post('/plugins/command', { id: 'clave.demo', command: 'hello' })).status).toBe(
      204
    )
    expect((await post('/plugins/views/revoke', { leaseId: 'lease-1' })).status).toBe(204)
    expect((await post('/plugins/secrets/reply', { id: 'sec-1', value: null })).status).toBe(204)
    expect(fake.calls).toEqual([
      { method: 'context', args: ['w1', null] },
      { method: 'command', args: ['clave.demo', 'hello'] },
      { method: 'revokeView', args: ['lease-1'] },
      { method: 'replySecret', args: ['sec-1', null] }
    ])
    const secrets = await get('/plugins/secrets')
    expect(secrets.status).toBe(200)
    expect(await secrets.json()).toEqual([
      { id: 'sec-1', pluginId: 'clave.demo', title: 'API key' }
    ])
  })
})

describe('the plugins handlers on the buses', () => {
  it('answers a view request the plugin answered nothing to with no result key at all', async () => {
    // JSON drops an undefined key, so only the bus can tell `{}` from
    // `{ result: undefined }`.
    const plugins = new FakePlugins()
    plugins.answer = undefined
    const buses = busesLayer.pipe(
      Layer.provide(HandlerRegistry.layer(...pluginHandlers)),
      Layer.provide(Plugins.layer(plugins))
    )
    const answer = await Effect.runPromise(
      Effect.flatMap(CommandBus, (bus) =>
        bus.dispatch(RequestPluginView, { leaseId: 'lease-1', method: 'ping' })
      ).pipe(Effect.provide(buses))
    )
    expect(answer).toEqual({})
    expect(Object.keys(answer)).toEqual([])
  })
})

describe('the plugins events on the push channel', () => {
  it('republishes plugins.changed and plugins.notified as server events', async () => {
    const peer = await welcomed()
    fake.emit({ _tag: 'plugins.changed' })
    expect(await peer.next()).toMatchObject({
      _tag: 'event',
      event: { _tag: 'plugins.changed' }
    })
    fake.emit({
      _tag: 'plugins.notified',
      pluginId: 'clave.demo',
      name: 'Demo',
      title: 'Build finished',
      body: 'All green'
    })
    expect(await peer.next()).toMatchObject({
      _tag: 'event',
      event: {
        _tag: 'plugins.notified',
        pluginId: 'clave.demo',
        name: 'Demo',
        title: 'Build finished',
        body: 'All green'
      }
    })
    peer.ws.close()
  })

  it('holds one subscription while the server runs and releases it on stop', async () => {
    expect(fake.listeners.size).toBe(1)
    await server.stop()
    expect(fake.listeners.size).toBe(0)
    // afterEach stops it again; restart one so that stays harmless.
    server = await startEmbedded({ ports: { sessions: new FakeSource(), plugins: fake } })
  })
})

describe('a server with no plugins behind it', () => {
  it('answers CapabilityUnavailable, never an empty list', async () => {
    await server.stop()
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    for (const response of [
      await get('/plugins'),
      await post('/plugins/enable', { id: 'clave.demo', grants: [] }),
      await post('/plugins/command', { id: 'clave.demo', command: 'hello' })
    ]) {
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'plugins',
        message: 'This server runs no plugins: the entry gave it no plugin store.'
      })
    }
  })
})
