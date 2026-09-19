import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
import { PluginStore, pluginFile } from './plugin-store'
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
        installedAt: discovered.installedAt
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

it('keeps declaration and grants independent for bundled plugins', () => {
  writePlugin(join(bundled, 'example'))
  const instance = store()
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
  'revokes grants when a folder is replaced under the same id (missing discovery: %s)',
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
      permissionsGranted: []
    })
  }
)
