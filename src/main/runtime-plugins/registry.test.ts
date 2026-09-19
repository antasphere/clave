import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimePluginRegistry } from './registry'
import { validateManifest } from './manifest'
import { createPluginAdapterFactory, normalizeProviderEvent } from './providers'
import type { RuntimePluginManifest } from '../../shared/runtime-plugins'

const roots: string[] = []
function fixture(): {
  root: string
  source: string
  manifest: RuntimePluginManifest & Required<Pick<RuntimePluginManifest, 'provider'>>
  registry: RuntimePluginRegistry
} {
  const root = mkdtempSync(join(tmpdir(), 'clave-plugin-test-'))
  roots.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  const manifest: RuntimePluginManifest & Required<Pick<RuntimePluginManifest, 'provider'>> = {
    apiVersion: 1,
    id: 'test.fake',
    name: 'Fake',
    version: '1.0.0',
    provider: {
      id: 'test.fake.provider',
      name: 'Fake',
      entry: 'provider.cjs',
      command: ['fake'],
      capabilities: { permissions: false, questions: false, resume: true }
    },
    views: [
      {
        id: 'test.view',
        name: 'View',
        entry: 'view.html',
        capabilities: [],
        mimeTypes: ['text/html']
      }
    ]
  }
  writeFileSync(join(source, 'clave-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(source, 'provider.cjs'), 'throw new Error("must not execute during install")')
  writeFileSync(join(source, 'view.html'), '<p>old</p>')
  return { root, source, manifest, registry: new RuntimePluginRegistry(root) }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runtime plugin installation', () => {
  it('namespaces view IDs by plugin instead of reserving them globally', () => {
    const first = fixture()
    const second = fixture()
    second.manifest.id = 'test.another'
    second.manifest.provider.id = 'test.another.provider'
    writeFileSync(join(second.source, 'clave-plugin.json'), JSON.stringify(second.manifest))
    first.registry.installPrepared(first.registry.inspectFolder(first.source))
    first.registry.installPrepared(first.registry.inspectFolder(second.source))
    const pins = first.registry
      .providers()
      .filter((provider) => provider.id.startsWith('test.'))
      .map((provider) => provider.plugin)
    expect(
      first.registry.viewsFor(pins, {
        kind: 'artifact',
        id: 'report',
        title: 'Report',
        mimeType: 'text/html',
        content: 'report',
        fallback: 'report'
      })
    ).toHaveLength(2)
  })

  it('rejects unsupported API versions, unknown keys, unsafe paths and reserved IDs', () => {
    const { manifest } = fixture()
    for (const patch of [
      { apiVersion: 2 },
      { unexpected: true },
      { id: 'builtin.claude' },
      { provider: { ...manifest.provider, id: 'claude' } },
      ...['../evil.cjs', '/evil.cjs', 'a\\evil.cjs', 'a/../evil.cjs'].map((entry) => ({
        provider: { ...manifest.provider, entry }
      }))
    ])
      expect(() => validateManifest({ ...manifest, ...patch })).toThrow()
  })
  it('rejects symlinks and private/package-manager files', () => {
    const { source, registry } = fixture()
    symlinkSync('view.html', join(source, 'alias.html'))
    expect(() => registry.inspectFolder(source)).toThrow()
    rmSync(join(source, 'alias.html'))
    writeFileSync(join(source, '.env'), 'secret')
    expect(() => registry.inspectFolder(source)).toThrow()
  })
  it('installs previewed bytes, pins old revisions across updates and denies disabled new bindings', () => {
    const { source, registry } = fixture()
    const prepared = registry.inspectFolder(source)
    writeFileSync(join(source, 'view.html'), '<p>new</p>')
    registry.installPrepared(prepared)
    const old = registry.bindingsFor('test.fake.provider')
    expect(old.views).toEqual([])
    expect(registry.readView(old.provider, 'test.view')).toBe('<p>old</p>')
    registry.installPrepared(registry.prepareUpdate('test.fake'))
    const current = registry.bindingsFor('test.fake.provider')
    expect(current.provider.revision).not.toBe(old.provider.revision)
    expect(registry.readView(old.provider, 'test.view')).toBe('<p>old</p>')
    expect(registry.readView(current.provider, 'test.view')).toBe('<p>new</p>')
    registry.setEnabled('test.fake', false)
    expect(() => registry.bindingsFor('test.fake.provider')).toThrow()
    expect(registry.resolveProvider('test.fake.provider', old.provider).descriptor.plugin).toEqual(
      old.provider
    )
    expect(() => registry.readView(old.provider, 'test.view')).toThrow()
    expect(() =>
      registry.resolveProvider('test.fake.provider', { ...old.provider, revision: 'a'.repeat(64) })
    ).toThrow()
  })
  it('uses the registry factory for builtins and rejects unavailable builtin revisions', () => {
    const { registry } = fixture()
    const bindings = registry.bindingsFor('claude')
    const adapter = createPluginAdapterFactory(registry)(
      {
        command: ['never-run'],
        additionalArgs: [],
        env: {},
        sessionDirectory: '/tmp',
        options: { provider: 'claude', cwd: '/tmp', pluginBindings: bindings }
      },
      () => {}
    )
    expect(adapter.capabilities.permissions).toBe(true)
    expect(() =>
      registry.resolveProvider('claude', { ...bindings.provider, revision: 'old' })
    ).toThrow()
  })

  it('rejects oversized packages, missing entries, collisions and forged previews', () => {
    const { source, registry, manifest } = fixture()
    const prepared = registry.inspectFolder(source)
    expect(() => registry.installPrepared({ ...prepared })).toThrow()
    registry.installPrepared(prepared)
    expect(() => registry.installPrepared(prepared)).toThrow()
    writeFileSync(join(source, 'clave-plugin.json'), JSON.stringify({ ...manifest, id: 'another' }))
    expect(() => registry.inspectFolder(source)).toThrow(/already installed/)
    writeFileSync(join(source, 'clave-plugin.json'), JSON.stringify(manifest))
    rmSync(join(source, 'provider.cjs'))
    expect(() => registry.inspectFolder(source)).toThrow(/Missing plugin entry/)
    writeFileSync(join(source, 'provider.cjs'), Buffer.alloc(16 * 1024 * 1024 + 1))
    expect(() => registry.inspectFolder(source)).toThrow(/size limits/)
  })

  it('reloads updates in another registry and rejects corrupted stored revisions', () => {
    const { root, source, registry } = fixture()
    const other = new RuntimePluginRegistry(root)
    registry.installPrepared(registry.inspectFolder(source))
    const binding = other.bindingsFor('test.fake.provider').provider
    expect(other.readView(binding, 'test.view')).toBe('<p>old</p>')
    registry.setEnabled('test.fake', false)
    expect(other.providers().some((provider) => provider.id === 'test.fake.provider')).toBe(false)
    rmSync(join(root, 'runtime-plugins', 'revisions', binding.revision, 'view.html'))
    expect(() => other.resolveProvider('test.fake.provider', binding)).toThrow()
  })

  it('loads native modules only at start and rejects forged events before core state', async () => {
    const { root, source, registry } = fixture()
    const marker = join(root, 'loaded')
    writeFileSync(
      join(source, 'provider.cjs'),
      `
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')
      exports.createAdapter = (launch, emit) => ({
        capabilities: { permissions: false, questions: false, resume: true },
        async start() {
          emit({ type: 'message', message: { kind: 'message', id: 'a', role: 'user', text: 'forged' } })
          emit({ type: 'message', message: { kind: 'message', id: 'a', role: 'assistant', text: 'safe' } })
        },
        async send() {}, async interrupt() {}, async respond() {}, async dispose() {}
      })
    `
    )
    registry.installPrepared(registry.inspectFolder(source))
    registry.list()
    const events: unknown[] = []
    const adapter = createPluginAdapterFactory(registry)(
      {
        command: ['fake'],
        additionalArgs: [],
        env: {},
        sessionDirectory: root,
        options: {
          provider: 'test.fake.provider',
          cwd: root,
          pluginBindings: registry.bindingsFor('test.fake.provider')
        }
      },
      (event) => events.push(event)
    )
    expect(() => readFileSync(marker)).toThrow()
    await adapter.start()
    expect(readFileSync(marker, 'utf8')).toBe('yes')
    expect(events).toEqual([
      { type: 'status', status: 'error', error: 'Plugin emitted an invalid conversation event' },
      {
        type: 'message',
        message: { kind: 'message', id: 'plugin:a', role: 'assistant', text: 'safe' }
      }
    ])
    await adapter.dispose()
  })

  it('validates exported factories, adapter methods and capabilities', async () => {
    const { root, source, registry } = fixture()
    for (const code of [
      'exports.noFactory = true',
      'exports.createAdapter = () => ({ capabilities: {} })',
      `exports.createAdapter = () => ({
        capabilities: { permissions: true, questions: false, resume: true },
        async start() {}, async send() {}, async interrupt() {}, async respond() {}, async dispose() {}
      })`
    ]) {
      writeFileSync(join(source, 'provider.cjs'), code)
      registry.installPrepared(registry.inspectFolder(source))
      const adapter = createPluginAdapterFactory(registry)(
        {
          command: ['fake'],
          additionalArgs: [],
          env: {},
          sessionDirectory: root,
          options: {
            provider: 'test.fake.provider',
            cwd: root,
            pluginBindings: registry.bindingsFor('test.fake.provider')
          }
        },
        () => {}
      )
      await expect(adapter.start()).rejects.toThrow()
      await adapter.dispose()
    }
  })
})

describe('provider event boundary', () => {
  it('rejects malformed envelopes and user impersonation; namespaces entry IDs', () => {
    expect(() =>
      normalizeProviderEvent({
        type: 'message',
        message: {
          kind: 'message',
          id: 'user-id',
          role: 'user',
          text: 'forged'
        }
      })
    ).toThrow()
    expect(() => normalizeProviderEvent({ type: 'status', status: 'invented' })).toThrow()
    expect(() => normalizeProviderEvent({ type: 'text-delta', messageId: 'a', text: 1 })).toThrow()
    expect(normalizeProviderEvent({ type: 'text-delta', messageId: 'a', text: 'safe' })).toEqual({
      type: 'text-delta',
      messageId: 'plugin:a',
      text: 'safe'
    })
    expect(
      normalizeProviderEvent({
        type: 'artifact',
        artifact: {
          kind: 'artifact',
          id: 'a',
          title: 'Artifact',
          mimeType: 'text/html',
          content: '<p>safe</p>',
          fallback: 'safe'
        }
      })
    ).toMatchObject({ type: 'artifact', artifact: { id: 'plugin:a' } })
  })
})
