import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginRecord } from '../plugins/plugin-store'
import { sessionManager } from './session-manager'
import { PluginAdapterRegistry, prefixIds, type PluginAdapterSource } from './plugin-adapters'
import type { SessionAdapter, SessionHandle } from './adapter'
import type { Session, SessionStream } from '../../shared/session-model'

/**
 * These tests drive the registered adapter through the same surface the session
 * manager uses. The plugin module is a real file on disk, because the point of
 * the boundary is that it is required from disk, and only at spawn.
 */
let roots: string[] = []
let counter = 0
const errors: unknown[][] = []
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors.length = 0
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args)
  })
})
afterEach(() => {
  spy.mockRestore()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

const DEFAULT_PROVIDER = `exports.createAdapter = (launch, emit) => ({
  start() { emit({ type: 'session_meta', model: 'm', providerSessionId: null }) },
  send(text) {
    emit({ type: 'assistant_text', delta: launch.command.join(' ') + ':' + text, final: true })
    emit({ type: 'tool_call', id: 'one', name: 'echo', input: {} })
    emit({ type: 'tool_result', id: 'one', output: text })
  },
  interrupt() {},
  respond(response) { emit({ type: 'assistant_text', delta: 'answered ' + response.id, final: true }) },
  dispose() {}
})`

interface PluginOptions {
  adapterId?: string
  entry?: string
  source?: string
  enabled?: boolean
  granted?: boolean
  digest?: string
  capabilities?: { permissions: boolean; questions: boolean; resume: boolean; notice?: string }
  command?: string[]
  pluginId?: string
}

/** A plugin on disk plus the store record the registry would read for it. */
function plugin(options: PluginOptions = {}): PluginRecord {
  const directory = mkdtempSync(join(tmpdir(), 'clave-plugin-adapter-'))
  roots.push(directory)
  const entry = options.entry ?? 'provider.cjs'
  mkdirSync(join(directory, entry, '..'), { recursive: true })
  writeFileSync(join(directory, entry), options.source ?? DEFAULT_PROVIDER)
  const adapterId = options.adapterId ?? `test-adapter-${++counter}`
  const pluginId = options.pluginId ?? `clave.test-${counter}`
  return {
    id: pluginId,
    version: '1.0.0',
    source: 'bundled',
    enabled: options.enabled ?? true,
    permissionsGranted: options.granted === false ? [] : ['sessions.write'],
    installedAt: new Date().toISOString(),
    directory,
    contentDigest: options.digest ?? 'digest-1',
    status: 'active',
    panels: [],
    commands: [],
    toolbar: [],
    generation: 0,
    manifest: {
      id: pluginId,
      name: 'Test plugin',
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '>=1.0.0' },
      ui: 'none',
      uiEntry: undefined,
      permissions: ['sessions.write'],
      contributes: {
        panels: [],
        commands: [],
        toolbar: [],
        sidebarSections: [],
        views: [],
        adapters: [
          {
            id: adapterId,
            name: `Adapter ${adapterId}`,
            entry,
            command: options.command ?? ['provider-cli', '--stdio'],
            capabilities: options.capabilities ?? {
              permissions: true,
              questions: true,
              resume: false
            }
          }
        ]
      }
    } as PluginRecord['manifest']
  }
}

const source = (...records: PluginRecord[]): PluginAdapterSource => ({ list: () => records })

function adapterOf(record: PluginRecord): SessionAdapter {
  const id = record.manifest!.contributes.adapters[0].id
  const adapter = sessionManager.getAdapter(id)
  expect(adapter).toBeDefined()
  return adapter!
}

function spec(adapterId: string, options?: unknown): Session & { options?: unknown } {
  return {
    id: `session-${++counter}`,
    provider: adapterId,
    transport: 'events',
    cwd: '/tmp/work',
    windowKey: 'w1',
    state: 'idle',
    createdAt: 1,
    adapterId,
    title: 'work',
    options
  }
}

/** Spawn and bind, in the order the session manager does it. */
async function start(
  registry: PluginAdapterRegistry,
  record: PluginRecord,
  options?: unknown
): Promise<{ adapter: SessionAdapter; handle: SessionHandle; seen: SessionStream[] }> {
  registry.sync(source(record))
  const adapter = adapterOf(record)
  const handle = await adapter.spawn(spec(adapter.id, options))
  const seen: SessionStream[] = []
  adapter.on(handle, 'stream', (stream) => seen.push(stream))
  // The manager binds its listeners, then calls readiness; so does this.
  adapter.ready?.(handle)
  return { adapter, handle, seen }
}

const events = (seen: SessionStream[]): Extract<SessionStream, { kind: 'event' }>['event'][] =>
  seen.flatMap((stream) => (stream.kind === 'event' ? [stream.event] : []))

describe('plugin adapter registry', () => {
  it('offers an enabled plugin its launch profile, with the manifest command', () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({ command: ['my-cli', '--serve'] })
    registry.sync(source(record))
    expect(registry.profiles()).toEqual([
      {
        id: record.manifest!.contributes.adapters[0].id,
        name: record.manifest!.contributes.adapters[0].name,
        command: ['my-cli', '--serve'],
        pluginId: record.id,
        enabled: true
      }
    ])
  })

  it.each([
    ['the plugin is disabled', { enabled: false }],
    ['sessions.write is not granted', { granted: false }]
  ])('keeps the profile but marks it unavailable when %s', (_why, options) => {
    const registry = new PluginAdapterRegistry()
    const record = plugin(options)
    registry.sync(source(record))
    // The profile stays resolvable so a stale launch id cannot fall back to a shell.
    expect(registry.profiles()).toHaveLength(1)
    expect(registry.profiles()[0].enabled).toBe(false)
    expect(() => registry.requireEnabled(registry.profiles()[0].id)).toThrow(/not enabled/)
  })

  it('gives a contributed adapter id to the first plugin that claims it', () => {
    const registry = new PluginAdapterRegistry()
    const id = `shared-${++counter}`
    const first = plugin({ adapterId: id, pluginId: 'clave.first' })
    const second = plugin({ adapterId: id, pluginId: 'clave.second' })
    const { conflicts } = registry.sync(source(first, second))
    expect(registry.profiles()).toHaveLength(1)
    expect(registry.profiles()[0].pluginId).toBe('clave.first')
    expect(conflicts).toEqual([
      { pluginId: 'clave.second', reason: `adapter id ${id} is already contributed by clave.first` }
    ])
    // The incumbent keeps the id across syncs, even when listed second.
    expect(registry.sync(source(second, first)).conflicts).toEqual([
      { pluginId: 'clave.second', reason: `adapter id ${id} is already contributed by clave.first` }
    ])
    expect(registry.profiles()[0].pluginId).toBe('clave.first')
    // Uninstalling it frees the id for the plugin that is still there.
    expect(registry.sync(source(second)).conflicts).toEqual([])
    expect(registry.profiles()[0].pluginId).toBe('clave.second')
  })

  it("keeps a removed plugin's id resolvable, so its launch is refused by name", async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin()
    const id = record.manifest!.contributes.adapters[0].id
    registry.sync(source(record))
    expect(registry.profiles().map((p) => p.id)).toContain(id)
    // Uninstalled. The id must still resolve to a profile, or the launcher's
    // lookup misses and the session quietly becomes a terminal instead.
    registry.sync(source())
    const profile = registry.profiles().find((p) => p.id === id)
    expect(profile).toMatchObject({ id, name: `Adapter ${id}`, enabled: false })
    expect(registry.unavailable(id)).toBe(`Adapter ${id} is no longer installed`)
    const adapter = adapterOf(record)
    await expect(adapter.spawn(spec(adapter.id))).rejects.toThrow('is no longer installed')
  })

  it('says nothing about an id it has never seen', () => {
    expect(new PluginAdapterRegistry().unavailable('never-contributed')).toBeUndefined()
  })

  it('refuses an adapter id the host reserves for its own launch profiles', () => {
    const registry = new PluginAdapterRegistry()
    const { conflicts } = registry.sync(source(plugin({ adapterId: 'dev-echo-adapter' })))
    expect(registry.profiles()).toHaveLength(0)
    expect(conflicts[0].reason).toMatch(/reserved by Clave/)
  })

  it('never evaluates the plugin module until a session starts', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `globalThis.__pluginAdapterLoads = (globalThis.__pluginAdapterLoads ?? 0) + 1\n${DEFAULT_PROVIDER}`
    })
    registry.sync(source(record))
    registry.profiles()
    expect((globalThis as Record<string, unknown>).__pluginAdapterLoads).toBeUndefined()
    await start(registry, record)
    expect((globalThis as Record<string, unknown>).__pluginAdapterLoads).toBe(1)
    delete (globalThis as Record<string, unknown>).__pluginAdapterLoads
  })

  it('replays what start() emitted once the session is ready, and prefixes plugin ids', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({ command: ['cli'] })
    const { adapter, handle, seen } = await start(registry, record)
    // session_meta was emitted inside start(), before any consumer was bound.
    expect(events(seen)).toEqual([{ type: 'session_meta', model: 'm', providerSessionId: null }])
    adapter.write(handle, { type: 'user_message', text: 'hi' })
    expect(events(seen).slice(1)).toEqual([
      { type: 'assistant_text', delta: 'cli:hi', final: true },
      { type: 'tool_call', id: `${record.id}:one`, name: 'echo', input: {} },
      { type: 'tool_result', id: `${record.id}:one`, output: 'hi' }
    ])
  })

  it('holds what start() emitted until readiness, not merely until a listener binds', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin()
    registry.sync(source(record))
    const adapter = adapterOf(record)
    const handle = await adapter.spawn(spec(adapter.id))
    const seen: SessionStream[] = []
    adapter.on(handle, 'stream', (stream) => seen.push(stream))
    // Binding is not enough: the manager publishes to the consumers it has at
    // the moment of the call, and it has none until sessions:subscribe.
    expect(seen).toEqual([])
    adapter.ready!(handle)
    expect(events(seen)).toEqual([{ type: 'session_meta', model: 'm', providerSessionId: null }])
    adapter.ready!(handle)
    expect(events(seen)).toHaveLength(1)
  })

  it('drops an event that fails the schema and keeps the session running', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = (launch, emit) => ({
        start() {},
        send() {
          emit({ type: 'assistant_text', delta: 42, final: 'yes' })
          emit({ type: 'not_a_kind', whatever: true })
          emit({ type: 'assistant_text', delta: 'survived', final: true })
        },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    expect(events(seen)).toEqual([{ type: 'assistant_text', delta: 'survived', final: true }])
    expect(errors.filter((args) => String(args[1]).length > 0)).toHaveLength(2)
  })

  it('drops a request the adapter did not declare, by kind', async () => {
    const registry = new PluginAdapterRegistry()
    const ask = (id: string, toolName?: string): string =>
      `emit({ type: 'permission_request', id: '${id}', description: 'd', ${toolName ? `toolName: '${toolName}', ` : ''}options: [{ id: 'a', label: 'A' }] });`
    const record = plugin({
      capabilities: { permissions: true, questions: false, resume: false },
      source: `exports.createAdapter = (launch, emit) => ({
        start() {}, send() { ${ask('q')} ${ask('p', 'Write')} },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    expect(events(seen).map((event) => event.type)).toEqual(['permission_request'])
    expect(events(seen)[0]).toMatchObject({ id: `${record.id}:p`, toolName: 'Write' })
    expect(errors.some((args) => String(args[0]).includes('question request'))).toBe(true)
  })

  it('strips its own prefix before the plugin sees a permission response', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin()
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, {
      type: 'permission_response',
      id: `${record.id}:ask-1`,
      optionId: 'allow'
    })
    expect(events(seen).at(-1)).toEqual({
      type: 'assistant_text',
      delta: 'answered ask-1',
      final: true
    })
  })

  it('refuses a resume the adapter does not claim, and accepts one it does', async () => {
    const registry = new PluginAdapterRegistry()
    const cannot = plugin({ capabilities: { permissions: false, questions: false, resume: false } })
    const can = plugin({ capabilities: { permissions: false, questions: false, resume: true } })
    registry.sync(source(cannot, can))
    await expect(
      adapterOf(cannot).spawn(spec(adapterOf(cannot).id, { resume: 'prev' }))
    ).rejects.toThrow(/cannot resume/)
    await expect(
      adapterOf(can).spawn(spec(adapterOf(can).id, { resume: 'prev' }))
    ).resolves.toBeDefined()
  })

  it('announces the declared notice once the session starts', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      capabilities: {
        permissions: false,
        questions: false,
        resume: false,
        notice: 'No model here.'
      }
    })
    const { seen } = await start(registry, record)
    expect(events(seen).at(-1)).toEqual({
      type: 'provider_event',
      provider: record.manifest!.contributes.adapters[0].id,
      payload: { notice: 'No model here.' }
    })
  })

  it('pins a session to the revision it started on and loads new bytes for the next', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: DEFAULT_PROVIDER.replace("'m'", "'first'")
    })
    const first = await start(registry, record)
    expect(events(first.seen)[0]).toMatchObject({ model: 'first' })
    // The plugin is edited on disk; the store re-hashes it on its next discovery.
    writeFileSync(
      join(record.directory, 'provider.cjs'),
      DEFAULT_PROVIDER.replace("'m'", "'second'")
    )
    record.contentDigest = 'digest-2'
    registry.sync(source(record))
    const second = await start(registry, record)
    expect(events(second.seen)[0]).toMatchObject({ model: 'second' })
    // The first session kept the factory it started on: its answers are unchanged.
    first.adapter.write(first.handle, { type: 'user_message', text: 'still' })
    expect(events(first.seen).at(-1)).toMatchObject({ output: 'still' })
    await expect(first.adapter.attach(first.handle.id)).rejects.toThrow(/changed since/)
  })

  it.each([
    ['exports nothing usable', 'exports.nope = 1', /must export createAdapter/],
    [
      'returns an incomplete adapter',
      'exports.createAdapter = () => ({ start() {}, send() {} })',
      /missing interrupt\(\)/
    ],
    ['returns nothing', 'exports.createAdapter = () => null', /must return an adapter/]
  ])('refuses a module that %s', async (_case, src, message) => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({ source: src })
    registry.sync(source(record))
    const adapter = adapterOf(record)
    await expect(adapter.spawn(spec(adapter.id))).rejects.toThrow(message)
  })

  it('disposes an adapter whose start() threw, and keeps no session behind', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = () => ({
        start() { throw new Error('no provider here') },
        send() {}, interrupt() {}, respond() {},
        dispose() { globalThis.__pluginDisposed = (globalThis.__pluginDisposed ?? 0) + 1 }
      })`
    })
    registry.sync(source(record))
    const adapter = adapterOf(record)
    const first = spec(adapter.id)
    await expect(adapter.spawn(first)).rejects.toThrow(/no provider here/)
    expect((globalThis as Record<string, unknown>).__pluginDisposed).toBe(1)
    delete (globalThis as Record<string, unknown>).__pluginDisposed
    // The id is free again: the failed attempt left nothing registered.
    await expect(adapter.spawn(first)).rejects.toThrow(/no provider here/)
    expect(() => adapter.write({ id: first.id }, { type: 'interrupt' })).toThrow(/Unknown/)
  })

  it('turns a plugin failure into a non-fatal session error rather than a crash', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = () => ({
        start() {}, async send() { throw new Error('provider exploded') },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(events(seen).at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('provider exploded'),
      fatal: false
    })
  })

  it('drops an event bigger than the limit and keeps the ones around it', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = (launch, emit) => ({
        start() {},
        send() {
          emit({ type: 'assistant_text', delta: 'before', final: false })
          emit({ type: 'assistant_text', delta: 'x'.repeat(300 * 1024), final: false })
          emit({ type: 'assistant_text', delta: 'after', final: true })
        },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    // Plugin code mints these and they cross into a renderer, so the oversized
    // one is dropped rather than forwarded; the turn around it is untouched.
    expect(
      events(seen).map((event) => (event.type === 'assistant_text' ? event.delta : event.type))
    ).toEqual(['before', 'after'])
    expect(errors.some((args) => String(args[0]).includes('limit 262144'))).toBe(true)
  })

  it('drops an event it cannot even measure, and keeps the one after it', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = (launch, emit) => ({
        start() {},
        send() {
          const cyclic = { name: 'loop' }
          cyclic.self = cyclic
          // tool_call.input is unknown to the schema, so the reference survives
          // validation and only the size check meets it.
          emit({ type: 'tool_call', id: 'c', name: 'x', input: cyclic })
          emit({ type: 'assistant_text', delta: 'after the circular one', final: true })
        },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    expect(events(seen).map((event) => event.type)).toEqual(['assistant_text'])
    expect(errors.some((args) => String(args[0]).includes('unmeasurable bytes'))).toBe(true)
  })

  it('accepts an event just under the limit', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `exports.createAdapter = (launch, emit) => ({
        start() {},
        send() { emit({ type: 'assistant_text', delta: 'y'.repeat(200 * 1024), final: true }) },
        interrupt() {}, respond() {}, dispose() {}
      })`
    })
    const { adapter, handle, seen } = await start(registry, record)
    adapter.write(handle, { type: 'user_message', text: 'x' })
    const [event] = events(seen)
    expect(event.type).toBe('assistant_text')
    expect(event.type === 'assistant_text' && event.delta).toHaveLength(200 * 1024)
  })

  it('refuses an adapter id a built-in adapter already holds', () => {
    const registry = new PluginAdapterRegistry()
    const builtInId = `built-in-${++counter}`
    // A future built-in, registered the way pty-manager registers its four.
    sessionManager.registerAdapter({
      id: builtInId,
      provider: 'core',
      transports: ['events'],
      spawn: async () => ({ id: 'x' }),
      attach: async () => ({ id: 'x' }),
      write: () => {},
      kill: () => {},
      on: () => () => {}
    })
    const { conflicts } = registry.sync(source(plugin({ adapterId: builtInId })))
    expect(registry.profiles()).toHaveLength(0)
    expect(conflicts[0].reason).toBe(`adapter id ${builtInId} is a built-in adapter`)
  })

  it('does no work for a plugin that emits after its session was killed', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin({
      source: `let after
      exports.createAdapter = (launch, emit) => ({
        start() { after = emit },
        send() {}, interrupt() {}, respond() {},
        dispose() { setTimeout(() => after({ type: 'nonsense' }), 0) }
      })`
    })
    const { adapter, handle } = await start(registry, record)
    await adapter.kill(handle)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The emit is refused before it is even parsed, so the invalid event it
    // carries is never logged as dropped. That log is what makes the guard
    // observable: without it, the dead session still validates the plugin's work.
    expect(errors.some((args) => String(args[0]).includes('invalid session event'))).toBe(false)
  })

  it('takes typed input only, never raw terminal bytes', async () => {
    const registry = new PluginAdapterRegistry()
    const record = plugin()
    const { adapter, handle } = await start(registry, record)
    expect(() => adapter.write(handle, new TextEncoder().encode('ls\n'))).toThrow(/raw bytes/)
  })
})

describe('prefixIds', () => {
  it.each(['tool_call', 'tool_result', 'permission_request'] as const)(
    'prefixes the correlation id of %s',
    (type) => {
      const base = {
        tool_call: { type, id: 'x', name: 'n', input: {} },
        tool_result: { type, id: 'x', output: 'o' },
        permission_request: { type, id: 'x', description: 'd', options: [] }
      }[type]
      expect(prefixIds(base as never, 'clave.p')).toMatchObject({ id: 'clave.p:x' })
    }
  )
  it('leaves an event that mints no id alone', () => {
    const event = { type: 'assistant_text', delta: 'a', final: true } as const
    expect(prefixIds(event, 'clave.p')).toBe(event)
  })
})
