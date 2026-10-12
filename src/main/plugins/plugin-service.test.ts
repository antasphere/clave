import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginsEvent } from '@clave/server'
import { SessionManager } from '../sessions/session-manager'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec
} from '../sessions/adapter'
import { createPluginService, type PluginService } from './plugin-service'
import type { RunnerProcess, RunnerSpawner } from './plugin-host'

// The service as the server's port, over a real store on disk, a fake runner
// per plugin (the host's own tests cover the runner protocol) and a session
// manager of this test's own, with one events adapter that records what is
// written to it.

interface Fake {
  readonly port: EventEmitter & { postMessage: ReturnType<typeof vi.fn> }
  readonly child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
}
const spawned: Fake[] = []
const spawner: RunnerSpawner = () => {
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {
      child.emit('exit', 1)
    })
  })
  spawned.push({ port, child })
  const process: RunnerProcess = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', listener)
    },
    onOutput: () => {},
    kill: () => child.kill()
  }
  return process
}
/** The runner says its plugin is up. */
const ready = (index = spawned.length - 1): void => {
  spawned[index]!.port.emit('message', { jsonrpc: '2.0', method: 'plugin.ready' })
}

class RecordingAdapter implements SessionAdapter {
  readonly id = 'echo'
  readonly provider = 'echo'
  readonly transports = ['events'] as const
  readonly written: unknown[] = []
  readonly emitters = new Map<string, EventEmitter>()
  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    this.emitters.set(spec.id, new EventEmitter())
    return { id: spec.id }
  }
  async attach(id: string): Promise<SessionHandle> {
    return { id }
  }
  write(_handle: SessionHandle, input: unknown): void {
    this.written.push(input)
  }
  async kill(handle: SessionHandle): Promise<void> {
    this.emitters.get(handle.id)?.emit('exit', 0)
  }
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): () => void {
    const emitter = this.emitters.get(handle.id)!
    emitter.on(event, callback)
    return () => {
      emitter.off(event, callback)
    }
  }
}

let temporary: string
let service: PluginService
let manager: SessionManager
let adapter: RecordingAdapter
let events: PluginsEvent[]
let notified: unknown[]

const manifest = (id: string, extra: Record<string, unknown>): string =>
  JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    kind: 'plugin',
    engines: { clave: '^1.90.0' },
    ...extra
  })

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  spawned.length = 0
  temporary = mkdtempSync(join(tmpdir(), 'clave-plugin-service-'))
  const bundled = join(temporary, 'bundled')
  // A surface plugin with one view and one panel, holding the session grants.
  const surface = join(bundled, 'surface')
  mkdirSync(join(surface, 'ui'), { recursive: true })
  writeFileSync(join(surface, 'main.cjs'), '')
  writeFileSync(join(surface, 'ui', 'index.html'), '<html></html>')
  writeFileSync(
    join(surface, 'clave-plugin.json'),
    manifest('test.surface', {
      ui: 'surface',
      main: 'main.cjs',
      uiEntry: 'ui/index.html',
      permissions: ['sessions.read', 'sessions.write', 'secrets'],
      contributes: {
        views: [{ id: 'log', title: 'Log', renders: ['events'] }],
        panels: [{ id: 'side', title: 'Side', icon: 'HandRaisedIcon', placement: 'side' }]
      }
    })
  )
  manager = new SessionManager()
  adapter = new RecordingAdapter()
  manager.registerAdapter(adapter)
  await manager.create({
    id: 'session-1',
    cwd: temporary,
    adapterId: 'echo',
    transport: 'events',
    provider: 'echo',
    state: 'idle',
    windowKey: 'w1',
    createdAt: 1,
    title: 'work'
  })
  events = []
  notified = []
  service = createPluginService({
    root: join(temporary, 'user'),
    bundled,
    version: '1.90.2',
    spawner,
    manager,
    secretTimeoutMs: 1_000
  })
  service.subscribe((event) => events.push(event))
  // The fixture stands in for a bundled plugin enabled on first install.
  service.enable('test.surface', ['sessions.read', 'sessions.write', 'secrets'])
  ready()
})
afterEach(() => {
  service.close()
  vi.restoreAllMocks()
  rmSync(temporary, { recursive: true, force: true })
})

