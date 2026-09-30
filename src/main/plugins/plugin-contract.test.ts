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
    toolbar: [
      { id: 'command', title: 'Action', icon: 'SparklesIcon', kind: 'action' },
      {
        id: 'menu',
        title: 'Menu',
        icon: 'HandRaisedIcon',
        kind: 'popover',
        items: [{ id: 'command', title: 'Command' }]
      }
    ],
    views: [{ id: 'view', renders: ['pty', 'events'] }],
    adapters: [
      {
        id: 'adapter',
        name: 'Example provider',
        entry: 'dist/provider.cjs',
        command: ['example-cli', '--stdio'],
        capabilities: { permissions: true, questions: false, resume: true, notice: 'Local only.' }
      }
    ]
  },
  permissions: ['sessions.read', 'sessions.write']
}

/** The same manifest with one field of its single adapter contribution replaced. */
const adapterManifest = (
  patch: Record<string, unknown>
): ReturnType<typeof pluginManifestSchema.safeParse> =>
  pluginManifestSchema.safeParse({
    ...input,
    contributes: {
      ...input.contributes,
      adapters: [{ ...input.contributes.adapters[0], ...patch }]
    }
  })

describe('plugin manifest v1', () => {
  it('accepts every contribution kind and the surface entry without losing fields', () => {
    expect(pluginManifestSchema.parse(input)).toEqual(input)
  })
  it('carries a view title when a manifest gives one, and stays valid without it', () => {
    const titled = {
      ...input,
      contributes: {
        ...input.contributes,
        views: [
          { id: 'chat', title: 'Chat', renders: ['events'] },
          { id: 'compact', title: 'Compact', renders: ['events'] }
        ]
      }
    }
    expect(pluginManifestSchema.parse(titled).contributes.views).toEqual(titled.contributes.views)
    // The picker falls back to the id, so a manifest written before titles
    // existed still loads rather than failing the whole plugin.
    expect(pluginManifestSchema.parse(input).contributes.views[0].title).toBeUndefined()
    expect(() =>
      pluginManifestSchema.parse({
        ...input,
        contributes: {
          ...input.contributes,
          views: [{ id: 'chat', title: '  ', renders: ['events'] }]
        }
      })
    ).toThrow()
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
    { ...input, id: 'undotted' },
    // sidebarSections was declared and never read; it is gone, and a manifest still
    // carrying it now fails rather than passing validation with a dead field.
    { ...input, contributes: { ...input.contributes, sidebarSections: [{ id: 's', title: 'S' }] } }
  ])('rejects unknown fields and invalid contract values %#', (manifest) => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false)
  })
  it.each(['../main.cjs', '/main.cjs', 'C:\\main.cjs', 'dist/../../main.cjs', 'dist//main.cjs'])(
    'rejects unsafe entry %s',
    (main) => {
      expect(pluginManifestSchema.safeParse({ ...input, main }).success).toBe(false)
    }
  )
  it.each([{ id: 'pty' }, { id: 'echo' }, { id: 'claude-chat' }, { id: 'codex-chat' }])(
    'rejects the built-in adapter id %o',
    (patch) => {
      expect(adapterManifest(patch).success).toBe(false)
    }
  )
  it.each(['../provider.cjs', '/provider.cjs', 'dist/../../provider.cjs', 'C:\\provider.cjs'])(
    'rejects a traversing adapter entry %s',
    (entry) => {
      expect(adapterManifest({ entry }).success).toBe(false)
    }
  )
  it.each(['provider.js', 'provider.mjs', 'provider'])(
    'rejects an adapter entry that is not built CommonJS: %s',
    (entry) => {
      expect(adapterManifest({ entry }).success).toBe(false)
    }
  )
  it.each([
    { command: [] },
    { command: ['ok', 'bad\u0000arg'] },
    { capabilities: { permissions: true, questions: false } },
    { capabilities: { permissions: true, questions: false, resume: false, unexpected: true } },
    { unexpected: true }
  ])('rejects an invalid adapter contribution %#', (patch) => {
    expect(adapterManifest(patch).success).toBe(false)
  })
  it('refuses an adapter contribution without the sessions.write permission', () => {
    expect(
      pluginManifestSchema.safeParse({ ...input, permissions: ['sessions.read'] }).success
    ).toBe(false)
    expect(
      pluginManifestSchema.safeParse({ ...input, permissions: ['sessions.write'] }).success
    ).toBe(true)
  })
  it('rejects two adapters sharing an id inside one manifest', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: {
          ...input.contributes,
          adapters: [input.contributes.adapters[0], input.contributes.adapters[0]]
        }
      }).success
    ).toBe(false)
  })
  it('rejects duplicate contribution IDs', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: { panels: [input.contributes.panels[0], input.contributes.panels[0]] }
      }).success
    ).toBe(false)
  })
  it.each([
    // A popover with nothing in it is a button that opens an empty surface.
    [{ id: 'menu', title: 'Menu', icon: 'SparklesIcon', kind: 'popover' }],
    [{ id: 'menu', title: 'Menu', icon: 'SparklesIcon', kind: 'popover', items: [] }],
    // items belong to a popover: an action runs one command and opens nothing.
    [
      {
        id: 'command',
        title: 'Action',
        icon: 'SparklesIcon',
        kind: 'action',
        items: [{ id: 'command', title: 'Command' }]
      }
    ],
    // A toolbar entry names the command it runs; an undeclared one runs nothing, and the
    // host would refuse it silently at click time.
    [{ id: 'absent', title: 'Action', icon: 'SparklesIcon', kind: 'action' }],
    [
      {
        id: 'menu',
        title: 'Menu',
        icon: 'SparklesIcon',
        kind: 'popover',
        items: [{ id: 'absent', title: 'Absent' }]
      }
    ],
    // Duplicate item ids inside one popover.
    [
      {
        id: 'menu',
        title: 'Menu',
        icon: 'SparklesIcon',
        kind: 'popover',
        items: [
          { id: 'command', title: 'Command' },
          { id: 'command', title: 'Command again' }
        ]
      }
    ],
    // The icon follows the app's own convention: a Heroicon export name.
    [{ id: 'command', title: 'Action', icon: 'sparkles', kind: 'action' }],
    [{ id: 'command', title: 'Action', icon: 'SparklesIcon', kind: 'menu' }],
    [{ id: 'command', title: 'Action', icon: 'SparklesIcon', kind: 'action', unexpected: true }]
  ])('rejects an invalid toolbar contribution %#', (entry) => {
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: { ...input.contributes, toolbar: [entry] }
      }).success
    ).toBe(false)
  })
  it('accepts a popover whose own id names no command, since only its items run', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: {
          ...input.contributes,
          toolbar: [
            {
              id: 'not-a-command',
              title: 'Menu',
              icon: 'SparklesIcon',
              kind: 'popover',
              items: [{ id: 'command', title: 'Command' }]
            }
          ]
        }
      }).success
    ).toBe(true)
  })
  it('rejects duplicate toolbar ids', () => {
    const entry = { id: 'command', title: 'Action', icon: 'SparklesIcon', kind: 'action' }
    expect(
      pluginManifestSchema.safeParse({
        ...input,
        contributes: { ...input.contributes, toolbar: [entry, entry] }
      }).success
    ).toBe(false)
  })
  it('compares the host version with the declared engine range', () => {
    const manifest = pluginManifestSchema.parse(input)
    expect(isEngineCompatible(manifest, '1.90.2')).toBe(true)
    expect(isEngineCompatible(manifest, '2.0.0')).toBe(false)
    // A pre-release of a version in range is in range (a plain semver range
    // would exclude every pre-release). The cap still holds: `<2` desugars
    // to `<2.0.0-0`, so the betas of the next major are out with it.
    expect(isEngineCompatible(manifest, '1.92.0-beta.1')).toBe(true)
    expect(isEngineCompatible(manifest, '2.0.0-beta.1')).toBe(false)
    expect(isEngineCompatible(manifest, '1.89.9')).toBe(false)
    expect(isEngineCompatible(manifest, 'not-a-version')).toBe(false)
  })
})

