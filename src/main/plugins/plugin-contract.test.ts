import { describe, expect, it } from 'vitest'
import {
  assertMethodPermission,
  isEngineCompatible,
  PluginPermissionError,
  pluginManifestSchema
} from '@clave/plugin-sdk'

const input = {
  id: 'example.contract',
  name: 'Contract',
  version: '1.0.0',
  kind: 'plugin',
  engines: { clave: '>=1.90.0 <2' },
  ui: 'surface',
  main: 'dist/main.cjs',
  uiEntry: 'ui/index.html',
  contributes: {
    panels: [{ id: 'panel', title: 'Panel', icon: 'SparklesIcon', placement: 'side' }],
    commands: [{ id: 'command', title: 'Command', keybinding: 'Mod+K' }],
    sidebarSections: [{ id: 'section', title: 'Section' }],
    views: [{ id: 'view', renders: ['pty', 'events'] }],
    adapters: [{ id: 'adapter', provider: 'example' }]
  },
  permissions: ['sessions.read']
}

describe('plugin manifest v1', () => {
  it('accepts every contribution kind and the surface entry without losing fields', () => {
    expect(pluginManifestSchema.parse(input)).toEqual(input)
  })
  it.each([
    { ...input, unexpected: true },
    { ...input, engines: { ...input.engines, unexpected: true } },
    { ...input, contributes: { ...input.contributes, unexpected: [] } },
    {
      ...input,
      contributes: {
        ...input.contributes,
        panels: [{ ...input.contributes.panels[0], unexpected: true }]
      }
    },
    { ...input, permissions: ['sessions.delete'] },
    { ...input, kind: 'extension' },
    { ...input, version: '1.0.0+build' },
    { ...input, version: '1.0' },
    { ...input, version: 'v1.0.0' },
    { ...input, engines: { clave: 'yesterday' } },
    { ...input, id: 'undotted' }
  ])('rejects unknown fields and invalid contract values %#', (manifest) => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false)
  })
  it.each(['../main.cjs', '/main.cjs', 'C:\\main.cjs', 'dist/../../main.cjs', 'dist//main.cjs'])(
    'rejects unsafe entry %s',
    (main) => {
      expect(pluginManifestSchema.safeParse({ ...input, main }).success).toBe(false)
    }
  )
  it('rejects duplicate contribution IDs', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: { panels: [input.contributes.panels[0], input.contributes.panels[0]] }
      }).success
    ).toBe(false)
  })
  it('compares the host version with the declared engine range', () => {
    const manifest = pluginManifestSchema.parse(input)
    expect(isEngineCompatible(manifest, '1.90.2')).toBe(true)
    expect(isEngineCompatible(manifest, '2.0.0')).toBe(false)
    expect(isEngineCompatible(manifest, '1.89.9')).toBe(false)
    expect(isEngineCompatible(manifest, 'not-a-version')).toBe(false)
  })
})

describe('plugin host permission boundary', () => {
  const manifest = pluginManifestSchema.parse(input)
  it('refuses sessions.send with a typed error without sessions.write', () => {
    try {
      assertMethodPermission(manifest, ['sessions.read'], 'sessions.send', {
        id: 'session',
        text: 'run'
      })
      expect.unreachable('A read-only plugin sent terminal input')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPermissionError)
      expect(error).toMatchObject({
        code: -32001,
        permission: 'sessions.write',
        data: { permission: 'sessions.write' }
      })
    }
  })
  it('does not accept a claimed grant missing from the manifest', () => {
    expect(() => assertMethodPermission(manifest, ['sessions.write'], 'sessions.send')).toThrow(
      PluginPermissionError
    )
  })
  it('does not accept a declaration the user has not granted', () => {
    expect(() => assertMethodPermission(manifest, [], 'sessions.list')).toThrow(
      PluginPermissionError
    )
  })
  it('allows a declared and granted read and guards all privileged methods', () => {
    expect(() => assertMethodPermission(manifest, ['sessions.read'], 'sessions.list')).not.toThrow()
    for (const method of [
      'sessions.get',
      'sessions.subscribe',
      'sessions.unsubscribe',
      'secrets.request'
    ]) {
      expect(() => assertMethodPermission(manifest, [], method)).toThrow(PluginPermissionError)
    }
  })
  it('allows only declared UI contributions and known baseline APIs', () => {
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerPanel', { id: 'panel' })
    ).not.toThrow()
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerCommand', { id: 'command' })
    ).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'ui.registerPanel', { id: 'other' })).toThrow(
      'Undeclared contribution'
    )
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerCommand', { id: 'other' })
    ).toThrow('Undeclared contribution')
    expect(() => assertMethodPermission(manifest, [], 'notify')).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'log')).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'shell.exec')).toThrow(
      'Unknown plugin method'
    )
  })
})