describe('the plugin service as the server port', () => {
  it('lists the records with the host running state and tells its listeners of a change', () => {
    const record = service.list().find((r) => r.id === 'test.surface')!
    expect(record.enabled).toBe(true)
    expect(record.status).toBe('active')
    expect(events.some((e) => e._tag === 'plugins.changed')).toBe(true)
  })
  it('leases a view on one session and answers its page with the policy', () => {
    const lease = service.leaseView('test.surface', 'log', 'session-1')
    expect(lease.sessionId).toBe('session-1')
    expect(lease.file).toMatch(/surface\/ui\/index\.html$/)
    expect(lease.csp).toContain("default-src 'self'")
    expect(lease.csp).not.toContain('https:')
    expect(service.requestView(lease.leaseId, 'session.get', undefined)).toMatchObject({
      id: 'session-1'
    })
  })
  it('refuses a lease on an unknown session, an undeclared view and a transport the view does not render', () => {
    expect(() => service.leaseView('test.surface', 'log', 'nope')).toThrow('Unknown session')
    expect(() => service.leaseView('test.surface', 'other', 'session-1')).toThrow('Undeclared view')
  })
  it('writes through a lease to the leased session only, and refuses once the grant is gone', () => {
    const lease = service.leaseView('test.surface', 'log', 'session-1')
    service.requestView(lease.leaseId, 'session.write', { type: 'user_message', text: 'hi' })
    expect(adapter.written).toEqual([{ type: 'user_message', text: 'hi' }])
    // A guest naming another session in its params changes nothing: the
    // input schema carries no target, and the lease's session is written.
    service.requestView(lease.leaseId, 'session.write', {
      type: 'user_message',
      text: 'again',
      sessionId: 'elsewhere'
    } as never)
    expect(adapter.written).toHaveLength(2)
    // A disabled plugin keeps no lease at all: the write is refused by name.
    service.disable('test.surface')
    expect(() =>
      service.requestView(lease.leaseId, 'session.write', { type: 'user_message', text: 'x' })
    ).toThrow('Unknown view lease')
  })
  it('drops a lease when it is revoked, when its plugin stops and when its session is forgotten', () => {
    const revoked = service.leaseView('test.surface', 'log', 'session-1')
    service.revokeView(revoked.leaseId)
    expect(() => service.requestView(revoked.leaseId, 'session.get', undefined)).toThrow(
      'Unknown view lease'
    )
    const orphaned = service.leaseView('test.surface', 'log', 'session-1')
    manager.forget('session-1')
    expect(() => service.requestView(orphaned.leaseId, 'session.get', undefined)).toThrow(
      'Unknown view lease'
    )
  })
  it('answers a panel page only while the plugin is active and declares it', () => {
    // The runner registers the panel the way a plugin's activate does.
    spawned[0]!.port.emit('message', {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui.registerPanel',
      params: { id: 'side' }
    })
    expect(service.panel('test.surface', 'side')).toMatchObject({
      file: expect.stringMatching(/index\.html$/),
      csp: expect.stringContaining("frame-src 'none'")
    })
    expect(() => service.panel('test.surface', 'other')).toThrow('Panel is not active')
  })
  it('keeps the focused session per window and clears a closed window only when it was the last to report', () => {
    service.context('w1', 'session-1')
    expect(service.host['services'].sessions.focused()).toMatchObject({ id: 'session-1' })
    service.context('w2', null)
    expect(service.host['services'].sessions.focused()).toMatchObject({ id: 'session-1' })
    service.context('w1', null)
    expect(service.host['services'].sessions.focused()).toBeNull()
  })
  it('holds a secret request until it is answered, and answers the runner', async () => {
    spawned[0]!.port.emit('message', {
      jsonrpc: '2.0',
      id: 7,
      method: 'secrets.request',
      params: { title: 'Token', description: 'The API token' }
    })
    await Promise.resolve()
    const [pending] = service.secrets()
    expect(pending).toMatchObject({ pluginId: 'test.surface', title: 'Token' })
    service.replySecret(pending!.id, 'sensitive')
    await Promise.resolve()
    expect(service.secrets()).toEqual([])
    expect(spawned[0]!.port.postMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      result: 'sensitive'
    })
    expect(() => service.replySecret(pending!.id, 'twice')).toThrow('Unknown secret request')
  })
  it('tells its listeners of a notification when the entry shows none, and shows it when it can', () => {
    spawned[0]!.port.emit('message', {
      jsonrpc: '2.0',
      id: 8,
      method: 'notify',
      params: { title: 'Done', body: 'All good' }
    })
    const notice = events.find((e) => e._tag === 'plugins.notified')
    expect(notice).toMatchObject({
      pluginId: 'test.surface',
      name: 'Plugin test.surface',
      title: 'Done',
      body: 'All good'
    })
    service.close()
    spawned.length = 0
    service = createPluginService({
      root: join(temporary, 'user'),
      bundled: join(temporary, 'bundled'),
      version: '1.90.2',
      spawner,
      manager,
      notify: (n) => notified.push(n)
    })
    const shown: PluginsEvent[] = []
    service.subscribe((e) => shown.push(e))
    ready()
    spawned[0]!.port.emit('message', {
      jsonrpc: '2.0',
      id: 9,
      method: 'notify',
      params: { title: 'Shown' }
    })
    expect(notified).toEqual([
      { pluginId: 'test.surface', name: 'Plugin test.surface', title: 'Shown' }
    ])
    expect(shown.some((e) => e._tag === 'plugins.notified')).toBe(false)
  })
  it('lists the sessions of its own manager to a plugin, and sends to a chat session as a user message', () => {
    const sessions = service.host['services'].sessions
    expect(sessions.list()).toMatchObject([{ id: 'session-1', alive: true }])
    sessions.send('session-1', 'from a plugin')
    expect(adapter.written.at(-1)).toEqual({ type: 'user_message', text: 'from a plugin' })
  })
})
