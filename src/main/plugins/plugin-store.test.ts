import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginStore, pluginFile, BUNDLED_ON_FIRST_INSTALL } from './plugin-store'
import type { PluginManifestInput } from '@clave/plugin-sdk'

let temporary: string
let root: string
let bundled: string
const manifest = (id = 'example.plugin'): PluginManifestInput => ({
  id,
  name: 'Example',
  version: '1.0.0',
  kind: 'plugin',
  engines: { clave: '^1.90.0' },
  ui: 'none',
  permissions: ['sessions.read']
})
function writePlugin(directory: string, value = manifest()): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'clave-plugin.json'), JSON.stringify(value))
}
function store(): PluginStore {
  return new PluginStore(root, bundled, '1.90.2')
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'clave-plugin-store-'))
  root = join(temporary, 'user')
  bundled = join(temporary, 'bundled')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(temporary, { recursive: true, force: true })
})

describe('plugin discovery and persisted grants', () => {
  it('round-trips installed state, enabled preference, grants and installation time', () => {
    const initial = store()
    writePlugin(join(root, 'plugins', 'example'), manifest())
    const [discovered] = initial.discover()
    expect(discovered).toMatchObject({ enabled: false, source: 'git', permissionsGranted: [] })
    expect(() => initial.enable(discovered.id, [])).toThrow('All declared permissions')
    initial.enable(discovered.id, ['sessions.read', 'shell'])
    const second = store()
    second.discover()
    expect(second.get(discovered.id)).toMatchObject({
      enabled: true,
      permissionsGranted: ['sessions.read'],
      installedAt: discovered.installedAt
    })
    second.disable(discovered.id)
    const third = store()
    third.discover()
    expect(third.get(discovered.id).enabled).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))).toEqual([
      {
        id: discovered.id,
        version: '1.0.0',
        source: 'git',
        enabled: false,
        permissionsGranted: ['sessions.read'],
        installedAt: discovered.installedAt,
        directory: discovered.directory,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        declaredPermissions: ['sessions.read']
      }
    ])
  })
  it('surfaces and logs incompatible engines and refuses enable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    writePlugin(join(bundled, 'future'), { ...manifest(), engines: { clave: '>=2' } })
    const instance = store()
    const [record] = instance.discover()
    expect(record).toMatchObject({ status: 'error', error: 'Requires Clave >=2; running 1.90.2' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Requires Clave >=2'))
    expect(() => instance.enable(record.id, ['sessions.read'])).toThrow('Requires Clave')
  })
  it('protects bundled plugins from duplicate IDs and removal', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writePlugin(join(bundled, 'example'))
    writePlugin(join(root, 'plugins', 'override'), { ...manifest(), name: 'Override' })
    const instance = store()
    const records = instance.discover()
    expect(instance.get('example.plugin')).toMatchObject({
      source: 'bundled',
      manifest: { name: 'Example' }
    })
    expect(records).toHaveLength(2)
    expect(records.find((record) => record.status === 'error')?.error).toContain(
      'Duplicate plugin id'
    )
    expect(() => instance.remove('example.plugin')).toThrow('Bundled plugins')
    expect(() => instance.link(join(root, 'plugins', 'override'))).toThrow('already installed')
  })
  it('links and removes only the symlink, preserving the developer source', () => {
    const target = join(temporary, 'source')
    writePlugin(target)
    const instance = store()
    instance.discover()
    const id = instance.link(target)
    instance.discover()
    expect(instance.get(id).source).toBe('link')
    instance.remove(id)
    expect(existsSync(join(root, 'plugins', id))).toBe(false)
    expect(existsSync(join(target, 'clave-plugin.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))).toEqual([])
  })
  it('rejects corrupt persisted grants instead of silently granting or enabling', () => {
    store()
    writeFileSync(
      join(root, 'installed.json'),
      JSON.stringify([{ ...manifest(), permissionsGranted: ['everything'] }])
    )
    expect(() => store()).toThrow()
  })
  it('rejects a bundle entry symlink that escapes the plugin root', () => {
    const pluginRoot = join(temporary, 'source')
    writePlugin(pluginRoot)
    const outside = join(temporary, 'outside.cjs')
    writeFileSync(outside, '')
    symlinkSync(outside, join(pluginRoot, 'main.cjs'))
    expect(() => pluginFile(pluginRoot, 'main.cjs')).toThrow('Path leaves plugin directory')
  })
})

it('activates only the bundled plugins the host lists, and grants nothing to the others', () => {
  writePlugin(join(bundled, 'feature'), manifest('clave.chat-view'))
  writePlugin(join(bundled, 'demo'), manifest('clave.hello'))
  const instance = new PluginStore(root, bundled, '1.90.2')
  instance.discover()
  // A plugin that IS a feature of the app runs on first install, with its declared
  // permissions granted; a bundled demo waits for the user, and holds no grant until then.
  expect(instance.get('clave.chat-view')).toMatchObject({
    enabled: true,
    permissionsGranted: ['sessions.read']
  })
  expect(instance.get('clave.hello')).toMatchObject({
    enabled: false,
    permissionsGranted: [],
    status: 'disabled'
  })
  expect(BUNDLED_ON_FIRST_INSTALL).toEqual(['clave.chat-view', 'clave.github'])
})

it('keeps declaration and grants independent for bundled plugins', () => {
  writePlugin(join(bundled, 'example'))
  const instance = new PluginStore(root, bundled, '1.90.2', ['example.plugin'])
  instance.discover()
  const record = instance.get('example.plugin')
  record.permissionsGranted.push('sessions.write')
  expect(record.manifest?.permissions).toEqual(['sessions.read'])
})

it('removes copied installations from the managed folder', () => {
  const instance = store()
  writePlugin(join(root, 'plugins', 'example'))
  instance.discover()
  instance.remove('example.plugin')
  expect(existsSync(join(root, 'plugins', 'example'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))).toEqual([])
})

it.each([false, true])(
  'requires review when a folder is replaced under the same id (missing discovery: %s)',
  (discoverMissing) => {
    const initial = store()
    const directory = join(root, 'plugins', 'original')
    writePlugin(directory)
    initial.discover()
    initial.enable('example.plugin', ['sessions.read'])
    rmSync(directory, { recursive: true })
    if (discoverMissing) {
      initial.discover()
      expect(JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))).toEqual([])
    }
    writePlugin(join(root, 'plugins', 'replacement'), {
      ...manifest(),
      name: 'Replacement',
      version: '2.0.0'
    })
    const restarted = store()
    restarted.discover()
    expect(restarted.get('example.plugin')).toMatchObject({
      manifest: { name: 'Replacement' },
      version: '2.0.0',
      enabled: false,
      permissionsGranted: discoverMissing ? [] : ['sessions.read']
    })
  }
)