describe('plugin host permission boundary', () => {
  // Read-only on purpose: this block is about a permission the manifest never
  // declared, so it drops the adapter contribution and the sessions.write it needs.
  const manifest = pluginManifestSchema.parse({
    ...input,
    contributes: { ...input.contributes, adapters: [] },
    permissions: ['sessions.read']
  })
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
    // A toolbar registration is guarded exactly like a panel: the id must be one this
    // manifest declared, and a popover item id is not one of them — items are commands.
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerToolbar', { id: 'menu' })
    ).not.toThrow()
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerToolbar', { id: 'command' })
    ).not.toThrow()
    expect(() =>
      assertMethodPermission(manifest, [], 'ui.registerToolbar', { id: 'other' })
    ).toThrow('Undeclared contribution')
    expect(() => assertMethodPermission(manifest, [], 'ui.registerToolbar', {})).toThrow(
      'Undeclared contribution'
    )
    // The focused session is session data: the same grant governs it.
    expect(() => assertMethodPermission(manifest, [], 'sessions.focused')).toThrow(
      PluginPermissionError
    )
    expect(() =>
      assertMethodPermission(manifest, ['sessions.read'], 'sessions.focused')
    ).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'notify')).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'log')).not.toThrow()
    expect(() => assertMethodPermission(manifest, [], 'shell.exec')).toThrow(
      'Unknown plugin method'
    )
  })
})
