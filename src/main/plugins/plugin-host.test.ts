import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginHost, type PluginServices } from './plugin-host'
import { PluginStore } from './plugin-store'

const electron = vi.hoisted(() => ({ fork: vi.fn(), channels: [] as unknown[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Port extends EventEmitter {
    postMessage = vi.fn()
    start = vi.fn()
    close = vi.fn()
  }
  return {
    utilityProcess: { fork: electron.fork },
    MessageChannelMain: class {
      port1 = new Port()
      port2 = new Port()
      constructor() {
        electron.channels.push(this)
      }
    }
  }
})
interface MockPort extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
class Child extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn(() => {
    this.emit('exit', 1)
    return true
  })
}
let temporary: string
let store: PluginStore
let host: PluginHost
let services: PluginServices
let children: Child[]
function port(index = electron.channels.length - 1): MockPort {
  return (electron.channels[index] as { port1: MockPort }).port1
}
async function request(method: string, params: unknown = {}, id = 10): Promise<void> {
  port().emit('message', { data: { jsonrpc: '2.0', id, method, params } })
  await Promise.resolve()
}
function ready(): void {
  port().emit('message', { data: { jsonrpc: '2.0', method: 'plugin.ready' } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  electron.channels.length = 0
  children = []
  electron.fork.mockReset().mockImplementation(() => {
    const child = new Child()
    children.push(child)
    return child
  })
  temporary = mkdtempSync(join(tmpdir(), 'clave-plugin-host-'))
  const bundled = join(temporary, 'bundled')
  const directory = join(bundled, 'example')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'main.cjs'), '')
  writeFileSync(
    join(directory, 'clave-plugin.json'),
    JSON.stringify({
      id: 'example.host',
      name: 'Host test',
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '^1.90.0' },
      ui: 'none',
      main: 'main.cjs',
      permissions: ['sessions.read', 'secrets'],
      contributes: {
        commands: [{ id: 'hello', title: 'Hello' }],
        toolbar: [{ id: 'hello', title: 'Hello', icon: 'SparklesIcon', kind: 'action' }]
      }
    })
  )
  // The fixture stands in for a bundled plugin the host activates on first install; the
  // real list is BUNDLED_ON_FIRST_INSTALL, and these tests are about the runtime, not it.
  store = new PluginStore(join(temporary, 'user'), bundled, '1.90.2', ['example.host'])
  store.discover()
  services = {
    sessions: { list: vi.fn(() => []), send: vi.fn(), focused: vi.fn(() => null) },
    notify: vi.fn(),
    requestSecret: vi.fn(async () => null),
    changed: vi.fn(),
    stopped: vi.fn()
  }
  host = new PluginHost(store, services, 'runner.cjs')
})
afterEach(() => {
  host.close()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(temporary, { recursive: true, force: true })
})