describe('consent across content and declaration changes', () => {
  function fixture(source: 'git' | 'bundled' | 'link'): {
    instance: PluginStore
    directory: string
    value: PluginManifestInput
  } {
    const instance = store()
    const directory =
      source === 'bundled'
        ? join(bundled, 'example')
        : source === 'link'
          ? join(temporary, 'source')
          : join(root, 'plugins', 'example')
    const value = { ...manifest(), main: 'main.mjs' }
    writePlugin(directory, value)
    writeFileSync(join(directory, 'main.mjs'), 'export default {}')
    if (source === 'link') instance.link(directory)
    instance.discover()
    instance.enable(value.id, value.permissions!)
    return { instance, directory, value }
  }
  it('detects a same-id same-version replacement while closed and retains unapplied grants', () => {
    const { directory } = fixture('git')
    writeFileSync(join(directory, 'main.mjs'), 'export default { replaced: true }')
    const restarted = store()
    restarted.discover()
    expect(restarted.get('example.plugin')).toMatchObject({
      enabled: false,
      needsReview: 'digest-change',
      permissionsGranted: ['sessions.read']
    })
    const again = store()
    again.discover()
    expect(again.get('example.plugin').needsReview).toBe('digest-change')
    again.enable('example.plugin', ['sessions.read'])
    expect(again.get('example.plugin').needsReview).toBeUndefined()
  })
  it.each(['git', 'bundled', 'link'] as const)('keeps consent on a %s version bump', (source) => {
    const { directory, value } = fixture(source)
    writePlugin(directory, { ...value, version: '2.0.0' })
    const restarted = store()
    restarted.discover()
    expect(restarted.get(value.id)).toMatchObject({
      enabled: true,
      permissionsGranted: ['sessions.read']
    })
    expect(restarted.get(value.id).needsReview).toBeUndefined()
  })
  it.each(['bundled', 'link'] as const)('keeps consent on a %s code edit', (source) => {
    const { instance, directory, value } = fixture(source)
    writeFileSync(join(directory, 'main.mjs'), 'export default { changed: true }')
    writePlugin(directory, { ...value, version: '2.0.0' })
    instance.discover()
    expect(instance.get(value.id)).toMatchObject({
      enabled: true,
      permissionsGranted: ['sessions.read']
    })
  })
  it.each(['git', 'bundled', 'link'] as const)(
    'revokes grants on %s permission growth',
    (source) => {
      const { directory, value } = fixture(source)
      writePlugin(directory, { ...value, permissions: ['sessions.read', 'shell'] })
      const restarted = store()
      restarted.discover()
      expect(restarted.get(value.id)).toMatchObject({
        enabled: false,
        permissionsGranted: [],
        needsReview: 'permission-growth'
      })
    }
  )
  it('keeps consent on permission reduction but reviews regrowth', () => {
    const { instance, directory, value } = fixture('git')
    writePlugin(directory, { ...value, permissions: [] })
    instance.discover()
    expect(instance.get(value.id)).toMatchObject({
      enabled: true,
      permissionsGranted: []
    })
    expect(
      JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))[0].permissionsGranted
    ).toEqual([])
    writePlugin(directory, value)
    instance.discover()
    expect(instance.get(value.id)).toMatchObject({
      enabled: false,
      permissionsGranted: [],
      needsReview: 'permission-growth'
    })
  })
  it('preserves the saved record across a trailing comma and repair, even after restart', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance, directory, value } = fixture('git')
    const before = readFileSync(join(root, 'installed.json'), 'utf8')
    writeFileSync(join(directory, 'clave-plugin.json'), JSON.stringify(value).replace(/}$/, ',}'))
    instance.discover()
    expect(instance.get(value.id).status).toBe('error')
    expect(readFileSync(join(root, 'installed.json'), 'utf8')).toBe(before)
    const restarted = store()
    restarted.discover()
    writePlugin(directory, value)
    restarted.discover()
    expect(restarted.get(value.id)).toMatchObject({
      enabled: true,
      permissionsGranted: ['sessions.read']
    })
  })
  it('requires review after a git directory is swapped for a link while closed', () => {
    const { directory, value } = fixture('git')
    rmSync(directory, { recursive: true })
    const replacement = join(temporary, 'replacement')
    writePlugin(replacement, value)
    writeFileSync(join(replacement, 'main.mjs'), 'export default { replaced: true }')
    symlinkSync(replacement, directory)
    const restarted = store()
    restarted.discover()
    expect(restarted.get(value.id)).toMatchObject({
      source: 'link',
      enabled: false,
      needsReview: 'source-change',
      permissionsGranted: ['sessions.read']
    })
    restarted.discover()
    expect(restarted.get(value.id).needsReview).toBe('source-change')
  })
  it.each(['helper.mjs', 'ui/app.js'])('seals secondary file %s', (entry) => {
    const { instance, directory, value } = fixture('git')
    mkdirSync(join(directory, 'ui'))
    writeFileSync(join(directory, entry), 'original')
    instance.discover()
    instance.enable(value.id, value.permissions!)
    writeFileSync(join(directory, entry), 'replacement')
    const restarted = store()
    restarted.discover()
    expect(restarted.get(value.id)).toMatchObject({ enabled: false, needsReview: 'digest-change' })
  })
  it('rejects an escaping symlink outside the entry points', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { directory, value } = fixture('git')
    writeFileSync(join(temporary, 'outside'), 'outside')
    symlinkSync(join(temporary, 'outside'), join(directory, 'asset'))
    const restarted = store()
    restarted.discover()
    expect(restarted.get(value.id)).toMatchObject({ status: 'error' })
    expect(restarted.get(value.id).manifest).toBeUndefined()
  })
  it('excludes dependency trees and git metadata', () => {
    const { instance, directory, value } = fixture('git')
    for (const name of ['node_modules', '.git']) {
      mkdirSync(join(directory, name))
      writeFileSync(join(directory, name, 'file'), 'unsealed')
    }
    instance.discover()
    expect(instance.get(value.id)).toMatchObject({ enabled: true })
  })
  it('seals an internal link target even when both targets are already hashed', () => {
    const { instance, directory, value } = fixture('git')
    writeFileSync(join(directory, 'other.mjs'), 'export default {}')
    const link = join(directory, 'alias.mjs')
    symlinkSync('main.mjs', link)
    instance.discover()
    instance.enable(value.id, value.permissions!)
    const before = instance.get(value.id)
    unlinkSync(link)
    symlinkSync('other.mjs', link)
    instance.discover()
    const after = instance.get(value.id)
    expect(after.contentDigest).not.toBe(before.contentDigest)
    expect(after.reviewDigest).not.toBe(before.reviewDigest)
    expect(after).toMatchObject({ enabled: false, needsReview: 'digest-change' })
  })
  it('seals executable mode changes', () => {
    const { instance, directory, value } = fixture('git')
    const helper = join(directory, 'helper.sh')
    writeFileSync(helper, '#!/bin/sh\necho helper\n', { mode: 0o644 })
    instance.discover()
    instance.enable(value.id, value.permissions!)
    const before = instance.get(value.id)
    chmodSync(helper, 0o755)
    instance.discover()
    const after = instance.get(value.id)
    expect(after.contentDigest).not.toBe(before.contentDigest)
    expect(after.reviewDigest).not.toBe(before.reviewDigest)
    expect(after).toMatchObject({ enabled: false, needsReview: 'digest-change' })
  })
  it.each(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])('seals root %s', (name) => {
    const { instance, directory, value } = fixture('git')
    writeFileSync(join(directory, name), 'original lock')
    instance.discover()
    instance.enable(value.id, value.permissions!)
    const before = instance.get(value.id)
    writeFileSync(join(directory, name), 'changed lock')
    instance.discover()
    const after = instance.get(value.id)
    expect(after.contentDigest).not.toBe(before.contentDigest)
    expect(after.reviewDigest).not.toBe(before.reviewDigest)
    expect(after).toMatchObject({ enabled: false, needsReview: 'digest-change' })
  })
  it.each([true, false])(
    'restores pre-refusal enabled=%s after repeated refusals and upgrade',
    (enabled) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { instance, value } = fixture('git')
      if (!enabled) instance.disable(value.id)
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = new PluginStore(root, bundled, '0.0.1')
        refused.discover()
        expect(refused.get(value.id)).toMatchObject({
          enabled: false,
          needsReview: 'engine-refusal',
          enabledBeforeEngineRefusal: enabled
        })
        expect(
          JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'))[0]
            .enabledBeforeEngineRefusal
        ).toBe(enabled)
      }
      const upgraded = store()
      upgraded.discover()
      expect(upgraded.get(value.id).enabled).toBe(enabled)
      expect(upgraded.get(value.id).needsReview).toBeUndefined()
      expect(upgraded.get(value.id).enabledBeforeEngineRefusal).toBeUndefined()
    }
  )
  it('keeps digest review through engine refusal and recovery', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance, directory, value } = fixture('git')
    writeFileSync(join(directory, 'main.mjs'), 'replacement')
    instance.discover()
    const incompatible = new PluginStore(root, bundled, '0.0.1')
    incompatible.discover()
    expect(incompatible.get(value.id).needsReview).toBe('digest-change')
    const compatible = store()
    compatible.discover()
    expect(compatible.get(value.id)).toMatchObject({ enabled: false, needsReview: 'digest-change' })
  })
  it('clears engine refusal when the app now meets the range', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance, directory, value } = fixture('link')
    writePlugin(directory, { ...value, engines: { clave: '>=2' } })
    instance.discover()
    expect(instance.get(value.id).needsReview).toBe('engine-refusal')
    const upgraded = new PluginStore(root, bundled, '2.0.0')
    upgraded.discover()
    expect(upgraded.get(value.id).needsReview).toBeUndefined()
    expect(upgraded.get(value.id).error).toBeUndefined()
    expect(upgraded.get(value.id).enabled).toBe(true)
  })
  it('distinguishes a deliberate disable from engine refusal', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance, directory, value } = fixture('link')
    instance.disable(value.id)
    instance.discover()
    expect(instance.get(value.id).needsReview).toBeUndefined()
    writePlugin(directory, { ...value, engines: { clave: '>=999' } })
    instance.discover()
    expect(instance.get(value.id)).toMatchObject({ enabled: false, needsReview: 'engine-refusal' })
  })
})

it('includes the surface entry in replacement detection', () => {
  const instance = store()
  const directory = join(root, 'plugins', 'surface')
  writePlugin(directory, { ...manifest(), ui: 'surface' })
  mkdirSync(join(directory, 'ui'))
  writeFileSync(join(directory, 'ui', 'index.html'), '<p>Original</p>')
  instance.discover()
  instance.enable('example.plugin', ['sessions.read'])
  const before = instance.get('example.plugin').contentDigest
  writeFileSync(join(directory, 'ui', 'index.html'), '<p>Replacement</p>')
  const restarted = store()
  restarted.discover()
  expect(restarted.get('example.plugin')).toMatchObject({
    enabled: false,
    needsReview: 'digest-change',
    permissionsGranted: ['sessions.read']
  })
  expect(restarted.get('example.plugin').contentDigest).not.toBe(before)
})

it('includes same-version manifest changes in replacement detection', () => {
  const instance = store()
  const directory = join(root, 'plugins', 'example')
  writePlugin(directory)
  instance.discover()
  instance.enable('example.plugin', ['sessions.read'])
  writePlugin(directory, { ...manifest(), name: 'Replacement' })
  const restarted = store()
  restarted.discover()
  expect(restarted.get('example.plugin')).toMatchObject({
    enabled: false,
    needsReview: 'digest-change',
    permissionsGranted: ['sessions.read']
  })
})