describe('plugin utility-process host', () => {
  it('enforces permissions at the actual message receiver, including claimed grants', async () => {
    host.startAll()
    store.get('example.host').permissionsGranted = ['sessions.read', 'secrets', 'sessions.write']
    await request('sessions.send', { id: 'session', text: 'unapproved' })
    expect(services.sessions.send).not.toHaveBeenCalled()
    expect(port().postMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32001,
        message: 'Plugin permission denied: sessions.write',
        data: { permission: 'sessions.write' }
      }
    })
    await request('sessions.list')
    expect(services.sessions.list).toHaveBeenCalledOnce()
  })
  it('records a declared toolbar registration and refuses one the manifest never declared', async () => {
    host.startAll()
    ready()
    await request('ui.registerToolbar', { id: 'hello' })
    expect(store.get('example.host').toolbar).toEqual(['hello'])
    await request('ui.registerToolbar', { id: 'smuggled' }, 11)
    expect(store.get('example.host').toolbar).toEqual(['hello'])
    expect(port().postMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 11,
      error: { code: -32001, message: 'Undeclared contribution: smuggled', data: undefined }
    })
    // A stopped plugin contributes nothing: the toolbar button goes with the process.
    host.stop('example.host')
    expect(store.get('example.host').toolbar).toEqual([])
  })
  it('pushes the focused session to a reader, once per change, and never to a plugin without the grant', () => {
    const focused = { id: 'session-1', cwd: '/repo/app', folderName: 'app', alive: true }
    services.sessions.focused = vi.fn(() => focused)
    host.startAll()
    ready()
    const pushes = (): unknown[] =>
      port()
        .postMessage.mock.calls.flat()
        .filter((m) => (m as { method?: string })?.method === 'context.changed')
    // No sessions.read: the focused session is session data and never leaves the host.
    store.get('example.host').permissionsGranted = []
    vi.advanceTimersByTime(500)
    expect(pushes()).toHaveLength(0)
    store.get('example.host').permissionsGranted = ['sessions.read']
    vi.advanceTimersByTime(500)
    expect(pushes()).toEqual([
      { jsonrpc: '2.0', method: 'context.changed', params: { session: focused } }
    ])
    // Unchanged focus is not re-announced on every tick.
    vi.advanceTimersByTime(2000)
    expect(pushes()).toHaveLength(1)
    services.sessions.focused = vi.fn(() => null)
    host.contextChanged()
    expect(pushes()).toEqual([
      { jsonrpc: '2.0', method: 'context.changed', params: { session: focused } },
      { jsonrpc: '2.0', method: 'context.changed', params: { session: null } }
    ])
  })
  it('answers sessions.focused from the services, under the sessions.read grant', async () => {
    const focused = { id: 'session-1', cwd: '/repo/app', folderName: 'app', alive: true }
    services.sessions.focused = vi.fn(() => focused)
    host.startAll()
    ready()
    store.get('example.host').permissionsGranted = []
    await request('sessions.focused', {}, 20)
    expect(port().postMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 20,
      error: {
        code: -32001,
        message: 'Plugin permission denied: sessions.read',
        data: { permission: 'sessions.read' }
      }
    })
    store.get('example.host').permissionsGranted = ['sessions.read']
    await request('sessions.focused', {}, 21)
    expect(port().postMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 21, result: focused })
  })
  it('lands a toolbar registration on the plugin that asked, and refuses a neighbour’s id', async () => {
    // Every other fixture here holds one plugin, so "the caller's record" and "some record"
    // are the same object and a registration written to the wrong one would look identical.
    const neighbour = join(temporary, 'bundled', 'neighbour')
    mkdirSync(neighbour, { recursive: true })
    writeFileSync(join(neighbour, 'main.cjs'), '')
    writeFileSync(
      join(neighbour, 'clave-plugin.json'),
      JSON.stringify({
        id: 'example.neighbour',
        name: 'Neighbour',
        version: '1.0.0',
        kind: 'plugin',
        engines: { clave: '^1.90.0' },
        ui: 'none',
        main: 'main.cjs',
        permissions: [],
        contributes: {
          commands: [{ id: 'ping', title: 'Ping' }],
          toolbar: [{ id: 'ping', title: 'Ping', icon: 'SparklesIcon', kind: 'action' }]
        }
      })
    )
    store.discover()
    store.enable('example.neighbour', [])
    host.startAll()
    expect(store.list().map((r) => r.id)).toEqual(['example.host', 'example.neighbour'])
    // The caller is the first plugin; the mutation that writes to the last record would
    // land this on the neighbour and every single-plugin assertion would still pass.
    port(0).emit('message', { data: { jsonrpc: '2.0', method: 'plugin.ready' } })
    port(0).emit('message', {
      data: { jsonrpc: '2.0', id: 30, method: 'ui.registerToolbar', params: { id: 'hello' } }
    })
    await Promise.resolve()
    expect(store.get('example.host').toolbar).toEqual(['hello'])
    expect(store.get('example.neighbour').toolbar).toEqual([])
    // A plugin cannot register an entry its neighbour declared, even though it exists.
    port(0).emit('message', {
      data: { jsonrpc: '2.0', id: 31, method: 'ui.registerToolbar', params: { id: 'ping' } }
    })
    await Promise.resolve()
    expect(port(0).postMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 31,
      error: { code: -32001, message: 'Undeclared contribution: ping', data: undefined }
    })
    expect(store.get('example.host').toolbar).toEqual(['hello'])
    expect(store.get('example.neighbour').toolbar).toEqual([])
  })
  it('refuses to run a command for a plugin the user has switched off', async () => {
    host.startAll()
    ready()
    await request('ui.registerCommand', { id: 'hello' })
    // Everything the command needs is in place: registered, active, enabled. Running it
    // here would wait on a reply this fixture never sends, so the precondition is asserted
    // on the record rather than by executing it.
    expect(store.get('example.host')).toMatchObject({
      enabled: true,
      status: 'active',
      commands: ['hello']
    })
    // The window between the user's switch and the process stopping: the record is off,
    // the process is still up, the command is still registered, and a toolbar button may
    // still be mid-click. `enabled` is the only guard that can refuse here.
    store.disable('example.host')
    await expect(host.execute('example.host', 'hello')).rejects.toThrow('Command is not active')
  })
  it('retries crashes with exponential backoff and a bounded restart count', () => {
    host.startAll()
    for (let attempt = 0; attempt < 5; attempt++) {
      children.at(-1)!.emit('exit', 1)
      expect(store.get('example.host').status).toBe('error')
      vi.advanceTimersByTime(1000 * 2 ** attempt - 1)
      expect(children).toHaveLength(attempt + 1)
      vi.advanceTimersByTime(1)
      expect(children).toHaveLength(attempt + 2)
    }
    children.at(-1)!.emit('exit', 1)
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(6)
    expect(store.get('example.host').error).toContain('restart limit reached')
  })
  it('resets the backoff budget after each successful activation', () => {
    host.startAll()
    for (let run = 0; run < 8; run++) {
      ready()
      children.at(-1)!.emit('exit', 1)
      vi.advanceTimersByTime(999)
      expect(children).toHaveLength(run + 1)
      vi.advanceTimersByTime(1)
      expect(children).toHaveLength(run + 2)
    }
  })
  it('preserves activation failure through exit and the restart ceiling, but not into a new run', () => {
    host.startAll()
    for (let attempt = 0; attempt < 6; attempt++) {
      port().emit('message', {
        data: {
          jsonrpc: '2.0',
          method: 'plugin.failed',
          params: { message: `Activation failure ${attempt}` }
        }
      })
      expect(store.get('example.host').error).toBe(`Activation failure ${attempt}`)
      vi.advanceTimersByTime(1000 * 2 ** attempt)
    }
    expect(children).toHaveLength(6)
    host.stop('example.host')
    host.start('example.host')
    ready()
    children.at(-1)!.emit('exit', 2)
    expect(store.get('example.host').error).toContain('Plugin exited (2)')
  })
  it('cancels scheduled restart when disabled', () => {
    host.startAll()
    children[0].emit('exit', 1)
    store.disable('example.host')
    host.stop('example.host')
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(1)
    expect(store.get('example.host').status).toBe('disabled')
  })
  it('rejects pending commands immediately on stop without waiting for child exit', async () => {
    host.startAll()
    ready()
    await request('ui.registerCommand', { id: 'hello' })
    const result = host.execute('example.host', 'hello')
    const rejected = expect(result).rejects.toThrow('Plugin stopped')
    host.stop('example.host')
    await rejected
    expect(children[0].kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(children[0].kill).toHaveBeenCalledOnce()
  })
  it('rejects pending commands on crash', async () => {
    host.startAll()
    ready()
    await request('ui.registerCommand', { id: 'hello' })
    const result = expect(host.execute('example.host', 'hello')).rejects.toThrow('Plugin stopped')
    children[0].emit('exit', 1)
    await result
  })
  it('does not reply with a secret after its requesting process has exited', async () => {
    let resolveSecret!: (value: string) => void
    services.requestSecret = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSecret = resolve
        })
    )
    host.startAll()
    await request('secrets.request', { title: 'Token' })
    const oldPort = port()
    children[0].emit('exit', 1)
    oldPort.postMessage.mockClear()
    resolveSecret('sensitive')
    await Promise.resolve()
    expect(oldPort.postMessage).not.toHaveBeenCalled()
  })
  it('kills a failed startup transport and permits a later clean activation', () => {
    electron.fork.mockImplementationOnce(() => {
      const child = new Child()
      child.postMessage.mockImplementation(() => {
        throw new Error('Closed startup port')
      })
      children.push(child)
      return child
    })
    host.startAll()
    expect(children[0].kill).toHaveBeenCalledOnce()
    expect(store.get('example.host').status).toBe('error')
    host.stop('example.host')
    host.start('example.host')
    expect(children).toHaveLength(2)
  })
  it('terminates a process that reports activation failure', () => {
    host.startAll()
    port().emit('message', {
      data: { jsonrpc: '2.0', method: 'plugin.failed', params: { message: 'Broken plugin' } }
    })
    expect(children[0].kill).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(children).toHaveLength(2)
  })
})
